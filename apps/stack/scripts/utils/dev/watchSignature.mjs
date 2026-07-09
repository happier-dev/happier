import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function appendWatchSignatureEntries(path, entries) {
  let stats;
  try {
    stats = lstatSync(path);
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
      appendWatchSignatureEntries(join(path, name), entries);
    }
    return true;
  }

  if (stats.isFile() || stats.isSymbolicLink()) {
    entries.push(`${path}\0file\0${stats.size}\0${Math.trunc(stats.mtimeMs)}`);
    return true;
  }

  entries.push(`${path}\0other\0${Math.trunc(stats.mtimeMs)}`);
  return true;
}

export function readDevReloadWatchChangeSignature(paths) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = appendWatchSignatureEntries(path, entries) || observed;
  }
  return observed ? entries.join('\n') : null;
}
