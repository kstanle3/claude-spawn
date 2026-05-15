#!/usr/bin/env node
/**
 * spawn-destruct.js
 * Manages spawn packet lifecycle:
 *   - Deletes packets older than MAX_AGE_HOURS (default 2h)
 *   - Called by PostToolUse hook when a Read tool touches a spawn packet
 *   - Also callable manually: node spawn-destruct.js [clean|delete <file>|status]
 *
 * Commands:
 *   node spawn-destruct.js clean          → delete all packets older than MAX_AGE_HOURS
 *   node spawn-destruct.js delete <file>  → delete specific packet immediately
 *   node spawn-destruct.js status         → list active packets with ages
 *   node spawn-destruct.js on-read <file> → called by hook when file is read; deletes it
 */

const fs   = require('fs');
const path = require('path');

const SPAWN_DIR    = path.join(process.env.HOME, '.claude', 'SPAWN');
const ACTIVE_DIR   = path.join(SPAWN_DIR, 'active');
const ARCHIVE_DIR  = path.join(SPAWN_DIR, 'archive');
const MAX_AGE_HOURS = parseInt(process.env.SPAWN_MAX_AGE_HOURS || '2', 10);
const MAX_AGE_MS    = MAX_AGE_HOURS * 60 * 60 * 1000;

function ensureDirs() {
  [SPAWN_DIR, ACTIVE_DIR, ARCHIVE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function listPackets() {
  ensureDirs();
  return fs.readdirSync(ACTIVE_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const fullPath = path.join(ACTIVE_DIR, f);
      const stat = fs.statSync(fullPath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageMin = Math.round(ageMs / 60000);
      return { name: f, fullPath, ageMs, ageMin };
    })
    .sort((a, b) => b.ageMs - a.ageMs); // oldest first
}

function archiveFile(filePath) {
  const name = path.basename(filePath);
  const dest = path.join(ARCHIVE_DIR, name);
  try {
    fs.renameSync(filePath, dest);
    return true;
  } catch {
    try { fs.unlinkSync(filePath); return true; } catch { return false; }
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const [,, command, arg] = process.argv;

switch (command) {

  case 'clean': {
    ensureDirs();
    const packets = listPackets();
    let cleaned = 0;
    for (const p of packets) {
      if (p.ageMs > MAX_AGE_MS) {
        if (archiveFile(p.fullPath)) {
          console.log(`Archived (${p.ageMin}m old): ${p.name}`);
          cleaned++;
        }
      }
    }
    if (cleaned === 0) console.log('No expired packets to clean.');
    break;
  }

  case 'delete': {
    if (!arg) { console.error('Usage: spawn-destruct.js delete <filename>'); process.exit(1); }
    const target = path.isAbsolute(arg) ? arg : path.join(ACTIVE_DIR, arg);
    if (archiveFile(target)) {
      console.log(`Archived: ${path.basename(target)}`);
    } else {
      console.error(`Could not archive: ${target}`);
      process.exit(1);
    }
    break;
  }

  case 'on-read': {
    // Called by PostToolUse hook when spawn packet is read by new session
    // The recovery file (spawnrecovery-*) is deleted; the packet (spawn-packet-*) is archived
    if (!arg) process.exit(0);
    const basename = path.basename(arg);
    const target = path.join(ACTIVE_DIR, basename);
    if (!fs.existsSync(target)) process.exit(0);

    if (basename.startsWith('spawnrecovery-')) {
      // Recovery file: delete immediately (sensitive, ephemeral)
      try { fs.unlinkSync(target); } catch {}
      console.log(`[spawn] Recovery file deleted: ${basename}`);
    } else if (basename.startsWith('spawn-packet-')) {
      // Packet: archive (keep for audit trail)
      if (archiveFile(target)) {
        console.log(`[spawn] Packet archived after read: ${basename}`);
      }
    }
    break;
  }

  case 'status': {
    const packets = listPackets();
    if (packets.length === 0) {
      console.log('No active spawn packets.');
    } else {
      console.log(`Active spawn packets (${packets.length}):`);
      for (const p of packets) {
        const expired = p.ageMs > MAX_AGE_MS ? ' [EXPIRED]' : '';
        console.log(`  ${p.ageMin}m ago${expired}  ${p.name}`);
      }
    }
    break;
  }

  default:
    console.error('Usage: spawn-destruct.js [clean|delete <file>|on-read <file>|status]');
    process.exit(1);
}
