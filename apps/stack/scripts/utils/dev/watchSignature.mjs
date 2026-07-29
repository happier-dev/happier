import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_ONLY_DIRECTORY_NAMES = new Set([
  '__fixtures__',
  '__snapshots__',
  '__tests__',
  'coverage',
  'fixtures',
  'snapshots',
  'test',
  'testkit',
  'tests',
]);
const TEST_ONLY_FILE_RE = /(?:^|[._-])(?:test|spec|bench|benchmark)\.[cm]?[jt]sx?$/;
const TESTKIT_FILE_RE = /\.testkit\.[cm]?[jt]sx?$/;
const VITEST_SETUP_FILE_RE = /^vitestSetup\.[cm]?[jt]sx?$/;

export function isDevRuntimeReloadIgnoredPath(path) {
  const normalized = String(path ?? '').replaceAll('\\', '/');
  if (!normalized) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => TEST_ONLY_DIRECTORY_NAMES.has(part))) return true;
  const base = parts.at(-1) ?? '';
  return (
    TEST_ONLY_FILE_RE.test(base)
    || TESTKIT_FILE_RE.test(base)
    || VITEST_SETUP_FILE_RE.test(base)
    || base === 'vitest.config.ts'
    || base.startsWith('vitest.')
    || base.startsWith('test-setup.')
    || base.endsWith('.snap')
  );
}

export function appendWatchSignatureEntries(path, entries, { ignorePath = isDevRuntimeReloadIgnoredPath } = {}) {
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
    entries.push(`${path}\0file\0${stats.size}\0${stats.mtimeNs}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export function readDevReloadWatchChangeSignature(paths, { ignorePath = isDevRuntimeReloadIgnoredPath } = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = appendWatchSignatureEntries(path, entries, { ignorePath }) || observed;
  }
  return observed ? entries.join('\n') : null;
}

export async function appendWatchSignatureEntriesAsync(path, entries, { ignorePath = isDevRuntimeReloadIgnoredPath } = {}) {
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
    entries.push(`${path}\0file\0${stats.size}\0${stats.mtimeNs}`);
    return true;
  }

  entries.push(`${path}\0other\0${stats.mtimeNs}`);
  return true;
}

export async function readDevReloadWatchChangeSignatureAsync(paths, { ignorePath = isDevRuntimeReloadIgnoredPath } = {}) {
  const entries = [];
  let observed = false;
  for (const path of paths) {
    observed = (await appendWatchSignatureEntriesAsync(path, entries, { ignorePath })) || observed;
  }
  return observed ? entries.join('\n') : null;
}
