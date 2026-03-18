#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_SHARDS);
  return override ?? 8;
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function spawnVitestRun({ configPath, shardSpec, nodeOptions }) {
  return new Promise((resolve) => {
    const proc = spawn(
      'vitest',
      ['run', '--config', configPath, '--shard', shardSpec],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
        },
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );

    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main(argv) {
  const configPath = resolveVitestConfigPath(argv);
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/runVitestShards.mjs --config <vitest.config.ts>');
    process.exit(1);
  }

  const shardCount = resolveVitestShardCount(process.env);
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);

  for (let index = 1; index <= shardCount; index += 1) {
    // eslint-disable-next-line no-console
    console.log(`[vitest] shard ${index}/${shardCount}`);
    const shardSpec = `${index}/${shardCount}`;
    const result = await spawnVitestRun({ configPath, shardSpec, nodeOptions });
    if (result.signal) {
      process.kill(process.pid, result.signal);
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
