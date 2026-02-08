import { spawn } from 'node:child_process';

import { filterProviderIdsForScenarioSelection, parseMaxParallel, resolveProviderPresetIds } from '../src/testkit/providers/presets.mjs';
import { terminateProcessTreeByPid } from './processTree.mjs';

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let maxParallelRaw;
  let retrySerial = true;
  const flags = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--max-parallel') {
      maxParallelRaw = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--no-retry-serial') {
      retrySerial = false;
      continue;
    }
    if (arg.startsWith('-')) {
      flags.add(arg);
      continue;
    }
    positional.push(arg);
  }

  return {
    presetId: positional[0] ?? null,
    tier: positional[1] ?? null,
    maxParallelRaw,
    retrySerial,
    updateBaselines: flags.has('--update-baselines'),
    strictKeys: flags.has('--strict-keys'),
    flakeRetry: flags.has('--flake-retry'),
  };
}

function usage(exitCode) {
  // eslint-disable-next-line no-console
  console.error(
    [
      'Usage:',
      '  yarn providers:run:parallel <preset> <tier> [--max-parallel N] [--update-baselines] [--strict-keys] [--flake-retry] [--no-retry-serial]',
      '',
      'Presets: opencode | claude | codex | kilo | qwen | kimi | auggie | all',
      'Tiers:   smoke | extended',
      '',
      'Notes:',
      '  - Default max parallel: 4',
      '  - Failures are retried serially once by default (disable with --no-retry-serial)',
      '',
      'Examples:',
      '  yarn providers:run:parallel all extended',
      '  yarn providers:run:parallel all extended --max-parallel 5',
      '  yarn providers:run:parallel opencode extended --strict-keys',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function buildProviderRunArgs(params) {
  const args = ['-s', 'providers:run', params.providerId, params.tier];
  if (params.updateBaselines) args.push('--update-baselines');
  if (params.strictKeys) args.push('--strict-keys');
  if (params.flakeRetry) args.push('--flake-retry');
  return args;
}

const activeChildren = new Set();
let shuttingDown = false;

function signalExitCode(signal) {
  return signal ? 128 : 1;
}

async function stopActiveChildren() {
  const children = [...activeChildren];
  await Promise.all(
    children.map(async (child) => {
      if (!child?.pid) return;
      await terminateProcessTreeByPid(child.pid, { graceMs: 5_000, pollMs: 100 });
    }),
  );
}

async function shutdownAndExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopActiveChildren();
  } finally {
    process.exit(code);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdownAndExit(128);
  });
}

function runProvider(params) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(yarnCommand(), buildProviderRunArgs(params), {
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);

    child.on('error', () => {
      activeChildren.delete(child);
      resolve({
        providerId: params.providerId,
        code: 1,
        signal: null,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      resolve({
        providerId: params.providerId,
        code: code ?? signalExitCode(signal),
        signal: signal ?? null,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function runWithConcurrency(params) {
  const queue = [...params.providerIds];
  const results = [];

  const workers = Array.from({ length: Math.min(params.maxParallel, queue.length) }, async () => {
    while (queue.length > 0) {
      if (shuttingDown) break;
      const providerId = queue.shift();
      if (!providerId) break;
      // eslint-disable-next-line no-console
      console.log(`[providers:parallel] start ${providerId} (${params.tier})`);
      const result = await runProvider({
        providerId,
        tier: params.tier,
        updateBaselines: params.updateBaselines,
        strictKeys: params.strictKeys,
        flakeRetry: params.flakeRetry,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[providers:parallel] done ${providerId} code=${result.code} elapsed=${Math.round(result.elapsedMs / 1000)}s`,
      );
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}

const parsed = parseArgs(process.argv);
if (!parsed.presetId || !parsed.tier) usage(2);

const resolvedProviderIds = resolveProviderPresetIds(parsed.presetId);
if (!resolvedProviderIds) usage(2);
if (parsed.tier !== 'smoke' && parsed.tier !== 'extended') usage(2);

const maxParallel = parseMaxParallel(parsed.maxParallelRaw, 4);
if (!maxParallel) usage(2);

const providerIds = filterProviderIdsForScenarioSelection(
  resolvedProviderIds,
  process.env.HAPPIER_E2E_PROVIDER_SCENARIOS,
);
if (providerIds.length === 0) usage(2);

const initial = await runWithConcurrency({
  providerIds,
  tier: parsed.tier,
  maxParallel,
  updateBaselines: parsed.updateBaselines,
  strictKeys: parsed.strictKeys,
  flakeRetry: parsed.flakeRetry,
});

const initialFailures = initial.filter((item) => item.code !== 0).map((item) => item.providerId);
if (!parsed.retrySerial || initialFailures.length === 0) {
  await shutdownAndExit(initialFailures.length === 0 ? 0 : 1);
}

// eslint-disable-next-line no-console
console.log(`[providers:parallel] retrying ${initialFailures.length} provider(s) serially`);

const retryFailures = [];
for (const providerId of initialFailures) {
  if (shuttingDown) break;
  // eslint-disable-next-line no-console
  console.log(`[providers:parallel] retry start ${providerId}`);
  const retry = await runProvider({
    providerId,
    tier: parsed.tier,
    updateBaselines: parsed.updateBaselines,
    strictKeys: parsed.strictKeys,
    flakeRetry: parsed.flakeRetry,
  });
  // eslint-disable-next-line no-console
  console.log(`[providers:parallel] retry done ${providerId} code=${retry.code} elapsed=${Math.round(retry.elapsedMs / 1000)}s`);
  if (retry.code !== 0) retryFailures.push(providerId);
}

await shutdownAndExit(retryFailures.length === 0 ? 0 : 1);
