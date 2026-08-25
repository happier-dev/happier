#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import {
  parseVitestListJson,
  shouldVitestShardRunProceedWithoutFiles,
} from '../../../scripts/testing/vitestShardCollection.mjs';
import {
  classifyVitestShardTermination,
  summarizeVitestShardOutcomes,
} from '../../../scripts/testing/vitestShardOutcomes.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_SHARDS);
  return override ?? 8;
}

export function resolveVitestShardRange(env, shardCount) {
  const part = parsePositiveInt(env?.HAPPIER_CLI_VITEST_PART);
  const parts = parsePositiveInt(env?.HAPPIER_CLI_VITEST_PARTS);
  if (part === null || parts === null || part > parts || parts > shardCount) {
    return { start: 1, end: shardCount, part: 1, parts: 1 };
  }
  const start = Math.floor(((part - 1) * shardCount) / parts) + 1;
  const end = Math.floor((part * shardCount) / parts);
  return { start, end, part, parts };
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveVitestForwardArgs(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return [];
  const valueIndex = idx + 1;
  if (valueIndex >= argv.length) return [];
  return argv.slice(valueIndex + 1);
}

/**
 * `--shard N/M` legitimately produces empty shards, so the shard runner asks
 * for `--passWithNoTests` here rather than the lane config setting it. Keeping
 * it out of the config means a directly invoked selected pattern that collects
 * nothing still fails instead of exiting green.
 */
export function buildVitestShardArgs({ configPath, shardSpec, vitestArgs }) {
  return [
    'run',
    '--config',
    configPath,
    ...(vitestArgs ?? []),
    '--passWithNoTests',
    '--shard',
    shardSpec,
  ];
}

/**
 * The lane collection pass. It reuses the shard runs' own config and caller filters so
 * the count it reports is the one the shards will split.
 */
export function buildVitestListArgs({ configPath, vitestArgs, jsonPath }) {
  return [
    'list',
    '--config',
    configPath,
    ...(vitestArgs ?? []),
    '--filesOnly',
    '--json',
    jsonPath,
  ];
}

async function listVitestLaneTestFiles({ configPath, nodeOptions, vitestArgs }) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-cli-vitest-list-'));
  const jsonPath = path.join(tmpDir, 'vitest-files.json');
  try {
    const result = await runManagedChildCommand({
      command: 'vitest',
      args: buildVitestListArgs({ configPath, vitestArgs, jsonPath }),
      spawnOptions: {
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
        stdio: 'inherit',
      },
      cleanupPollMs: 25,
      signalCleanupGraceMs: 0,
      exitCleanupGraceMs: 1_000,
      parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
    });
    if (!result.ok) throw result.error;
    return parseVitestListJson(await fs.readFile(jsonPath, 'utf8'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Every shard run asks for `--passWithNoTests` because `--shard N/M` legitimately
 * produces empty shards. That per-shard tolerance must not become lane tolerance:
 * without this pass a lane whose config or filter collects nothing reports every
 * shard green and exits 0, which is the same vacuous green a skipped lane gives.
 */
export async function resolveCliVitestLaneAdmission({
  configPath,
  nodeOptions,
  vitestArgs,
  listTestFiles = listVitestLaneTestFiles,
}) {
  const files = await listTestFiles({ configPath, nodeOptions, vitestArgs });
  const fileCount = Array.isArray(files) ? files.length : 0;
  return {
    fileCount,
    admitted: shouldVitestShardRunProceedWithoutFiles({
      fileCount,
      passthroughArgs: vitestArgs ?? [],
    }),
  };
}

function spawnVitestRun({ configPath, shardSpec, nodeOptions, vitestArgs }) {
  return runManagedChildCommand({
    command: 'vitest',
    args: buildVitestShardArgs({ configPath, shardSpec, vitestArgs }),
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
}

export async function runCliVitestShardRuns({ shardCount, startShard = 1, endShard = shardCount, runShard }) {
  const outcomes = [];
  let aborted = false;

  for (let shard = startShard; shard <= endShard; shard += 1) {
    const shardSpec = `${shard}/${shardCount}`;
    if (aborted) break;

    const result = await runShard({ shard, shardSpec });
    if (!result.ok) throw result.error;
    const termination = classifyVitestShardTermination(result);
    outcomes.push({ ...termination, shardSpec });
    aborted = termination.outcome === 'aborted';
  }

  return outcomes;
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
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);
  const vitestArgs = resolveVitestForwardArgs(argv);

  const admission = await resolveCliVitestLaneAdmission({ configPath, nodeOptions, vitestArgs });
  if (!admission.admitted) {
    // eslint-disable-next-line no-console
    console.error('[vitest] no test files matched — refusing to report a sharded run as green');
    process.exit(1);
    return;
  }

  const outcomes = await runCliVitestShardRuns({
    shardCount,
    startShard: shardRange.start,
    endShard: shardRange.end,
    runShard: ({ shardSpec }) => {
      // eslint-disable-next-line no-console
      console.log(`[vitest] shard ${shardSpec}`);
      return spawnVitestRun({ configPath, shardSpec, nodeOptions, vitestArgs });
    },
  });
  const summary = summarizeVitestShardOutcomes({ shardCount, outcomes });
  for (const line of summary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (summary.exitCode !== 0) process.exit(summary.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
