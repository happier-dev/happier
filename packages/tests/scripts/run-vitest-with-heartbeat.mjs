import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHeartbeatArgs, resolveSignalExitCode, runHeartbeatWrappedCommand } from './runPlaywrightWithHeartbeat.shared.mjs';
import {
  VITEST_OPTIONS_WITH_VALUES,
  findUnresolvedVitestPathArgs,
  formatUnresolvedVitestPathArgs,
} from './vitestPathArgs.mjs';

import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';

const testsPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsPackageRoot, '../..');

function isPathInside(parentDir, childPath) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function toPackageRelativePath(absolutePath) {
  const relativePath = relative(testsPackageRoot, absolutePath);
  return relativePath === '' ? '.' : relativePath.split(sep).join('/');
}

function normalizeTestsPackagePathArg(value) {
  if (!value) return value;

  const invocationRelativePath = isAbsolute(value) ? value : resolve(process.cwd(), value);
  if (isPathInside(testsPackageRoot, invocationRelativePath)) {
    return toPackageRelativePath(invocationRelativePath);
  }

  const packageRelativePath = resolve(testsPackageRoot, value);
  if (existsSync(packageRelativePath) && isPathInside(testsPackageRoot, packageRelativePath)) {
    return toPackageRelativePath(packageRelativePath);
  }

  return value;
}

function normalizeVitestPassThroughArgs(args) {
  const normalized = [];
  let preserveNextValue = false;

  for (const arg of args) {
    if (preserveNextValue) {
      normalized.push(arg);
      preserveNextValue = false;
      continue;
    }

    normalized.push(arg.startsWith('-') ? arg : normalizeTestsPackagePathArg(arg));
    if (VITEST_OPTIONS_WITH_VALUES.has(arg)) {
      preserveNextValue = true;
    }
  }

  return normalized;
}

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-vitest-with-heartbeat.mjs --config <vitest.config.ts> [extra args]');
  process.exit(2);
}

const normalizedConfig = normalizeTestsPackagePathArg(config);
const normalizedPassThrough = normalizeVitestPassThroughArgs(passThrough);
const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH
  || resolve(repoRoot, '.project/logs/e2e/vitest-heartbeat-diagnostic.ndjson');
const reporterPath = resolve(scriptsDir, 'vitestHeartbeatReporter.mjs');

// F-7. `vitest run <path>` silently ignores a positional path it cannot match and still exits 0, so
// an explicit path list can under-collect with no signal at all: the lane reports success while the
// tests never ran. Every `packages/tests` CI lane reaches vitest through this wrapper, and several
// pass explicit path lists (`test:core:slow` and `test:core:handoff` expand a `find`, the compat and
// packed-voice lanes name single files), so the check belongs here rather than in each script.
const unresolvedPathArgs = findUnresolvedVitestPathArgs(normalizedPassThrough, {
  packageRoot: testsPackageRoot,
});
if (unresolvedPathArgs.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to run vitest: the positional paths below would collect nothing.\n'
      + 'vitest exits 0 when it silently ignores an unmatched path, so this run would have reported\n'
      + 'success while those tests never executed.\n'
      + formatUnresolvedVitestPathArgs(unresolvedPathArgs),
  );
  process.exit(2);
}

const childArgs = [
  'exec',
  'vitest',
  'run',
  '--no-file-parallelism',
  '-c',
  normalizedConfig,
  '--reporter=default',
  `--reporter=${reporterPath}`,
  ...normalizedPassThrough,
];
const invocation = resolvePnpmCommandInvocation(childArgs, { npmExecPath: '' });

await runHeartbeatWrappedCommand({
  toolName: 'vitest',
  runLogBaseDir: resolve(repoRoot, '.project/logs/e2e'),
  config: normalizedConfig,
  diagnosticPath,
  command: invocation.command,
  args: invocation.args,
  spawnOptions: {
    stdio: 'inherit',
    env: {
      ...process.env,
      HAPPIER_CI_DIAGNOSTIC_PATH: diagnosticPath,
    },
    cwd: testsPackageRoot,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
