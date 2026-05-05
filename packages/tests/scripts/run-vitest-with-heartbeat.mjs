import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseHeartbeatArgs, resolveSignalExitCode, runHeartbeatWrappedCommand } from './runPlaywrightWithHeartbeat.shared.mjs';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';

const testsPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

const vitestOptionsWithValues = new Set([
  '-t',
  '--testNamePattern',
  '--grep',
  '--reporter',
  '--pool',
  '--environment',
]);

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
    if (vitestOptionsWithValues.has(arg)) {
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
const childArgs = [
  '-s',
  'vitest',
  'run',
  '--no-file-parallelism',
  '-c',
  normalizedConfig,
  ...normalizeVitestPassThroughArgs(passThrough),
];
const invocation = resolveYarnCommandInvocation(childArgs, { npmExecPath: '' });

await runHeartbeatWrappedCommand({
  toolName: 'vitest',
  config: normalizedConfig,
  command: invocation.command,
  args: invocation.args,
  spawnOptions: {
    stdio: 'inherit',
    env: process.env,
    cwd: testsPackageRoot,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  },
  resolveExitCode(result) {
    return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
  },
});
