import { access, chmod, lstat, readdir } from 'node:fs/promises';
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function makeOwnedDirectoriesWritable(path) {
  let entry;
  try { entry = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Source captures and Go module caches use read-only directories. Only repair
  // directories owned by this user, never symlink targets or hardlinked files.
  if (!entry.isDirectory()) return;
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw Object.assign(new Error('Temporary directory belongs to another user'), { code: 'EACCES' });
  }
  if ((entry.mode & 0o700) !== 0o700) chmodSync(path, entry.mode | 0o700);
  for (const name of readdirSync(path)) makeOwnedDirectoriesWritable(join(path, name));
}

/** The caller owns lifetime/live-use authorization; this only removes its tree. */
export function removeOwnedDirectorySync(directory, { force = true } = {}) {
  const options = { recursive: true, force };
  try { rmSync(directory, options); }
  catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    makeOwnedDirectoriesWritable(directory);
    rmSync(directory, options);
  }
}

export async function setBundleReadOnly(directory, readOnly) {
  // Unlocking only prepares a bundle for deletion, so an entry a concurrent producer already removed
  // needs nothing; locking a published bundle still fails closed when an entry vanishes.
  const ignoreRemoved = error => { if (readOnly || error?.code !== 'ENOENT') throw error; };
  let entries;
  try { entries = await readdir(directory, {withFileTypes:true}); } catch (error) { ignoreRemoved(error); return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue; // Installed dependencies keep their own lifecycle.
    try {
      if (entry.isDirectory()) {
        if (!readOnly) await chmod(path, 0o755);
        await setBundleReadOnly(path, readOnly);
      } else {
        const mode = (await lstat(path)).mode;
        const desired = readOnly ? mode & ~0o222 : mode | 0o200;
        if (desired !== mode) await chmod(path, desired);
      }
    } catch (error) { ignoreRemoved(error); }
  }
  try { await chmod(directory, readOnly ? 0o555 : 0o755); } catch (error) { ignoreRemoved(error); }
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

