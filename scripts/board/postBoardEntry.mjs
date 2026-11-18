import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The one coordination board (owner ruling 2026-11-18, "Board hygiene"). */
export const BOARD_PATH = '.project/plans/2026-10-26-implementation/BOARD.md';
/** The Lane 12 handoff board: a read-only archive since 2026-11-18. */
export const ARCHIVED_BOARD_PATH = '.project/reviews/2026-10-02-lane12-replan/HANDOFF-OTHER-PROGRAMS.md';
const CHARTER_PATH = path.join(path.dirname(BOARD_PATH), 'CHARTER.md');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** The canonical board in the checkout that holds this script. */
export const defaultBoard = path.join(repoRoot, BOARD_PATH);

function refuseArchivedBoard(board) {
  const archived = path.sep + path.normalize(ARCHIVED_BOARD_PATH);
  if (path.resolve(board).endsWith(archived)) {
    throw new Error(`This board is a read-only archive since 2026-11-18; post to ${BOARD_PATH}`);
  }
}

/** One board heading: `### <UTC> — SENDER → ADDRESSEES — TYPE — subject`. */
export function parseBoardHeading(heading) {
  const match = /^### .*? — (.+?) → (.+?) — ([^—]+?) — (.*)$/.exec(heading);
  if (!match) return undefined;
  const [, sender, to, kind, subject] = match;
  return { sender: sender.trim(), to, entries: addresseeEntries(to), kind, subject };
}

/** Comma-separated addressees, keeping parenthesized lists whole. Each entry designates its
 * exact text and, for a list (`Voice lanes (ADMIT, SWEEP)`), the group and each member. `base`
 * drops a trailing parenthetical (`Voice ORCH (fresh)` → `Voice ORCH`) for name lookups only. */
export function addresseeEntries(to) {
  const raws = [];
  let depth = 0;
  let current = '';
  for (const character of to) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) { raws.push(current); current = ''; } else current += character;
  }
  raws.push(current);
  return raws.map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const list = /^(.*?)\s*\(([^()]*)\)$/.exec(raw);
    const members = list?.[2].includes(',') ? list[2].split(',').map((name) => name.trim()).filter(Boolean) : [];
    const base = list ? list[1] : raw;
    // Only a list designates its parts; `LANE (fresh)` is not LANE.
    return { raw, base, members, names: new Set(members.length ? [raw, base, ...members] : [raw]) };
  });
}

const isAllLeads = (entry) => entry.raw.toLowerCase() === 'all leads';
const nameKey = (name) => name.replace(/\s*\([^()]*\)$/, '').replace(/\/.*$/, '').trim().toLowerCase();

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function closestNames(name, candidates) {
  const key = nameKey(name);
  const ranked = [];
  for (const candidate of candidates) {
    const other = nameKey(candidate);
    if (!other) continue;
    const [shorter, longer] = other.length < key.length ? [other, key] : [key, other];
    // A truncated name (`04S-WIRING`) ranks before typos; a short fragment suggests nothing.
    const distance = shorter.length >= 5 && longer.includes(shorter) ? (longer.length - shorter.length) / 100 : editDistance(key, other);
    if (distance <= Math.max(2, Math.floor(key.length / 3))) ranked.push([distance, candidate]);
  }
  return ranked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, 3).map(([, candidate]) => candidate);
}

/** Known names come from existing sources only: lane report and lane folder names under
 * .project/plans and .project/tmp, board senders (the board posted to and the archive), and
 * CHARTER leads. Ended lanes are those whose report in a report tree starts DONE/BLOCKED-ended. */
async function inspectNames(board, exactNames) {
  const known = new Set();
  const suggestions = new Set();
  const ended = new Map();
  // Restrict discovery to report trees, never the repository root.
  let directories = ['.project/plans', '.project/tmp'];
  while (directories.length) {
    const listings = await Promise.all(directories.map(async (directory) => {
      try { return { directory, entries: await fs.readdir(directory, { withFileTypes: true }) }; }
      catch (error) { if (error.code === 'ENOENT') return { directory, entries: [] }; throw error; }
    }));
    directories = [];
    for (const { directory, entries } of listings) {
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          directories.push(file);
          if (directory.startsWith(path.join('.project', 'tmp'))) known.add(nameKey(entry.name));
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const lane = path.basename(file, '.md');
        known.add(nameKey(lane));
        // Plan briefs and other plan documents name lanes but are not their reports.
        if (file.startsWith(path.join('.project', 'plans') + path.sep) && path.basename(directory) !== 'lanes') continue;
        suggestions.add(lane);
        if (!exactNames.has(lane)) continue;
        let handle;
        try {
          handle = await fs.open(file);
          for await (const line of handle.readLines()) {
            const verdict = line.replace(/^#+\s*/, '').replace(/^status:?\s*/i, '');
            if (/^(?:DONE\b|BLOCKED-ended\b)/.test(verdict)) ended.set(lane, { file, line });
            break;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        } finally {
          await handle?.close();
        }
      }
    }
  }
  const read = async (file) => {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const claims = [];
  for (const file of [board, ARCHIVED_BOARD_PATH]) {
    // Newest first on each board; the board posted to precedes the archive.
    for (const heading of (await read(file)).match(/^### [^\r\n]*/gm) ?? []) {
      const parsed = parseBoardHeading(heading);
      if (!parsed) continue;
      known.add(nameKey(parsed.sender));
      suggestions.add(parsed.sender);
      if (parsed.kind === 'CLAIM') claims.push(parsed.sender);
    }
  }
  for (const [, lead] of (await read(CHARTER_PATH)).matchAll(/^\| \*\*(.+?)\*\* \|/gm)) {
    known.add(nameKey(lead));
    suggestions.add(lead);
  }
  const successor = (lane) => claims.find((sender) => sender.toLowerCase() === `${lane} (fresh)`.toLowerCase());
  return { isKnown: (name) => known.has(nameKey(name)), suggestions, ended, successor };
}

function validateEntry(entry) {
  // OWNER-RULINGS: Usage economy and board conventions (2026-10-31).
  // History is deliberately not validated or rewritten.
  const headings = entry.toString('utf8').match(/^### [^\r\n]*/gm) ?? [];
  for (const heading of headings) {
    const match = /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — .+? → (.+?) — (CLAIM|RESULT|ASK|URGENT|RULING|HOLD) — .+$/.exec(heading);
    if (!match) throw new Error('Use a board heading: ### YYYY-MM-DD HH:MM UTC — SENDER → ADDRESSEE — CLAIM|RESULT|ASK|URGENT|RULING|HOLD — subject');
    if (match[1].split(',').some((name) => name.trim().toLowerCase() === 'all leads') && !['RULING', 'URGENT', 'HOLD'].includes(match[2])) {
      throw new Error('Address ALL leads only with RULING, URGENT or HOLD; name the intended lane for other posts.');
    }
  }
  if (headings.length === 0) throw new Error('Add a board heading with an allowed type: CLAIM, RESULT, ASK, URGENT, RULING or HOLD.');
}

// Orchestrators read their lanes' reports; the board is for another lane's action.
const isOrchestrator = (name) => /(^|[\s-])ORCH(?![a-z])|orchestrator|^Coordination$/i.test(name);

/** OWNER-RULINGS 2026-11-18 "Board hygiene" (2)-(3) and 2026-10-31 (13): refuse posts nobody
 * live must act on, drop ended names from mixed lists, and flag names that match no known lane.
 * Returns the entry to publish. */
async function screenEntry(board, entry) {
  let text = entry.toString('utf8');
  const headings = (text.match(/^### [^\r\n]*/gm) ?? []).map((heading) => [heading, parseBoardHeading(heading)]);
  let names;
  try {
    names = await inspectNames(board, new Set(headings.flatMap(([, parsed]) => parsed?.entries.map((item) => item.raw) ?? [])));
  } catch (error) {
    console.error(`Warning: could not inspect lane names and reports (${error.code ?? error.name}); name and ended-lane checks skipped.`);
  }
  for (const [heading, parsed] of headings) {
    if (!parsed) continue;
    const { sender, kind, subject } = parsed;
    let { entries } = parsed;
    if (names) {
      const endedEntries = entries.filter((item) => names.ended.has(item.raw));
      const describe = (item) => {
        const report = names.ended.get(item.raw);
        const successor = names.successor(item.raw);
        return `${item.raw} has ended (${report.file}: ${report.line})${successor ? `; its successor is ${successor}` : ''}`;
      };
      if (endedEntries.length && endedEntries.length === entries.length) {
        throw new Error(`Refusing a post whose addressees have all ended: ${endedEntries.map(describe).join('; ')}. Address the successor or route to a live owner.`);
      }
      if (endedEntries.length) {
        entries = entries.filter((item) => !endedEntries.includes(item));
        for (const item of endedEntries) console.error(`Warning: dropped ended addressee ${describe(item)}.`);
        const rewritten = heading.replace(` → ${parsed.to} — `, ` → ${entries.map((item) => item.raw).join(', ')} — `);
        text = text.replace(heading, () => rewritten);
      }
      const unknown = [[`sender`, sender], ...entries.filter((item) => !isAllLeads(item)).flatMap((item) => [
        ...(names.isKnown(item.raw) || names.isKnown(item.base) ? [] : [['addressee', item.raw === item.base || item.members.length ? item.base : item.raw]]),
        ...item.members.filter((member) => !names.isKnown(member)).map((member) => ['addressee', member]),
      ])].filter(([role, name]) => role !== 'sender' || !names.isKnown(name));
      for (const [role, name] of unknown) {
        const closest = closestNames(name, names.suggestions);
        console.error(`Warning: ${role} ${name} matches no known lane or orchestrator${closest.length ? `; did you mean ${closest.join(', ')}?` : ''} Use the exact board name (session titles start with it). Post will still land.`);
      }
    }
    if (kind === 'RESULT' && entries.every((item) => isOrchestrator(item.raw))) {
      throw new Error('Refusing a RESULT addressed only to orchestrators: write this in your lane report; post a RESULT only when another lane must act (OWNER-RULINGS 2026-10-31 (13)).');
    }
    // Shared-DB restarts (repo-dev, migrations) keep HOLD/LIFTED. A QA stack
    // reload prepares beside its incumbent, so its lanes need only the READY.
    if (kind === 'HOLD' && /\b(swap|LIFTED|reload)\b/i.test(subject) && !/repo-dev|shared[- ]DB|migration/i.test(subject)) {
      console.error('Warning: a stack reload that does not restart the shared DB posts only its final READY (or NOT_READY), addressed to that stack\'s lanes; keep HOLD/LIFTED for repo-dev and shared-DB restarts. Post will still land.');
    }
  }
  return Buffer.from(text, 'utf8');
}

function holderIsAlive(holder) {
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0 || holder.hostname !== hostname()) {
    throw new Error('Board lock has no verifiable local holder; refusing to steal it');
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function removeDeadLock(lockPath) {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory()) {
      // Migrate an exited pre-directory writer, but never guess ownership of an empty lock.
      const pid = Number((await fs.readFile(lockPath, 'utf8')).trim());
      if (holderIsAlive({ pid, hostname: hostname() })) return false;
      await fs.unlink(lockPath);
      return true;
    }
    const names = await fs.readdir(lockPath);
    if (names.length === 0) {
      await fs.rmdir(lockPath);
      return true;
    }
    if (names.length !== 1 || !names[0].endsWith('.json')) {
      throw new Error('Board lock has no verifiable holder; refusing to steal it');
    }
    const holderPath = path.join(lockPath, names[0]);
    const holder = JSON.parse(await fs.readFile(holderPath, 'utf8'));
    if (holderIsAlive(holder)) return false;
    // Remove only this dead holder. A competing takeover can publish a new directory;
    // its different holder filename makes rmdir fail instead of deleting the new lock.
    await fs.unlink(holderPath);
    await fs.rmdir(lockPath);
    console.error(`Recovered dead board lock: ${holder.hostname}:${holder.pid}`);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EISDIR', 'ENOTDIR'].includes(error.code)) return true;
    throw error;
  }
}

async function acquireLock(lockPath) {
  const token = randomUUID();
  const holderName = `${token}.json`;
  const prepared = await fs.mkdtemp(`${lockPath}.`);
  // Publish a nonempty directory atomically: there is never an ownerless creation gap.
  await fs.writeFile(path.join(prepared, holderName), JSON.stringify({
    pid: process.pid, hostname: hostname(), token, createdAt: new Date().toISOString(),
  }), { flag: 'wx' });
  // Watch before attempting the exclusive create so a release cannot be missed.
  const watcher = watch(path.dirname(lockPath));
  try {
    for (;;) {
      const controller = new AbortController();
      const changed = once(watcher, 'change', { signal: controller.signal });
      changed.catch(() => {});
      try {
        await fs.rename(prepared, lockPath);
        return async () => {
          // Retire the whole nonempty directory, with no ownerless release window.
          await fs.rename(lockPath, prepared);
          await fs.rm(prepared, { recursive: true });
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
        if (await removeDeadLock(lockPath)) continue;
        console.error(`Waiting for board lock: ${lockPath}`);
        // Process death produces no portable filesystem notification. Observe liveness
        // once a second while blocked; age never authorizes taking a live holder's lock.
        await Promise.race([changed, delay(1000, undefined, { signal: controller.signal })]);
      } finally {
        controller.abort();
      }
    }
  } finally {
    watcher.close();
    await fs.rm(prepared, { recursive: true, force: true });
  }
}

function preserveHeadings(current, output) {
  const counts = new Map();
  const headings = (bytes) => bytes.toString('latin1').match(/^#{1,6} [^\r\n]*/gm) ?? [];
  for (const heading of headings(output)) counts.set(heading, (counts.get(heading) ?? 0) + 1);
  for (const heading of headings(current)) {
    const count = counts.get(heading) ?? 0;
    if (count === 0) throw new Error(`Refusing a board write that drops an existing heading: ${heading}`);
    counts.set(heading, count - 1);
  }
}

async function replaceBoard(board, current, candidate, archived, mode, minimumBytes) {
  const temporary = `${board}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, candidate, { flag: 'wx', mode });
    const written = await fs.stat(temporary);
    if (written.size < minimumBytes || written.size !== candidate.length) {
      throw new Error('Refusing a board write that would shrink or truncate its expected bytes');
    }
    const verified = await fs.readFile(temporary);
    if (!verified.equals(candidate)) throw new Error('Board byte verification failed; board was not replaced');
    await fs.chmod(temporary, mode);
    const latest = await fs.readFile(board);
    preserveHeadings(latest, Buffer.concat([verified, archived]));
    if (!latest.equals(current)) throw new Error('Board changed outside the lock; refusing a stale replacement');
    await fs.rename(temporary, board);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Post raw entry bytes; optional rotation archives older posts under the same lock. */
export async function postBoardEntry(board, entryFile, { rotateBefore } = {}) {
  refuseArchivedBoard(board);
  validateEntry(await fs.readFile(entryFile));
  const entry = await screenEntry(board, await fs.readFile(entryFile));
  let cutoff;
  if (rotateBefore !== undefined) {
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(rotateBefore)
      ? `${rotateBefore}T00:00:00.000Z`
      : rotateBefore.replace(/(T\d{2}:\d{2}:\d{2})Z$/, '$1.000Z');
    cutoff = Date.parse(normalized);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)
      || !Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== normalized) {
      throw new Error('Rotation cutoff must be a valid YYYY-MM-DD date or UTC ISO timestamp');
    }
  }
  const boardPath = await fs.realpath(board);
  refuseArchivedBoard(boardPath);
  const lockPath = `${boardPath}.lock`;
  const release = await acquireLock(lockPath);
  try {
    const current = await fs.readFile(boardPath);
    const mode = (await fs.stat(boardPath)).mode & 0o777;
    // latin1 keeps regexp offsets equal to byte offsets, even for non-ASCII history.
    const offset = /^### 20/m.exec(current.toString('latin1'))?.index ?? current.length;
    const separator = entry.length > 0 && entry.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0);
    let candidate = Buffer.concat([current.subarray(0, offset), entry, separator, current.subarray(offset)]);
    let minimumBytes = current.length + entry.length;
    let archivedBytes = Buffer.alloc(0);
    if (rotateBefore !== undefined) {
      const headings = [...candidate.toString('latin1').matchAll(/^### 20[^\n]*/gm)];
      const retained = [candidate.subarray(0, headings[0]?.index ?? candidate.length)];
      const archived = [];
      for (const [index, heading] of headings.entries()) {
        const timestamp = /^### (20\d{2}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\b/.exec(heading[0]);
        const post = candidate.subarray(heading.index, headings[index + 1]?.index ?? candidate.length);
        // Unrecognized headings stay visible for manual reconciliation.
        const isOld = timestamp && Date.parse(`${timestamp[1]}T${timestamp[2]}:00Z`) < cutoff;
        (isOld ? archived : retained).push(post);
      }
      if (archived.length) {
        const tail = Buffer.concat(archived);
        const archiveDirectory = path.join(path.dirname(boardPath), 'board-archive');
        await fs.mkdir(archiveDirectory, { recursive: true });
        const archive = path.join(archiveDirectory, `${path.basename(boardPath, '.md')}-before-${rotateBefore.replaceAll(':', '-')}.md`);
        // Exclusive creation preserves an earlier archive, including one left by an interrupted rotation.
        await fs.writeFile(archive, tail, { flag: 'wx', mode });
        const verified = await fs.readFile(archive);
        if (verified.length !== tail.length) {
          throw new Error('Archive size verification failed; board was not trimmed');
        }
        if ([...verified.toString('latin1').matchAll(/^### 20/gm)].length !== archived.length) {
          throw new Error('Archive heading count verification failed; board was not trimmed');
        }
        if (!verified.equals(tail)) {
          throw new Error('Archive byte verification failed; board was not trimmed');
        }
        archivedBytes = verified;
        candidate = Buffer.concat(retained);
        minimumBytes = candidate.length;
      }
    }
    await replaceBoard(boardPath, current, candidate, archivedBytes, mode, minimumBytes);
  } finally {
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const positional = process.argv.slice(2);
  // `<entry-file>` alone posts to the canonical board.
  if (positional.length === 1 || (positional.length === 2 && positional[1].startsWith('--'))) positional.unshift(defaultBoard);
  const [board, entryFile, option, ...extra] = positional;
  const rotateBefore = option?.startsWith('--rotate-before=') ? option.slice('--rotate-before='.length) : undefined;
  const operation = board && entryFile && !extra.length && (!option || rotateBefore !== undefined)
    ? postBoardEntry(board, entryFile, { rotateBefore })
    : Promise.reject(new Error('Usage: node scripts/board/postBoardEntry.mjs [<board>] <entry-file> [--rotate-before=YYYY-MM-DDTHH:mm:ssZ] (YYYY-MM-DD also accepted)'));
  operation.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
