import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import type { PermissionMode } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createQwenBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

const envKeys = ['PATH', 'HAPPIER_QWEN_PATH'] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-qwen-backend-');
  TEMP_DIRS.add(dir);
  const isWindows = process.platform === 'win32';
  return writeExecutableShimSync({
    dir,
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
}

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) removeTempDirSync(dir);
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
