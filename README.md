# /spawn — Claude Code Session Continuity

Self-healing session continuity for Claude Code. When context compacts, the next
session restores automatically — no warmup, no re-explaining, no lost decisions.

**Designed by Kevin Stanley · Built with Claude (Anthropic)**

---

## The problem

Claude Code sessions compact when the context window fills (~200K tokens). When
that happens mid-task, mid-debate, or mid-incident, the session restarts with a
compressed summary that loses everything specific: the decisions you made, the
reasoning that got you here, the half-finished work you were in the middle of.

The result: 30–60 minutes of warmup per compaction. In a P0, that's unacceptable.

## The solution

`/spawn` writes a structured state packet before compaction. After compaction, the
session reads it automatically on your next message and picks up exactly where it
left off. **You just keep typing.**

---

## How it works

```
Normal session flow:

  You type → advisor hook fires → checks context % from JSONL token data
    │
    ├─ <70%    → nothing (green)
    ├─ 70–82%  → ⚠️  advisory: compaction is coming
    ├─ 82–88%  → 🚨 urgent: compaction is close, consider /spawn
    └─ 88%+    → 🔴 auto-trigger:
                   1. Recovery file saved instantly (shell, no Claude involvement)
                   2. Synthesis instruction injected → Claude writes state packet
                   3. Compaction fires (Claude Code handles automatically)

After compaction:

  You type anything → advisor hook fires → sees packet + low context %
    └─ Recovery instruction injected → Claude reads packet → responds normally
       Session is restored. You never noticed.
```

---

## What's in the packet

Claude synthesizes — doesn't dump. The packet contains:

| Field | What it captures |
|---|---|
| ACTIVE TASK | What's being built/debugged right now (one line) |
| DECISIONS MADE THIS SESSION | Uncommitted decisions not yet in any file |
| MID-FLIGHT ITEMS | Started-but-unfinished work with specific state |
| NEXT ACTION | Single clear directive for the restored session |
| CONTEXT THE NEW SESSION MUST KNOW | Session-only discoveries and constraints |
| READ PRIORITY | Files to load if needed (not preemptively) |

The packet is ~65 lines. It replaces 30–60 minutes of warmup.

---

## Commands

```
/spawn           Standard checkpoint. Full synthesis. ~150 lines.
/spawn -a        Checkpoint + auto-open new terminal window (branching to a new session)
/spawn -p        Checkpoint + display launch command to copy (default)
/spawn --micro   Quick save. <50 lines. Fast.
/spawn --p0      Active incident. Incident header first. No onboarding overhead.
```

Most users never need to run `/spawn` manually — the auto-trigger handles it.
Manual `/spawn` is for intentional checkpoints: before a major pivot, before
handing off to a colleague, before a planned break.

---

## Installation

### 1. Copy the skill

```bash
cp -r spawn/ ~/.claude/skills/spawn/
```

Or clone directly:
```bash
git clone https://github.com/kstanle3/claude-spawn ~/.claude/skills/spawn
```

### 2. Add hooks to `~/.claude/settings.json`

```json
{
  "env": {
    "SPAWN_AUTO_MODE": "p",
    "SPAWN_WARN_PCT": "70",
    "SPAWN_URGENT_PCT": "82",
    "SPAWN_CRITICAL_PCT": "88"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/skills/spawn/bin/spawn-advisor.js 2>/dev/null || true",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path // empty' | { read -r f; [[ \"$f\" == *\"/.claude/SPAWN/active/\"* ]] && node ~/.claude/skills/spawn/bin/spawn-destruct.js on-read \"$f\" 2>/dev/null; } || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### 3. Create the output directory

```bash
mkdir -p ~/.claude/SPAWN/active ~/.claude/SPAWN/archive
```

### 4. Register the skill in `~/.claude/settings.json`

Add to your skills list so Claude Code loads SKILL.md on `/spawn`:

```json
{
  "skills": [
    {
      "name": "spawn",
      "path": "~/.claude/skills/spawn/SKILL.md"
    }
  ]
}
```

### 5. Verify

```bash
node ~/.claude/skills/spawn/bin/spawn-advisor.js
# Should exit silently (or show advisory if context is high)

node ~/.claude/skills/spawn/bin/spawn-destruct.js status
# Should print: No active spawn packets.
```

---

## Requirements

- **Claude Code 1.x+**
- **Node.js** — ships with Claude Code, zero additional install
- **jq** — for the PostToolUse hook
  - macOS: `brew install jq`
  - Linux: `apt install jq` or `yum install jq`
- macOS or Linux (Windows: hook commands need adaptation)

---

## Configuration

All thresholds configurable via environment variables in `settings.json`:

| Variable | Default | Meaning |
|---|---|---|
| `SPAWN_WARN_PCT` | `70` | Advisory threshold (%) |
| `SPAWN_URGENT_PCT` | `82` | Urgent threshold (%) |
| `SPAWN_CRITICAL_PCT` | `88` | Auto-trigger threshold (%) |
| `SPAWN_AUTO_MODE` | `p` | `p` = prompt (show command), `a` = auto-open terminal |
| `SPAWN_CONTEXT_WINDOW` | `200000` | Token limit (update if your model differs) |

---

## File layout

```
~/.claude/skills/spawn/
├── SKILL.md                ← skill definition (Claude reads this on /spawn)
├── README.md               ← this file
├── bin/
│   ├── spawn-advisor.js    ← UserPromptSubmit hook (token detection + recovery)
│   ├── spawn-parser.js     ← JSONL parser (delta-aware, tool-collapse)
│   └── spawn-destruct.js   ← lifecycle manager (self-destruct on read)
└── schemas/
    ├── packet-standard.md  ← synthesis template (standard mode)
    ├── packet-micro.md     ← synthesis template (--micro mode)
    └── packet-p0.md        ← synthesis template (--p0 mode)

~/.claude/SPAWN/
├── active/                 ← live packets (auto-expire 2 hours)
└── archive/                ← read packets moved here (audit trail)
```

---

## Design decisions

**Token detection is deterministic, not heuristic.**
Claude Code logs full token usage in every assistant message in the session JSONL
under `message.usage`. We read `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` directly. No guessing. No turn counting.

**Synthesize, don't dump.**
A raw conversation dump injected into a new session recreates the problem. Claude
reads the session and writes a structured packet — decisions, not dialogue. The
restored session gets knowledge, not history.

**System prompt injection preserves the new session's context window.**
The packet is delivered via `--append-system-prompt "$(cat packet.md)"`. This
injects it as instructional context, not conversational history — much lighter
on the context window than a file read.

**Self-heal in the same window, not a new one.**
The primary use case is continuity in your current session after compaction. The
`-a` flag (new terminal window) is available for intentional session branching,
but the default behavior keeps you in the same window.

**Self-destruct on read.**
Recovery files delete immediately when read. Packets archive (audit trail).
Both auto-expire after 2 hours. Spawn packets are ephemeral by design — they
exist to bridge one compaction, not to accumulate.

---

## License

MIT. Use it, modify it, distribute it. If you improve it, share it back.

Attribution appreciated: *"spawn by Kevin Stanley, built with Claude"*

---

*spawn v1.0 — 2026-05-14*
*Designed by Kevin Stanley · Built with Claude (Anthropic)*
*github.com/kstanle3/claude-spawn*
