import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildPiToolsForPermissionMode, createPiBackend } from './backend';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_PI_PATH: process.env.HAPPIER_PI_PATH,
};

const TEMP_DIRS = new Set<string>();

function createFakeBin(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'happier-pi-backend-'));
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
  if (ORIGINAL_ENV.HAPPIER_PI_PATH === undefined) delete process.env.HAPPIER_PI_PATH;
  else process.env.HAPPIER_PI_PATH = ORIGINAL_ENV.HAPPIER_PI_PATH;
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
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
