#!/usr/bin/env node
/**
 * spawn-parser.js
 * Parses the current Claude Code session JSONL into a clean conversation text.
 * Delta-aware: only captures turns since the last compaction boundary.
 * Tool calls collapsed to one-line summaries. Thinking blocks stripped.
 *
 * Commands:
 *   node spawn-parser.js parse          → clean markdown conversation to stdout
 *   node spawn-parser.js count          → turn count (integer) to stdout
 *   node spawn-parser.js session-id     → current session UUID to stdout
 *   node spawn-parser.js session-path   → full path to current JSONL
 *   node spawn-parser.js meta           → JSON blob: sessionId, project, turns, cwd
 */

const fs   = require('fs');
const path = require('path');

// ─── Locate current session ───────────────────────────────────────────────────

function findCurrentSession() {
  const projectsDir = path.join(process.env.HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let newest = null;
  let newestTime = 0;

  for (const project of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, project);
    try {
      if (!fs.statSync(projectPath).isDirectory()) continue;
    } catch { continue; }

    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectPath, file);
      try {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime > newestTime) {
          newestTime = mtime;
          newest = filePath;
        }
      } catch { continue; }
    }
  }
  return newest;
}

// ─── Parse JSONL ──────────────────────────────────────────────────────────────

function parseConversation(jsonlPath, options = {}) {
  const { maxTurns = 150 } = options;

  const raw = fs.readFileSync(jsonlPath, 'utf8').trim();
  if (!raw) return { sessionId: '', projectSlug: '', totalTurns: 0, deltaStart: 0, turns: [], cwd: '' };

  const lines = raw.split('\n');
  const turns = [];
  let compactionIndex = -1;
  let sessionId   = path.basename(jsonlPath, '.jsonl');
  let projectSlug = path.basename(path.dirname(jsonlPath));
  let cwd         = '';

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line.trim()); } catch { continue; }

    // Grab cwd from first message that has it
    if (!cwd && obj.cwd) cwd = obj.cwd;

    // Skip sidechain (tool result injections)
    if (obj.isSidechain) continue;

    const role    = obj.message?.role;
    const content = obj.message?.content;
    const ts      = obj.timestamp || '';

    if (!role || content === undefined || content === null) continue;

    // ── User turn ────────────────────────────────────────────────────────────
    if (role === 'user') {
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }

      // Detect compaction summary injected by Claude Code
      const trimmed = text.trim();
      if (
        trimmed.startsWith('<summary>') ||
        trimmed.includes('This session was compacted') ||
        trimmed.includes('<context_window_compaction>') ||
        (trimmed.length > 500 && trimmed.startsWith('[Previous conversation summary'))
      ) {
        compactionIndex = turns.length;
        continue;
      }

      if (trimmed) {
        turns.push({ role: 'user', text: trimmed, ts });
      }

    // ── Assistant turn ───────────────────────────────────────────────────────
    } else if (role === 'assistant') {
      const blocks = Array.isArray(content)
        ? content
        : [{ type: 'text', text: String(content) }];

      const parts = [];

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            if (block.text?.trim()) parts.push(block.text.trim());
            break;

          case 'tool_use': {
            // Collapse to one readable line
            const name  = block.name || 'tool';
            const input = block.input || {};
            let detail  = '';
            if (input.command)     detail = input.command.replace(/\s+/g, ' ').substring(0, 80);
            else if (input.file_path) detail = path.basename(input.file_path);
            else if (input.description) detail = input.description.substring(0, 80);
            else if (input.old_string)  detail = `edit ${path.basename(input.file_path || '?')}`;
            parts.push(`[→ ${name}${detail ? ': ' + detail : ''}]`);
            break;
          }

          case 'thinking':
            // Strip — internal reasoning, not meaningful to new session
            break;

          default:
            // tool_result, image, etc — skip
            break;
        }
      }

      if (parts.length > 0) {
        turns.push({ role: 'assistant', text: parts.join('\n'), ts });
      }
    }
  }

  // Delta: only turns after the last compaction marker
  const startIndex = compactionIndex >= 0 ? compactionIndex + 1 : 0;
  const delta      = turns.slice(startIndex);
  const recent     = delta.slice(-maxTurns);

  return {
    sessionId,
    projectSlug,
    totalTurns: turns.length,
    deltaStart: startIndex,
    turns: recent,
    cwd,
    jsonlPath,
  };
}

// ─── Markdown formatter ───────────────────────────────────────────────────────

function formatAsMarkdown(parsed) {
  const now = new Date().toISOString();
  const lines = [
    `# Spawn Recovery — ${now}`,
    `**Session ID:** \`${parsed.sessionId}\``,
    `**Project:**    ${parsed.projectSlug}`,
    `**Working dir:** ${parsed.cwd || 'unknown'}`,
    `**Turns captured:** ${parsed.turns.length} (of ${parsed.totalTurns} total, delta from turn ${parsed.deltaStart})`,
    '',
    '> This file is a reference only. The new session reads spawn-packet.md via',
    '> --append-system-prompt. Read this ONLY if spawn-packet.md lacks context you need.',
    '> Delete after use.',
    '',
    '---',
    '',
  ];

  for (const turn of parsed.turns) {
    const time = turn.ts ? new Date(turn.ts).toLocaleTimeString() : '';
    lines.push(`**${turn.role.toUpperCase()}**${time ? ' [' + time + ']' : ''}`);
    lines.push('');
    lines.push(turn.text);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Turn counter (for advisor hook) ─────────────────────────────────────────

function countUserTurns(jsonlPath) {
  const raw = fs.readFileSync(jsonlPath, 'utf8').trim();
  if (!raw) return 0;
  let count = 0;
  for (const line of raw.split('\n')) {
    try {
      const obj = JSON.parse(line);
      if (obj.message?.role === 'user' && !obj.isSidechain) count++;
    } catch {}
  }
  return count;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

// Handle pipe truncation gracefully (e.g. piped to `head`)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const [,, command] = process.argv;

switch (command) {

  case 'parse': {
    const jsonlPath = findCurrentSession();
    if (!jsonlPath) { console.error('No active session found.'); process.exit(1); }
    const parsed = parseConversation(jsonlPath);
    process.stdout.write(formatAsMarkdown(parsed));
    break;
  }

  case 'count': {
    const jsonlPath = findCurrentSession();
    if (!jsonlPath) { console.log('0'); break; }
    console.log(countUserTurns(jsonlPath));
    break;
  }

  case 'session-id': {
    const jsonlPath = findCurrentSession();
    if (!jsonlPath) { console.error('No active session found.'); process.exit(1); }
    console.log(path.basename(jsonlPath, '.jsonl'));
    break;
  }

  case 'session-path': {
    const jsonlPath = findCurrentSession();
    if (jsonlPath) console.log(jsonlPath);
    break;
  }

  case 'meta': {
    const jsonlPath = findCurrentSession();
    if (!jsonlPath) { console.log('{}'); break; }
    const parsed = parseConversation(jsonlPath, { maxTurns: 1 }); // fast — just metadata
    console.log(JSON.stringify({
      sessionId:   parsed.sessionId,
      projectSlug: parsed.projectSlug,
      cwd:         parsed.cwd,
      totalTurns:  parsed.totalTurns,
      jsonlPath:   jsonlPath,
    }, null, 2));
    break;
  }

  default:
    console.error('Usage: spawn-parser.js [parse|count|session-id|session-path|meta]');
    process.exit(1);
}
