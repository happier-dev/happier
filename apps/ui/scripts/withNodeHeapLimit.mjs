#!/usr/bin/env node
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { resolveSignalExitCode, runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

const HEAP_LIMIT_REGEX = /(^|\s)--max-old-space-size(=|\s)\d+(\s|$)/;
const BASELINE_MAX_OLD_SPACE_SIZE_MB = 8192;
// UI unit tests can legitimately use a lot of memory (large React trees + module graphs).
// Keep the default heuristic proportional to total memory, but cap it low enough to avoid
// the UI test worker ballooning into multi-tens-of-gigabytes heaps on very large machines.
const HIGH_MEMORY_MAX_OLD_SPACE_SIZE_MB = 24_576;

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

function resolveRecommendedMaxOldSpaceSizeMb(totalMemoryBytes) {
  const totalMemoryMb = Math.floor(Number(totalMemoryBytes ?? 0) / (1024 * 1024));
  if (!Number.isFinite(totalMemoryMb) || totalMemoryMb <= 0) {
    return BASELINE_MAX_OLD_SPACE_SIZE_MB;
  }

  return Math.min(
    HIGH_MEMORY_MAX_OLD_SPACE_SIZE_MB,
    Math.max(BASELINE_MAX_OLD_SPACE_SIZE_MB, Math.floor(totalMemoryMb / 3)),
  );
}

export function resolveMaxOldSpaceSizeMb(env, totalMemoryBytes = os.totalmem()) {
  const raw = String(env?.HAPPIER_UI_TEST_MAX_OLD_SPACE_SIZE_MB ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : resolveRecommendedMaxOldSpaceSizeMb(totalMemoryBytes);
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
