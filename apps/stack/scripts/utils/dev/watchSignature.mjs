import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export { isDevRuntimeReloadIgnoredPath } from './devRuntimeInputPolicy.mjs';

export function appendWatchSignatureEntries(path, entries, { ignorePath = null } = {}) {
  if (typeof ignorePath === 'function' && ignorePath(path)) return false;

  let stats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    let names = [];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort();
    } catch {
      return true;
    }
    for (const name of names) {
      appendWatchSignatureEntries(join(path, name), entries, { ignorePath });
    }
    return true;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    entries.push(`${path}\0file\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.ino}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export function readDevReloadWatchChangeSignature(paths, { ignorePath = null } = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = appendWatchSignatureEntries(path, entries, { ignorePath }) || observed;
  }
  return observed ? entries.join('\n') : null;
}

export async function appendWatchSignatureEntriesAsync(path, entries, { ignorePath = null } = {}) {
  if (typeof ignorePath === 'function' && ignorePath(path)) return false;

  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch {
    entries.push(`${path}\0missing`);
    return false;
  }

  if (stats.isDirectory()) {
    entries.push(`${path}\0dir`);
    let names = [];
    try {
      names = (await readdir(path, { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return true;
    }
    for (const name of names) {
      await appendWatchSignatureEntriesAsync(join(path, name), entries, { ignorePath });
    }
    return true;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    entries.push(`${path}\0file\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.ino}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export async function readDevReloadWatchChangeSignatureAsync(paths, { ignorePath = null } = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = (await appendWatchSignatureEntriesAsync(path, entries, { ignorePath })) || observed;
  }
  return observed ? entries.join('\n') : null;
}
