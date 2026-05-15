#!/usr/bin/env node
/**
 * spawn-advisor.js
 * Runs as a UserPromptSubmit hook. Reads exact token usage from the current
 * session JSONL and manages spawn advisories + auto-trigger behavior.
 *
 * DETERMINISTIC: Compaction fires at a threshold, not randomly. Token usage
 * is logged by Claude Code in every assistant message in the JSONL under
 * message.usage. We read it directly — no heuristics.
 *
 * Thresholds (override via env or settings):
 *   SPAWN_WARN_PCT      default 70  → advisory (⚠️)
 *   SPAWN_URGENT_PCT    default 82  → urgent (🚨)
 *   SPAWN_CRITICAL_PCT  default 88  → auto-trigger (🔴)
 *
 * Auto-trigger behavior at CRITICAL:
 *   1. Auto-saves raw recovery file to ~/.claude/SPAWN/active/ (shell, instant)
 *   2. Injects synthesis instruction into context so Claude runs /spawn
 *      before responding to whatever the user sent
 *
 * Auto mode (SPAWN_AUTO_MODE env var):
 *   a → auto: after synthesis, auto-open new terminal window with launch command
 *   p → prompt: after synthesis, display launch command for user to copy (default)
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WARN_PCT      = parseFloat(process.env.SPAWN_WARN_PCT     || '70');
const URGENT_PCT    = parseFloat(process.env.SPAWN_URGENT_PCT   || '82');
const CRITICAL_PCT  = parseFloat(process.env.SPAWN_CRITICAL_PCT || '88');
const AUTO_MODE     = (process.env.SPAWN_AUTO_MODE || 'p').toLowerCase(); // 'a' or 'p'
const DEFAULT_CTX   = parseInt(process.env.SPAWN_CONTEXT_WINDOW || '200000', 10);

const SPAWN_DIR     = path.join(process.env.HOME, '.claude', 'SPAWN', 'active');

// ─── Find current session ─────────────────────────────────────────────────────

function findCurrentSession() {
  const projectsDir = path.join(process.env.HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let newest = null;
  let newestTime = 0;

  for (const project of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, project);
    try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }

    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectPath, file);
      try {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime > newestTime) { newestTime = mtime; newest = filePath; }
      } catch { continue; }
    }
  }
  return newest;
}

// ─── Get latest token usage ───────────────────────────────────────────────────

function getLatestUsage(jsonlPath) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj   = JSON.parse(lines[i]);
        const msg   = obj.message || {};
        const usage = msg.usage;
        if (usage && msg.role === 'assistant') {
          return {
            model:       msg.model || null,
            inputTokens: usage.input_tokens                || 0,
            cacheRead:   usage.cache_read_input_tokens     || 0,
            cacheCreate: usage.cache_creation_input_tokens || 0,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ─── Fallback: turn count ─────────────────────────────────────────────────────

function countUserTurns(jsonlPath) {
  try {
    let count = 0;
    for (const line of fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')) {
      try {
        const obj = JSON.parse(line);
        if (obj.message?.role === 'user' && !obj.isSidechain) count++;
      } catch {}
    }
    return count;
  } catch { return 0; }
}

// ─── Session ID from JSONL path ───────────────────────────────────────────────

function getSessionId(jsonlPath) {
  return path.basename(jsonlPath, '.jsonl');
}

// ─── Check for active packet (session-scoped) ─────────────────────────────────

function hasActivePacket(sessionId) {
  if (!fs.existsSync(SPAWN_DIR)) return false;
  return fs.readdirSync(SPAWN_DIR).some(f => f.startsWith(`spawn-packet-${sessionId}-`));
}

function getLatestPacketPath(sessionId) {
  if (!fs.existsSync(SPAWN_DIR)) return null;
  const packets = fs.readdirSync(SPAWN_DIR)
    .filter(f => f.startsWith(`spawn-packet-${sessionId}-`))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(SPAWN_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return packets.length ? path.join(SPAWN_DIR, packets[0].name) : null;
}

// ─── Auto-save recovery file (shell-only, no Claude needed) ──────────────────

function autoSaveRecovery(sessionId, timestamp) {
  const recoveryPath = path.join(SPAWN_DIR, `spawnrecovery-${sessionId}-${timestamp}.md`);

  // Skip if already saved this threshold crossing
  if (fs.existsSync(recoveryPath)) return recoveryPath;

  try {
    if (!fs.existsSync(SPAWN_DIR)) fs.mkdirSync(SPAWN_DIR, { recursive: true });
    const parserPath = path.join(__dirname, 'spawn-parser.js');
    execSync(`node "${parserPath}" parse > "${recoveryPath}"`, { timeout: 15000 });
    return recoveryPath;
  } catch (e) {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const jsonlPath = findCurrentSession();
if (!jsonlPath) process.exit(0);

const sessionId = getSessionId(jsonlPath);
const usage = getLatestUsage(jsonlPath);

if (usage) {
  const contextWindow = DEFAULT_CTX;
  const totalContext  = usage.inputTokens + usage.cacheRead + usage.cacheCreate;
  const pct           = (totalContext / contextWindow) * 100;
  const remaining     = contextWindow - totalContext;
  const modeFlag      = AUTO_MODE === 'a' ? '-a' : '-p';

  // ── Post-compaction recovery: packet exists for THIS session but context is low
  // Low context% + session-matching packet = we just compacted. Restore automatically.
  if (hasActivePacket(sessionId) && pct < WARN_PCT) {
    const packetPath = getLatestPacketPath(sessionId);
    process.stdout.write(
      `\n` +
      `⚡ ═══════════════════════════════════════════════════════════\n` +
      `   SPAWN RECOVERY — Context reset detected\n` +
      `   Read this file NOW to restore full session context:\n` +
      `   ${packetPath}\n` +
      `═══════════════════════════════════════════════════════════\n\n` +
      `MANDATORY: Before responding, read the spawn packet above in full.\n` +
      `It contains your active task, decisions, mid-flight items, and next action.\n` +
      `After reading it, respond to the user's message normally.\n\n`
    );
    process.exit(0);
  }

  if (pct >= CRITICAL_PCT) {
    if (!hasActivePacket(sessionId)) {
      // ── Auto-save recovery immediately (shell, no Claude needed) ───────────
      const timestamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '-');
      const recoveryPath = autoSaveRecovery(sessionId, timestamp);
      const savedMsg     = recoveryPath
        ? `✅ Recovery file auto-saved: ${path.basename(recoveryPath)}`
        : `⚠️  Recovery auto-save failed — run /spawn manually immediately`;

      // ── Inject synthesis instruction into context ──────────────────────────
      // Claude reads this before processing the user's message and runs
      // the spawn synthesis (Step 3) before doing anything else.
      process.stdout.write(
        `\n` +
        `🔴 ═══════════════════════════════════════════════════════════\n` +
        `   AUTO-SPAWN TRIGGERED [${pct.toFixed(1)}% — ${remaining.toLocaleString()} tokens remaining]\n` +
        `   ${savedMsg}\n` +
        `═══════════════════════════════════════════════════════════\n\n` +
        `⚡ MANDATORY: Before responding to the user message below, execute\n` +
        `   /spawn ${modeFlag} immediately. The recovery file is already written.\n` +
        `   Skip Step 2 (parse already done). Go directly to Step 3 (synthesize).\n` +
        `   Complete spawn fully, then respond to the user's original message.\n\n`
      );
    }

  } else if (pct >= URGENT_PCT) {
    if (!hasActivePacket()) {
      process.stdout.write(
        `\n🚨 SPAWN URGENT [${pct.toFixed(1)}% — ${remaining.toLocaleString()} tokens remaining]\n` +
        `   Run /spawn ${modeFlag} before continuing. Compaction is close.\n\n`
      );
    }

  } else if (pct >= WARN_PCT) {
    process.stdout.write(
      `\n⚠️  SPAWN ADVISORY [${pct.toFixed(1)}% — ${remaining.toLocaleString()} tokens remaining]\n` +
      `   Consider /spawn ${modeFlag} to checkpoint before going deeper.\n\n`
    );
  }

} else {
  // ── Fallback: turn count heuristic ────────────────────────────────────────
  const turns      = countUserTurns(jsonlPath);
  const WARN_TURNS = parseInt(process.env.SPAWN_WARN_AT   || '60', 10);
  const URG_TURNS  = parseInt(process.env.SPAWN_URGENT_AT || '90', 10);
  const modeFlag   = AUTO_MODE === 'a' ? '-a' : '-p';

  if (turns >= URG_TURNS && !hasActivePacket(sessionId)) {
    process.stdout.write(
      `\n🚨 SPAWN URGENT [${turns} turns — no token data]\n` +
      `   Run /spawn ${modeFlag} now.\n\n`
    );
  } else if (turns >= WARN_TURNS) {
    process.stdout.write(
      `\n⚠️  SPAWN ADVISORY [${turns} turns — no token data]\n` +
      `   Consider /spawn ${modeFlag} to checkpoint.\n\n`
    );
  }
}

process.exit(0);
