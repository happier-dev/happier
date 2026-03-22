import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { buildPiToolsForPermissionMode, createPiBackend } from './backend';

const envKeys = ['PATH', 'HAPPIER_PI_PATH'] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-pi-backend-');
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

describe('pi backend argv', () => {
  it('fails closed when the Pi CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;

    expect(() => createPiBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it('adds --thinking when HAPPIER_PI_THINKING_LEVEL is set', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'high' },
      permissionMode: 'default',
    });

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
  });

  it('ignores invalid thinking levels', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const backend = createPiBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'definitely-not-valid' },
      permissionMode: 'default',
    });

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain('--thinking');
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;
    const binPath = createFakeBin('pi');

    const backend = createPiBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
      permissionMode: 'default',
    }) as unknown as { options?: { command?: string } };

    expect(backend.options?.command).toBe(binPath);
  });
});

describe('buildPiToolsForPermissionMode', () => {
  it.each([
    { mode: 'plan', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'read-only', expected: ['read', 'grep', 'find', 'ls'] },
    { mode: 'default', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'safe-yolo', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'acceptEdits', expected: ['read', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'yolo', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
    { mode: 'bypassPermissions', expected: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] },
  ] as const)('maps $mode to tools list', ({ mode, expected }) => {
    expect(buildPiToolsForPermissionMode(mode)).toEqual(expected);
  });
});
