import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PermissionMode } from '@/api/types';
import { createQwenBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_QWEN_PATH: process.env.HAPPIER_QWEN_PATH,
};

const TEMP_DIRS = new Set<string>();

function createFakeBin(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-qwen-backend-'));
  TEMP_DIRS.add(dir);
  const isWindows = process.platform === 'win32';
  const binPath = join(dir, isWindows ? `${name}.cmd` : name);
  writeFileSync(binPath, isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) chmodSync(binPath, 0o755);
  return binPath;
}

afterEach(() => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_QWEN_PATH === undefined) delete process.env.HAPPIER_QWEN_PATH;
  else process.env.HAPPIER_QWEN_PATH = ORIGINAL_ENV.HAPPIER_QWEN_PATH;
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.clear();
});

function readArgs(permissionMode: PermissionMode | undefined): string[] {
  process.env.PATH = '';
  process.env.HAPPIER_QWEN_PATH = createFakeBin('qwen');
  const backend = createQwenBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;
  return backend.options.args;
}

describe('Qwen ACP backend permissions', () => {
  it('fails closed when the Qwen CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_QWEN_PATH;

    expect(() => createQwenBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it.each([
    { mode: undefined, expected: 'default' },
    { mode: 'default', expected: 'default' },
    { mode: 'read-only', expected: 'plan' },
    { mode: 'plan', expected: 'plan' },
    { mode: 'safe-yolo', expected: 'auto-edit' },
    { mode: 'yolo', expected: 'yolo' },
    { mode: 'bypassPermissions', expected: 'yolo' },
  ])('maps permissionMode="$mode" to --approval-mode "$expected"', ({ mode, expected }) => {
    const args = readArgs(mode as PermissionMode | undefined);
    expect(args[0]).toBe('--acp');
    expect(args).toContain('--approval-mode');
    const modeFlagIndex = args.indexOf('--approval-mode');
    expect(modeFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[modeFlagIndex + 1]).toBe(expected);
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_QWEN_PATH;
    const binPath = createFakeBin('qwen');

    const backend = createQwenBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
      permissionMode: 'default',
    }) as unknown as { options: { command: string } };

    expect(backend.options.command).toBe(binPath);
  });
});
