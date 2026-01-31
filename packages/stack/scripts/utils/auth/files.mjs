import { chmod, copyFile, lstat, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDir } from '../fs/ops.mjs';

export async function removeFileOrSymlinkIfExists(path) {
  try {
    const st = await lstat(path);
    if (st.isDirectory()) {
      throw new Error(`[auth] refusing to remove directory path: ${path}`);
    }
    await unlink(path);
    return true;
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return false;
    throw e;
  }
}

export async function writeSecretFileIfMissing({ path, secret, force = false }) {
  if (!force && existsSync(path)) return false;
  if (force && existsSync(path)) {
    await removeFileOrSymlinkIfExists(path);
  }
  await ensureDir(dirname(path));
  await writeFile(path, secret, { encoding: 'utf-8', mode: 0o600 });
  return true;
}

export async function copyFileIfMissing({ from, to, mode, force = false }) {
  if (!force && existsSync(to)) return false;
  if (!existsSync(from)) return false;
  await ensureDir(dirname(to));
  // IMPORTANT: if `to` is a symlink and we "overwrite" it, do NOT write through it to the symlink target.
  if (force && existsSync(to)) {
    await removeFileOrSymlinkIfExists(to);
  }
  await copyFile(from, to);
  if (mode) {
    await chmod(to, mode).catch(() => {});
  }
  return true;
}

export async function linkFileIfMissing({ from, to, force = false }) {
  if (!force && existsSync(to)) return false;
  if (!existsSync(from)) return false;
  await ensureDir(dirname(to));
  if (force && existsSync(to)) {
    await removeFileOrSymlinkIfExists(to);
  }
  await symlink(from, to);
  return true;
}

