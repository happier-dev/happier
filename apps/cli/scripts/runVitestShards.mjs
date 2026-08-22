#!/usr/bin/env node
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveSignalExitCode, runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
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

  for (let index = 1; index <= shardCount; index += 1) {
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${index}/${shardCount}`);
    const shardSpec = `${index}/${shardCount}`;
    const result = await spawnVitest({
      args: [
        'run',
        '--config',
        configPath,
        '--shard',
        shardSpec,
        ...isolationPlan.shardExcludes.flatMap((exclude) => ['--exclude', exclude]),
      ],
      nodeOptions,
    });
    if (!result.ok) {
      throw result.error;
    }
    if (result.signal) {
      process.exit(resolveSignalExitCode(result.signal));
      return;
    }
    if (result.code && result.code !== 0) {
      process.exit(result.code);
    }
  }

  for (const isolatedRun of isolationPlan.runs) {
    // eslint-disable-next-line no-console
    console.log(`[vitest] isolated ${isolatedRun.file} (${isolatedRun.testNamePattern})`);
    const result = await spawnVitest({
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
    if (!result.ok) {
      throw result.error;
    }
    if (result.signal) {
      process.exit(resolveSignalExitCode(result.signal));
      return;
    }
    if (result.code && result.code !== 0) {
      process.exit(result.code);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
