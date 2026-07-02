import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createPiRpcBackend } from './backend';

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

describe('pi rpc backend argv', () => {
  it('fails closed when the Pi CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;

    expect(() => createPiRpcBackend({ cwd: '/tmp', env: {} })).toThrow(/system install/i);
  });

  it('adds --thinking when HAPPIER_PI_THINKING_LEVEL is set', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');
    const backend = createPiRpcBackend({
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
    const backend = createPiRpcBackend({
      cwd: '/tmp',
      env: { HAPPIER_PI_THINKING_LEVEL: 'definitely-not-valid' },
      permissionMode: 'default',
    });

    const args = (backend as any).options?.args as string[] | undefined;
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain('--thinking');
  });

  it('passes the Happier session id into the Pi RPC backend options', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiRpcBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
    }) as unknown as { options?: { happierSessionId?: string | null } };

    expect(backend.options?.happierSessionId).toBe('happy-session-1');
  });

  it('resolves the CLI from options.env PATH when process PATH is empty', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_PI_PATH;
    const binPath = createFakeBin('pi');

    const backend = createPiRpcBackend({
      cwd: '/tmp',
      env: { PATH: dirname(binPath) },
      permissionMode: 'default',
    }) as unknown as { options?: { command?: string } };

    expect(backend.options?.command).toBe(binPath);
  });

  it('exposes native execution-run host-runtime methods on the Pi RPC backend leaf', () => {
    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = createFakeBin('pi');

    const backend = createPiRpcBackend({
      cwd: '/tmp',
      env: {},
      permissionMode: 'default',
    }) as unknown as {
      readResumeSupport?: unknown;
      provisionSession?: unknown;
      subscribeMessages?: unknown;
      waitForTurnCompletion?: unknown;
    };

    expect(backend.readResumeSupport).toBeTypeOf('function');
    expect(backend.provisionSession).toBeTypeOf('function');
    expect(backend.subscribeMessages).toBeTypeOf('function');
    expect(backend.waitForTurnCompletion).toBeTypeOf('function');
  });
});
