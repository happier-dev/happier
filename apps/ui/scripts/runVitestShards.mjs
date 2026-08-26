#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createManagedChildLifecycle,
  resolveSignalExitCode,
  runManagedChildCommand,
} from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import {
  parseVitestListJson,
  shouldVitestShardRunProceedWithoutFiles,
} from '../../../scripts/testing/vitestShardCollection.mjs';
import {
  classifyVitestShardTermination,
  summarizeVitestShardOutcomes,
} from '../../../scripts/testing/vitestShardOutcomes.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

export {
  classifyVitestShardTermination,
  shouldVitestShardRunProceedWithoutFiles,
  summarizeVitestShardOutcomes,
};

const require = createRequire(import.meta.url);
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

export function resolveVitestShardCount(env) {
  const override = parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARDS);
  // The UI suite has a large module graph (React Native stubs + Expo/web shims).
  // Running too many files in a single Vitest process can cause heap growth over time,
  // even with `isolate: true`. More shards keeps each process smaller and avoids OOMs.
  return override ?? 32;
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
  return parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARD_TIMEOUT_MS) ?? 900_000;
}

export function resolveVitestShardConcurrency(env, argv) {
  const flagOverride = parsePositiveInt(resolveConcurrencyFlagValue(argv));
  if (flagOverride) return flagOverride;

  const envOverride = parsePositiveInt(env?.HAPPIER_UI_VITEST_SHARD_CONCURRENCY);
  return envOverride ?? 1;
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
 * the same files (32x by default) instead of once. The shard file list is already the
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
    '--no-file-parallelism',
    ...optionArgs,
    ...(files ?? []),
  ];
}

export function partitionVitestFilesIntoShards(files, shardCount) {
  const count = Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const buckets = Array.from({ length: count }, () => []);
  const sortedFiles = Array.from(files ?? []).filter(Boolean).sort();

  const total = sortedFiles.length;
  const baseSize = Math.floor(total / count);
  const extra = total % count;
  let cursor = 0;
  for (let bucketIndex = 0; bucketIndex < count; bucketIndex += 1) {
    const size = baseSize + (bucketIndex < extra ? 1 : 0);
    if (size <= 0) continue;
    buckets[bucketIndex].push(...sortedFiles.slice(cursor, cursor + size));
    cursor += size;
  }
  return buckets;
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

function resolveVitestNodeCommand() {
  return {
    command: process.execPath,
    argsPrefix: [
      require.resolve('vitest/vitest.mjs', {
        paths: [packageRoot],
      }),
    ],
  };
}

async function resolveVitestTestFiles({ vitestCommand, configPath, nodeOptions, passthroughArgs }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-ui-vitest-list-'));
  const jsonPath = path.join(tmpDir, 'vitest-files.json');

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
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });

  if (!result.ok) {
    throw result.error;
  }

  if (result.signal) {
    process.exit(resolveSignalExitCode(result.signal));
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

function spawnVitestRun({ vitestCommand, configPath, nodeOptions, passthroughArgs, positionalFilters, files, timeoutMs }) {
  return runManagedChildCommand({
    command: vitestCommand.command,
    args: [
      ...vitestCommand.argsPrefix,
      ...buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }),
    ],
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    maxRuntimeMs: timeoutMs,
  });
}

function startVitestRun({ vitestCommand, configPath, nodeOptions, passthroughArgs, positionalFilters, files, timeoutMs }) {
  const child = spawn(
    vitestCommand.command,
    [
      ...vitestCommand.argsPrefix,
      ...buildVitestShardRunArgs({ configPath, passthroughArgs, positionalFilters, files }),
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    },
  );

  const lifecycle = createManagedChildLifecycle(child, {
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void lifecycle.cleanupChild('SIGTERM');
  }, timeoutMs);
  timeout.unref?.();

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
        signal,
        timedOut,
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

  const shardCount = resolveVitestShardCount(process.env);
  const shardRange = resolveVitestShardRange(process.env, shardCount);
  const shardConcurrency = resolveVitestShardConcurrency(process.env, argv);
  const shardTimeoutMs = resolveVitestShardTimeoutMs(process.env);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const passthroughArgs = resolveVitestPassthroughArgs(argv);
  // The list pass keeps the caller's filters (they are what selects the files); the shard runs
  // drop exactly those filters, because the resolved file list already carries them.
  const positionalFilters = await resolveVitestPositionalFilters(passthroughArgs);
  const vitestCommand = resolveVitestNodeCommand();

  const allFiles = await resolveVitestTestFiles({ vitestCommand, configPath, nodeOptions, passthroughArgs });
  if (!shouldVitestShardRunProceedWithoutFiles({ fileCount: allFiles.length, passthroughArgs })) {
    // `vitest run` itself exits non-zero when a filter matches nothing. Sharding must not be
    // more permissive than the tool it wraps: a mistyped path filter that silently exits 0 is
    // the same vacuous green as a skipped shard.
    // eslint-disable-next-line no-console
    console.error('[vitest] no test files matched — refusing to report a sharded run as green');
    process.exit(1);
    return;
  }
  const shardFiles = partitionVitestFilesIntoShards(allFiles, shardCount);
  const plan = createVitestShardRunPlan({
    shardFiles,
    shardCount,
    startShard: shardRange.start,
    endShard: shardRange.end,
  });

  const startShard = (entry) => {
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${entry.shardSpec}`);
    if (shardConcurrency <= 1) {
      return {
        promise: spawnVitestRun({
          vitestCommand,
          configPath,
          nodeOptions,
          passthroughArgs,
          positionalFilters,
          files: entry.files,
          timeoutMs: shardTimeoutMs,
        }),
        cancel: async () => {},
      };
    }

    return startVitestRun({
      vitestCommand,
      configPath,
      nodeOptions,
      passthroughArgs,
      positionalFilters,
      files: entry.files,
      timeoutMs: shardTimeoutMs,
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
