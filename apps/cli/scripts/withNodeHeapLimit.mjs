#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

function main(argv) {
  const command = argv[2];
  const args = argv.slice(3);
  if (!command) {
    console.error('Usage: node scripts/withNodeHeapLimit.mjs <command> [...args]');
    process.exit(1);
  }

  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nextNodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);

  const proc = spawn(command, args, {
    env: {
      ...process.env,
      NODE_OPTIONS: nextNodeOptions,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  proc.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
