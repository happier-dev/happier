import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function acquireLock(lockPath) {
  // Watch before attempting the exclusive create so a release cannot be missed.
  const watcher = watch(path.dirname(lockPath));
  try {
    for (;;) {
      const changed = once(watcher, 'change');
      try {
        return await fs.open(lockPath, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        console.error(`Waiting for board lock: ${lockPath}`);
        await changed;
      } finally {
        watcher.removeAllListeners('change');
        watcher.removeAllListeners('error');
      }
    }
  } finally {
    watcher.close();
  }
}

async function replaceBoard(board, candidate, mode, minimumBytes) {
  const temporary = `${board}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, candidate, { flag: 'wx', mode });
    const written = await fs.stat(temporary);
    if (written.size < minimumBytes || written.size !== candidate.length) {
      throw new Error('Refusing a board write that would shrink or truncate its expected bytes');
    }
    await fs.chmod(temporary, mode);
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
  const lock = await acquireLock(lockPath);
  try {
    await lock.writeFile(`${process.pid}\n`);
    const current = await fs.readFile(boardPath);
    const mode = (await fs.stat(boardPath)).mode & 0o777;
    const entry = await fs.readFile(entryFile);
    // latin1 keeps regexp offsets equal to byte offsets, even for non-ASCII history.
    const offset = /^### 20/m.exec(current.toString('latin1'))?.index ?? current.length;
    const separator = entry.length > 0 && entry.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0);
    let candidate = Buffer.concat([current.subarray(0, offset), entry, separator, current.subarray(offset)]);
    let minimumBytes = current.length + entry.length;
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
        candidate = Buffer.concat(retained);
        minimumBytes = candidate.length;
      }
    }
    await replaceBoard(boardPath, candidate, mode, minimumBytes);
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
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
