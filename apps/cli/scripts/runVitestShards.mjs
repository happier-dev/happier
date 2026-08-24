#!/usr/bin/env node
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import {
  classifyVitestShardTermination,
  summarizeVitestShardOutcomes,
} from '../../../scripts/testing/vitestShardOutcomes.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env, configPath = null) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_SHARDS);
  if (override !== null) return override;
  return typeof configPath === 'string' && basename(configPath) === 'vitest.config.ts' ? 64 : 8;
}

export function resolveVitestIsolationPlan(configPath) {
  if (typeof configPath !== 'string' || basename(configPath) !== 'vitest.config.ts') {
    return { shardExcludes: [], runs: [] };
  }
  const file = 'src/daemon/service/cli.test.ts';
  return {
    shardExcludes: [file],
    runs: [
      { file, testNamePattern: 'runDaemonServiceCliCommand (?:allows|expands|prefers|resolves|restarts|restores|sets|treats)\\b' },
      { file, testNamePattern: 'runDaemonServiceCliCommand (?:defaults|fails|plans|refreshes|reports|stops|supports|uses)\\b' },
      { file, testNamePattern: 'runDaemonServiceCliCommand (?:builds|includes|keeps|passes|rejects|respects|scopes|uninstalls)\\b' },
    ],
  };
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function spawnVitest({ args, nodeOptions }) {
  return runManagedChildCommand({
    command: 'vitest',
    args,
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });
}

export async function runCliVitestShardRuns({ shardCount, runShard }) {
  const outcomes = [];
  let aborted = false;

  for (let shard = 1; shard <= shardCount; shard += 1) {
    if (aborted) {
      outcomes.push({ outcome: 'unexecuted', shard, fileCount: 1, exitCode: null, signal: null });
      continue;
    }

    const result = await runShard({ shard });
    if (!result.ok) throw result.error;
    const termination = classifyVitestShardTermination(result);
    outcomes.push({ ...termination, shard, fileCount: 1 });
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

  const shardCount = resolveVitestShardCount(process.env, configPath);
  const isolationPlan = resolveVitestIsolationPlan(configPath);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);

  const shardOutcomes = await runCliVitestShardRuns({
    shardCount,
    runShard: ({ shard }) => {
      // eslint-disable-next-line no-console
      console.log(`[vitest] shard ${shard}/${shardCount}`);
      return spawnVitest({
        args: [
          'run',
          '--config',
          configPath,
          '--shard',
          `${shard}/${shardCount}`,
          ...isolationPlan.shardExcludes.flatMap((exclude) => ['--exclude', exclude]),
        ],
        nodeOptions,
      });
    },
  });
  const shardSummary = summarizeVitestShardOutcomes({ shardCount, outcomes: shardOutcomes });
  for (const line of shardSummary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (shardSummary.abortedShard) {
    process.exit(shardSummary.exitCode);
    return;
  }

  const isolatedOutcomes = await runCliVitestShardRuns({
    shardCount: isolationPlan.runs.length,
    runShard: ({ shard }) => {
      const isolatedRun = isolationPlan.runs[shard - 1];
      // eslint-disable-next-line no-console
      console.log(`[vitest] isolated ${isolatedRun.file} (${isolatedRun.testNamePattern})`);
      return spawnVitest({
        args: [
          'run',
          '--config',
          configPath,
          isolatedRun.file,
          '--testNamePattern',
          isolatedRun.testNamePattern,
        ],
        nodeOptions,
      });
    },
  });
  const isolatedSummary = summarizeVitestShardOutcomes({
    shardCount: isolationPlan.runs.length,
    outcomes: isolatedOutcomes,
    unitLabel: 'isolated run',
  });
  for (const line of isolatedSummary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  const exitCode = shardSummary.exitCode || isolatedSummary.exitCode;
  if (exitCode !== 0) process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
