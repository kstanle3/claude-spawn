# /spawn — Session Continuity Skill

Preserves full session state before compaction or session end, enabling a new
Claude Code session to resume immediately — operationally, not orientationally.

**Triggers:** `/spawn` · `/spawn --micro` · `/spawn --p0`
**Global:** works in any Claude Code session, any project.

---

## Modes

| Command | Use when | Packet size |
|---|---|---|
| `/spawn` | Checkpoint — prompt mode (offer launch command, don't auto-open) | ~150 lines |
| `/spawn -a` | Checkpoint — auto mode (write packet AND open new window automatically) | ~150 lines |
| `/spawn -p` | Checkpoint — explicit prompt mode (same as bare /spawn) | ~150 lines |
| `/spawn --micro` | Quick save, session feels light, short restart expected | ~30 lines |
| `/spawn --micro -a` | Quick save + auto new window | ~30 lines |
| `/spawn --p0` | Active production incident, no time to waste | Incident-first format |
| `/spawn --p0 -a` | P0 incident + auto new window (fastest possible handoff) | Incident-first |

**Auto-trigger:** At 88%+ context, the hook automatically saves the recovery file
and injects a synthesis instruction. The mode flag used is controlled by the
`SPAWN_AUTO_MODE` env var (`a` or `p`, default `p`).

---

## Execution — follow these steps exactly

### STEP 1 — Detect mode and gather metadata

Parse the command the user typed. Extract the flag if present: `--micro`, `--p0`, or none (standard).

Run the following and capture all outputs:

```bash
node ~/.claude/skills/spawn/bin/spawn-parser.js meta
```

This returns a JSON blob with: `sessionId`, `projectSlug`, `cwd`, `totalTurns`, `jsonlPath`.

Generate a timestamp slug: `date +%Y%m%d-%H%M%S`

Set paths:
```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
PACKET_FILE=~/.claude/SPAWN/active/spawn-packet-${TIMESTAMP}.md
RECOVERY_FILE=~/.claude/SPAWN/active/spawnrecovery-${TIMESTAMP}.md
```

---

### STEP 2 — Parse the conversation (raw recovery file)

```bash
node ~/.claude/skills/spawn/bin/spawn-parser.js parse > ~/.claude/SPAWN/active/spawnrecovery-${TIMESTAMP}.md
```

Confirm file exists and is non-trivial (>500 bytes):
```bash
wc -c ~/.claude/SPAWN/active/spawnrecovery-${TIMESTAMP}.md
```

If the file is missing or trivial, log a warning but continue — the packet synthesis
will still work from your own session context.

---

### STEP 3 — Synthesize the spawn packet

This is the critical step. YOU synthesize the packet — do not copy the raw
conversation into it. Distill it.

Read the appropriate schema:
- Standard: `~/.claude/skills/spawn/schemas/packet-standard.md`
- Micro:    `~/.claude/skills/spawn/schemas/packet-micro.md`
- P0:       `~/.claude/skills/spawn/schemas/packet-p0.md`

Fill in EVERY field in the schema with your own synthesized understanding of
the current session. Rules:

- **ACTIVE TASK**: What is actually being built/debugged/designed RIGHT NOW.
  One line. No ambiguity. The new session reads this and knows exactly what to do.

- **DECISIONS MADE THIS SESSION**: Only include decisions NOT yet written to
  permanent files (ADRs, CLAUDE.md, foundation.md, etc.). If it's already on disk,
  don't repeat it — just put it in READ PRIORITY.

- **MID-FLIGHT ITEMS**: Anything started but not finished. Be specific about state.
  "Writing agent-43.md — completed intro section, stopped at routing table" not
  "working on agent file."

- **NEXT ACTION**: One clear directive. What the new session does FIRST.
  Not a list of options. A single action.

- **CONTEXT THE NEW SESSION MUST KNOW**: Session-only discoveries, constraints,
  and context that exist NOWHERE in any file. This is the most valuable field.
  If it's not here and not in a file, it's lost.

- **READ PRIORITY**: Files the new session should load, but ONLY if needed.
  Include line numbers if a specific section is relevant. Do not list files that
  are always read (CLAUDE.md, ADRs) — only files specifically relevant to the
  current task.

Replace all `{{PLACEHOLDER}}` tokens with actual values.

**Packet size limits:**
- Standard: 200 lines maximum. If you need more, compress harder.
- Micro:    50 lines maximum.
- P0:       No limit on the incident section. Compress the rest.

Write the completed packet to `$PACKET_FILE`.

---

### STEP 4 — Verify both files

```bash
echo "=== PACKET ===" && wc -l $PACKET_FILE
echo "=== RECOVERY ===" && wc -l $RECOVERY_FILE
echo "=== SPAWN DIR ===" && ls -lh ~/.claude/SPAWN/active/
```

Both files must exist. If either is missing, flag it clearly.

---

### STEP 5 — Launch (behavior depends on flag)

**Why no `--resume`:** The packet IS the state. A fresh session with the packet
injected as system context is cleaner than forking the active session (which fails
with "No conversation found" when the source session is still running). The new
session needs zero warmup — the packet gives it everything.

**If flag is `-a` (auto mode):** Write a launch script then open it via osascript.
This avoids nested quote issues with `$(cat ...)` inside AppleScript strings:
```bash
cat > /tmp/spawn-launch.sh << 'LAUNCHEOF'
#!/bin/bash
cd PACKET_CWD
claude --append-system-prompt "$(cat PACKET_FILE_PATH)"
LAUNCHEOF
chmod +x /tmp/spawn-launch.sh
osascript -e 'tell application "Terminal" to do script "/tmp/spawn-launch.sh"'
```
Replace `PACKET_CWD` with the actual cwd value from Step 1 meta output.
Replace `PACKET_FILE_PATH` with the actual `$PACKET_FILE` path (no `$` vars in heredoc).
If osascript fails (non-macOS or Terminal not available), fall back to `-p` behavior
and note the fallback in the report.

**If flag is `-p` or no flag (prompt mode):** Display the launch command for the
user to copy. Do NOT run it automatically.

```bash
# Launch command (copy and run in a NEW terminal window):
cd {{CWD}} && claude --append-system-prompt "$(cat ~/.claude/SPAWN/active/spawn-packet-{{TIMESTAMP}}.md)"
```

**IMPORTANT in both cases:** The current session remains open. The new session
starts with the spawn packet as its system context — immediately operational,
zero file reads required.

---

### STEP 6 — Report to user

Output a clean spawn report:

```
✅ SPAWN COMPLETE — {{TIMESTAMP}}

📦 Packet:   ~/.claude/SPAWN/active/spawn-packet-{{TIMESTAMP}}.md  ({{N}} lines)
📄 Recovery: ~/.claude/SPAWN/active/spawnrecovery-{{TIMESTAMP}}.md ({{N}} lines)

📋 Packet summary:
   Task:        [one line from ACTIVE TASK]
   Next action: [one line from NEXT ACTION]
   Decisions:   [count] uncommitted decisions captured
   Mid-flight:  [count] items in progress

🚀 To continue in a new session, run this in a NEW terminal window:

   cd {{CWD}} && claude --append-system-prompt "$(cat ~/.claude/SPAWN/active/spawn-packet-{{TIMESTAMP}}.md)"

⏱️  Recovery file auto-expires in 2 hours.
   Current session remains active — you can keep working here.
```

---

## What the new session receives

The new session starts with the spawn packet injected as a system prompt.
It knows:
- What project it's in and what was being worked on
- Every uncommitted decision from the prior session
- Exactly what to do first
- Where to look if it needs more context (recovery file path)

The new session does NOT need to read CLAUDE.md, ADRs, or other governance
files preemptively. It reads only what the packet's READ PRIORITY flags as
needed for the current task.

---

## Self-destruct

Recovery files auto-expire after 2 hours. To clean manually:
```bash
node ~/.claude/skills/spawn/bin/spawn-destruct.js clean
```

To check active packets:
```bash
node ~/.claude/skills/spawn/bin/spawn-destruct.js status
```

---

## Distribution note

This skill is project-agnostic. It reads project context from whatever
governance files exist in the working directory. It works with or without
AUDITOR registration, CLAUDE.md, or any specific project structure.

To install in any Claude Code setup:
1. Copy `~/.claude/skills/spawn/` to the target machine
2. Add the UserPromptSubmit hook to `~/.claude/settings.json` (see README.md)
3. Run `/spawn` from any session

---
*spawn v1.0 — Designed by Kevin Stanley*
*Built with Claude (Anthropic) — github.com/kstanle3*
