import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const lockPath = `${boardPath}.lock`;
  const release = await acquireLock(lockPath);
  try {
    const current = await fs.readFile(boardPath);
    const mode = (await fs.stat(boardPath)).mode & 0o777;
    const entry = await fs.readFile(entryFile);
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
  const [board, entryFile, option, ...extra] = process.argv.slice(2);
  const rotateBefore = option?.startsWith('--rotate-before=') ? option.slice('--rotate-before='.length) : undefined;
  const operation = board && entryFile && !extra.length && (!option || rotateBefore !== undefined)
    ? postBoardEntry(board, entryFile, { rotateBefore })
    : Promise.reject(new Error('Usage: node scripts/board/postBoardEntry.mjs <board> <entry-file> [--rotate-before=YYYY-MM-DDTHH:mm:ssZ] (YYYY-MM-DD also accepted)'));
  operation.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
