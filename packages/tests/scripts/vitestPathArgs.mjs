import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * F-7 guard. `vitest run <path>` silently ignores a positional path it cannot match and still exits
 * 0, so an explicit path list can under-collect without any signal — the run reports success and the
 * missing file looks like it passed. That invalidates the evidence rather than one test, and in this
 * workspace it is the mechanism that would make an ORPHANED suite look green: a suite re-homed into a
 * config that does not collect it reports nothing and exits 0.
 *
 * The check is deliberately narrow. It validates only PATH-SHAPED positional args, because vitest
 * also accepts bare substring filters (`vitest run pendingQueue`) that must keep working.
 */

// Single owner for the option-with-value list. `run-vitest-with-heartbeat.mjs` imports this instead
// of keeping its own copy, so path normalization and path validation can never disagree about which
// token is an option value rather than a path.
export const VITEST_OPTIONS_WITH_VALUES = Object.freeze(new Set([
  '-t',
  '--testNamePattern',
  '--grep',
  '--reporter',
  '--pool',
  '--environment',
]));

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PATH_SHAPED_PATTERN = /[\\/]|\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);

/** Positional args only: options and the values they consume are not paths. */
export function collectPositionalArgs(args) {
  const positional = [];
  let consumeNextValue = false;

  for (const arg of args) {
    if (consumeNextValue) {
      consumeNextValue = false;
      continue;
    }
    if (arg.startsWith('-')) {
      if (VITEST_OPTIONS_WITH_VALUES.has(arg)) consumeNextValue = true;
      continue;
    }
    positional.push(arg);
  }

  return positional;
}

export function isPathShapedArg(value) {
  return PATH_SHAPED_PATTERN.test(value);
}

function containsTestFile(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  const nested = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) nested.push(join(directory, entry.name));
      continue;
    }
    if (TEST_FILE_PATTERN.test(entry.name)) return true;
  }

  return nested.some((child) => containsTestFile(child));
}

/**
 * @returns array of `{ arg, reason }` for every path-shaped positional arg vitest could not have
 * collected anything from. `missing` = nothing exists at that path. `no-test-files` = the directory
 * exists but holds no test file, so vitest would collect zero from it and still exit 0.
 */
export function findUnresolvedVitestPathArgs(args, options) {
  const packageRoot = options.packageRoot;
  const unresolved = [];

  for (const arg of collectPositionalArgs(args)) {
    if (!isPathShapedArg(arg)) continue;

    const absolutePath = isAbsolute(arg) ? arg : resolve(packageRoot, arg);
    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      unresolved.push({ arg, reason: 'missing' });
      continue;
    }

    if (stats.isDirectory() && !containsTestFile(absolutePath)) {
      unresolved.push({ arg, reason: 'no-test-files' });
    }
  }

  return unresolved;
}

export function formatUnresolvedVitestPathArgs(unresolved) {
  return unresolved
    .map(({ arg, reason }) => (reason === 'missing'
      ? `  ${arg} — no such file or directory`
      : `  ${arg} — directory contains no test files`))
    .join('\n');
}
