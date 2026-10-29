import { access } from 'node:fs/promises';
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function makeOwnedDirectoriesWritable(path) {
  let entry;
  try { entry = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Go's module cache deliberately uses read-only directories. Only repair
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

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

