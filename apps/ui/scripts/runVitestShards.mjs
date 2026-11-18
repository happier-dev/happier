#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createManagedChildLifecycle,
  resolveSignalExitCode,
  runManagedChildCommand,
} from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { resolveVitestNodeCommand } from '../../../scripts/testing/vitestNodeCommand.mjs';
import {
  parseVitestListJson,
  shouldVitestShardRunProceedWithoutFiles,
} from '../../../scripts/testing/vitestShardCollection.mjs';
import {
  classifyVitestShardTermination,
  summarizeVitestShardOutcomes,
} from '../../../scripts/testing/vitestShardOutcomes.mjs';
import { partitionByWeight } from '../../../scripts/testing/weightedPartition.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';
import { loadVitestUnitDurations, vitestDurationKey } from './vitestUnitDurations.mjs';

export {
  classifyVitestShardTermination,
  shouldVitestShardRunProceedWithoutFiles,
  summarizeVitestShardOutcomes,
};

const require = createRequire(import.meta.url);
const { resolveVitestPoolEnv, resolveVitestWorkers } = require('../../../scripts/testing/vitestWorkers.ts');
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptsDir);

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveConcurrencyFlagValue(argv) {
  const args = Array.isArray(argv) ? argv : [];

  const idx = args.indexOf('--concurrency');
  if (idx !== -1) {
    return args[idx + 1] ?? null;
  }

  const inline = args.find((arg) => typeof arg === 'string' && arg.startsWith('--concurrency='));
  if (typeof inline === 'string') {
    return inline.slice('--concurrency='.length);
  }

  return null;
}

// Each Vitest process pays a cold transform of the shared UI graph, so the per-process
// file budget dominates whole-suite cost. Same host, same 128 files, two workers:
// 8x16 took 1292s (transform 707s, peak tree RSS 5.3 GB); 1x128 took 700s (transform 157s,
// peak tree RSS 3.8 GB). Workers are recycled per file, so a larger budget does not grow
// worker retention.
const DEFAULT_MAX_FILES_PER_SHARD = 128;

export function resolveVitestShardCountForFileCount(env, fileCount) {
  const override = parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARDS);
  // Bound each process's module-graph retention by the measured file budget above.
  // Explicit overrides remain available for focused diagnosis.
  const collectedFileCount = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : 1;
  return override ?? Math.max(parsePositiveInt(env?.HAPPIER_UI_VITEST_PARTS) ?? 1,
    Math.ceil(collectedFileCount / DEFAULT_MAX_FILES_PER_SHARD));
}

export function resolveVitestShardRange(env, shardCount) {
  const part = parsePositiveInt(env?.HAPPIER_UI_VITEST_PART);
  const parts = parsePositiveInt(env?.HAPPIER_UI_VITEST_PARTS);
  if (part === null || parts === null || part > parts || parts > shardCount) {
    return { start: 1, end: shardCount, part: 1, parts: 1 };
  }
  const start = Math.floor(((part - 1) * shardCount) / parts) + 1;
  const end = Math.floor((part * shardCount) / parts);
  return { start, end, part, parts };
}

export function resolveVitestShardTimeoutMs(env) {
  // CI owns the whole job deadline, including restore and test execution.
  // Keep an explicit watchdog for focused diagnostics outside that lifecycle.
  return parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS) ?? undefined;
}

export function resolveVitestShardConcurrency(env, argv, parallelism = os.availableParallelism(),
  maxWorkers = resolveVitestWorkers({ env, legacyUiOverride: true }).maxWorkers) {
  const flagOverride = parsePositiveInt(resolveConcurrencyFlagValue(argv));
  const envOverride = parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARD_CONCURRENCY);
  // Every partition has a Vite transform server as well as its canonical fork pool.
  // Eight partitions previously multiplied the four-fork policy into 40 Node
  // processes on a 12-CPU worker, oversubscribing cold module loading.
  // Keep that pool sharing one transform cache instead of multiplying cold servers.
  return Math.min(flagOverride ?? envOverride ?? 1, Math.max(1, Math.floor(parallelism / (maxWorkers + 1))));
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveVitestPassthroughArgs(argv) {
  const idx = argv.indexOf('--config');
  const raw = idx === -1 ? argv.slice(2) : argv.slice(idx + 2);

  const cleaned = [];
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--concurrency') {
      i += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('--concurrency=')) {
      continue;
    }
    cleaned.push(arg);
  }

  return cleaned;
}

/**
 * Vitest ORs positional filters: a shard invocation that carries both the caller's path
 * filter and the shard's file list re-runs the whole filtered set, so every shard executes
 * the same files once per shard instead of once. The shard file list is already the
 * resolved form of those filters, so the filters must be dropped from the per-shard run.
 *
 * Classification uses Vitest's own CLI parser rather than a local option table plus a
 * shape heuristic. The heuristic this replaced could not see a bare-name filter
 * (`legendListRenderer` has no separator and no extension), and its hand-maintained
 * value-flag table silently misclassified the value of any option it did not list.
 */
export async function resolveVitestPositionalFilters(passthroughArgs) {
  const args = Array.from(passthroughArgs ?? []);
  if (args.length === 0) return [];

  const { parseCLI } = await import('vitest/node');
  // parseCLI mutates the argv it is given, so hand it a throwaway array.
  const { filter } = parseCLI(['vitest', 'run', ...args]);
  return Array.isArray(filter) ? Array.from(filter) : [];
}

/** The vitest argv tail for one shard: caller options, minus the path filters, plus its files. */
export function buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }) {
  const droppable = new Map();
  for (const filter of positionalFilters ?? []) {
    droppable.set(filter, (droppable.get(filter) ?? 0) + 1);
  }

  const optionArgs = [];
  for (const arg of passthroughArgs ?? []) {
    const remaining = droppable.get(arg) ?? 0;
    if (remaining > 0) {
      droppable.set(arg, remaining - 1);
      continue;
    }
    optionArgs.push(arg);
  }

  return [
    'run',
    '--config',
    configPath,
    '--file-parallelism=true',
    ...optionArgs,
    ...(files ?? []),
  ];
}

/**
 * Balances shards by measured file seconds (vitestUnitDurations.mjs). A file
 * with no measurement weighs the median measured file; with no measurements at
 * all every file weighs the same, which is round-robin over the sorted paths.
 */
export function partitionVitestFilesIntoShards(files, shardCount, weights = new Map()) {
  const count = Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const measured = [...weights.values()].sort((a, b) => a - b);
  const fallback = measured.length ? measured[Math.floor(measured.length / 2)] : 1;
  return partitionByWeight({ items: Array.from(files ?? []).filter(Boolean), partitionCount: count,
    weightOf: (file) => weights.get(vitestDurationKey(file)) ?? fallback });
}

/**
 * The Gate's affected-unit plan (`runAffectedTests.ts --units --plan`): the UI entry's selected
 * files, or every collected file when the plan selects the whole package or has no UI entry.
 */
export function filterVitestFilesBySelection(files, selectionPath) {
  if (!selectionPath) return files;
  const entry = JSON.parse(readFileSync(selectionPath, 'utf8')).units?.['apps/ui'];
  if (!entry || entry.full) return files;
  const repoRoot = path.resolve(packageRoot, '..', '..');
  const selected = new Set(entry.files.map((file) => path.resolve(repoRoot, file)));
  return files.filter((file) => selected.has(path.resolve(file)));
}

export function createVitestShardRunPlan({
  shardFiles,
  shardCount,
  startShard = 1,
  endShard = shardCount,
}) {
  const count = Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const buckets = Array.isArray(shardFiles) ? shardFiles : [];

  const plan = [];
  for (let shardIndex = startShard; shardIndex <= endShard; shardIndex += 1) {
    const files = buckets[shardIndex - 1] ?? [];
    if (!Array.isArray(files) || files.length === 0) continue;
    plan.push({
      shardIndex,
      shardCount: count,
      shardSpec: `${shardIndex}/${count}`,
      files,
    });
  }
  return plan;
}

async function resolveVitestTestFiles({ vitestCommand, configPath, env, passthroughArgs }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-ui-vitest-list-'));
  const jsonPath = path.join(tmpDir, 'vitest-files.json');
  let operatorSignal = null;

  const result = await runManagedChildCommand({
    command: vitestCommand.command,
    args: [
      ...vitestCommand.argsPrefix,
      'list',
      '--config',
      configPath,
      '--filesOnly',
      '--json',
      jsonPath,
      ...passthroughArgs,
    ],
    spawnOptions: {
      env,
      stdio: 'inherit',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    onProcessSignal: (signal) => { operatorSignal ??= signal; },
  });

  if (!result.ok) {
    throw result.error;
  }

  if (operatorSignal || result.signal) {
    process.exit(resolveSignalExitCode(operatorSignal ?? result.signal));
    return [];
  }

  if (result.code && result.code !== 0) {
    process.exit(result.code);
    return [];
  }

  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    return parseVitestListJson(raw);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {});
  }
}

async function spawnVitestRun({ vitestCommand, configPath, env, passthroughArgs, positionalFilters, files, timeoutMs, onTimeout }) {
  let operatorSignal = null;
  const result = await runManagedChildCommand({
    command: vitestCommand.command,
    args: [
      ...vitestCommand.argsPrefix,
      ...buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }),
    ],
    spawnOptions: {
      env,
      stdio: 'inherit',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    maxRuntimeMs: timeoutMs,
    onMaxRuntime: onTimeout,
    onProcessSignal: (signal) => { operatorSignal ??= signal; },
  });
  // A cooperative Vitest exit is numeric after process-tree cleanup sends SIGTERM.
  // Preserve the operator's intent so it stops the lane instead of admitting another shard.
  return operatorSignal ? { ...result, signal: operatorSignal, timedOut: false } : result;
}

function startVitestRun({ vitestCommand, configPath, env, passthroughArgs, positionalFilters, files, timeoutMs, onTimeout }) {
  let operatorSignal = null;
  const child = spawn(
    vitestCommand.command,
    [
      ...vitestCommand.argsPrefix,
      ...buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }),
    ],
    {
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    },
  );

  const lifecycle = createManagedChildLifecycle(child, {
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    onProcessSignal: (signal) => { operatorSignal ??= signal; },
  });
  let timedOut = false;
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    onTimeout?.();
    void lifecycle.cleanupChild('SIGTERM');
  }, timeoutMs);
  timeout?.unref?.();

  const promise = new Promise((resolve) => {
    child.once('error', (error) => {
      clearTimeout(timeout);
      lifecycle.dispose();
      resolve({
        child,
        ok: false,
        error,
        timedOut,
      });
    });

    child.once('exit', async (code, signal) => {
      clearTimeout(timeout);
      await lifecycle.finalizeChildExit({
        graceMs: 1_000,
        pollMs: 25,
        skipAliveCheck: true,
      });
      resolve({
        child,
        ok: true,
        code,
        signal: operatorSignal ?? signal,
        timedOut: operatorSignal ? false : timedOut,
      });
    });
  });

  return {
    promise,
    cancel: async () => {
      clearTimeout(timeout);
      await lifecycle.cleanupChild('SIGTERM');
    },
  };
}

export async function runVitestShardRunPlan({ plan, concurrency, startShard }) {
  const shardPlan = Array.isArray(plan) ? plan : [];
  const limitRaw = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
  const limit = Math.max(1, limitRaw);

  const active = new Map();
  const outcomes = [];
  let cursor = 0;

  function startNext() {
    if (cursor >= shardPlan.length) return;
    const entry = shardPlan[cursor];
    cursor += 1;
    const handle = startShard(entry);
    active.set(entry.shardSpec, { entry, handle });
  }

  while (active.size < limit && cursor < shardPlan.length) {
    startNext();
  }

  while (active.size > 0) {
    const races = Array.from(active.values()).map(({ entry, handle }) =>
      Promise.resolve(handle.promise).then((result) => ({ entry, handle, result })),
    );

    // eslint-disable-next-line no-await-in-loop
    const { entry, result } = await Promise.race(races);
    active.delete(entry.shardSpec);

    if (!result.ok) {
      await Promise.allSettled(Array.from(active.values()).map(({ handle: other }) => other.cancel?.()));
      throw result.error;
    }

    const termination = classifyVitestShardTermination(result);
    outcomes.push({ ...termination, shardSpec: entry.shardSpec, shardIndex: entry.shardIndex });

    // A failed shard is recorded and the run continues: cancelling the in-flight shards and
    // returning here is what let a sharded lane report green while the shards after the first
    // failure never executed. Only an operator interrupt stops the plan.
    if (termination.outcome === 'aborted') {
      await Promise.allSettled(Array.from(active.values()).map(({ handle: other }) => other.cancel?.()));
      return { ok: true, code: termination.exitCode, signal: termination.signal, outcomes };
    }

    while (active.size < limit && cursor < shardPlan.length) {
      startNext();
    }
  }

  const summary = summarizeVitestShardOutcomes({ shardCount: shardPlan.length, outcomes });
  return { ok: true, code: summary.exitCode, signal: null, outcomes };
}

async function main(argv) {
  const configPath = resolveVitestConfigPath(argv);
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/runVitestShards.mjs --config <vitest.config.ts>');
    process.exit(1);
  }

  const workers = resolveVitestWorkers({ legacyUiOverride: true });
  const shardConcurrency = resolveVitestShardConcurrency(process.env, argv, os.availableParallelism(), workers.maxWorkers);
  const shardTimeoutMs = resolveVitestShardTimeoutMs(process.env);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const passthroughArgs = resolveVitestPassthroughArgs(argv);
  const { parseCLI } = await import('vitest/node');
  const { options } = parseCLI(['vitest', 'run', ...passthroughArgs]);
  const vitestEnv = {
    ...process.env,
    ...resolveVitestPoolEnv(workers),
    NODE_OPTIONS: nodeOptions,
  };
  // Native CLI arguments, including percentages, retain Vitest's own resolution.
  if (options.maxWorkers !== undefined) {
    delete vitestEnv.VITEST_MAX_FORKS;
    delete vitestEnv.VITEST_MAX_THREADS;
  }
  if (options.minWorkers !== undefined) {
    delete vitestEnv.VITEST_MIN_FORKS;
    delete vitestEnv.VITEST_MIN_THREADS;
  }
  const vitestCommand = resolveVitestNodeCommand(packageRoot);
  // The list pass keeps the caller's filters (they are what selects the files); the shard runs
  // drop exactly those filters, because the resolved file list already carries them.
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);

  const allFiles = filterVitestFilesBySelection(
    await resolveVitestTestFiles({ vitestCommand, configPath, env: vitestEnv, passthroughArgs }),
    process.env.HAPPIER_UI_VITEST_SELECTION);
  if (!shouldVitestShardRunProceedWithoutFiles({ fileCount: allFiles.length, passthroughArgs })) {
    // `vitest run` itself exits non-zero when a filter matches nothing. Sharding must not be
    // more permissive than the tool it wraps: a mistyped path filter that silently exits 0 is
    // the same vacuous green as a skipped shard.
    // eslint-disable-next-line no-console
    console.error('[vitest] no test files matched — refusing to report a sharded run as green');
    process.exit(1);
    return;
  }
  const shardCount = resolveVitestShardCountForFileCount(process.env, allFiles.length);
  const shardRange = resolveVitestShardRange(process.env, shardCount);
  const shardFiles = partitionVitestFilesIntoShards(allFiles, shardCount, loadVitestUnitDurations());
  const plan = createVitestShardRunPlan({
    shardFiles,
    shardCount,
    startShard: shardRange.start,
    endShard: shardRange.end,
  });

  // Parts record measured per-file seconds for the committed shard weights.
  const shardPassthroughArgs = process.env.HAPPIER_UI_VITEST_DURATIONS_OUTPUT ? [...passthroughArgs,
    ...(options.reporter === undefined ? ['--reporter=default'] : []),
    `--reporter=${path.join(scriptsDir, 'vitestFileDurationReporter.mjs')}`] : passthroughArgs;

  const activePartitions = Math.max(1, Math.min(shardConcurrency, plan.length));
  // eslint-disable-next-line no-console
  console.log(`[vitest] partitions=${activePartitions}; maxWorkers=${options.maxWorkers ?? workers.maxWorkers}; cpus=${os.availableParallelism()}`);

  const startShard = (entry) => {
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${entry.shardSpec}`);
    const onTimeout = () => {
      // eslint-disable-next-line no-console
      console.error(`[vitest] shard ${entry.shardSpec} timed out after ${shardTimeoutMs}ms; terminating its process tree`);
    };
    if (shardConcurrency <= 1) {
      return {
        promise: spawnVitestRun({
          vitestCommand,
          configPath,
          env: vitestEnv,
          passthroughArgs: shardPassthroughArgs,
          positionalFilters,
          files: entry.files,
          timeoutMs: shardTimeoutMs,
          onTimeout,
        }),
        cancel: async () => {},
      };
    }

    return startVitestRun({
      vitestCommand,
      configPath,
      env: vitestEnv,
      passthroughArgs: shardPassthroughArgs,
      positionalFilters,
      files: entry.files,
      timeoutMs: shardTimeoutMs,
      onTimeout,
    });
  };

  const result = await runVitestShardRunPlan({
    plan,
    concurrency: shardConcurrency,
    startShard,
  });

  const summary = summarizeVitestShardOutcomes({ shardCount: plan.length, outcomes: result.outcomes });
  for (const line of summary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (summary.exitCode !== 0) {
    process.exit(summary.exitCode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
