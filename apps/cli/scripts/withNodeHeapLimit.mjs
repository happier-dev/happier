#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { resolveSignalExitCode, runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

const HEAP_LIMIT_REGEX = /(^|\s)--max-old-space-size(=|\s)\d+(\s|$)/;

export function hasMaxOldSpaceSize(nodeOptions) {
  return HEAP_LIMIT_REGEX.test(String(nodeOptions ?? ''));
}

export function upsertMaxOldSpaceSize(nodeOptions, sizeMb) {
  const base = String(nodeOptions ?? '').trim();
  const desired = `--max-old-space-size=${sizeMb}`;
  if (!base) return desired;
  if (hasMaxOldSpaceSize(base)) return base;
  return `${base} ${desired}`.trim();
}

export function resolveMaxOldSpaceSizeMb(env) {
  const raw = String(env?.HAPPIER_CLI_TEST_MAX_OLD_SPACE_SIZE_MB ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 8192;
}

async function main(argv) {
  const command = argv[2];
  const args = argv.slice(3);
  if (!command) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/withNodeHeapLimit.mjs <command> [...args]');
    process.exit(1);
  }

  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nextNodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);

  const result = await runManagedChildCommand({
    command,
    args,
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nextNodeOptions,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
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
    return;
  }
  process.exit(result.code ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv);
}
