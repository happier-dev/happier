import { afterEach, describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

const envKeys = ['PATH', 'HAPPIER_GEMINI_PATH'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

function createFakeBin(name: string): string {
  const dir = createTempDirSync('happier-gemini-backend-');
  tempDirs.add(dir);
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
  for (const dir of tempDirs) removeTempDirSync(dir);
  tempDirs.clear();
});

function getBackendArgsForMode(params: { permissionMode: PermissionMode; env?: Record<string, string> }): string[] {
  process.env.PATH = '';
  process.env.HAPPIER_GEMINI_PATH = createFakeBin('gemini');
  const result = createGeminiBackend({
    cwd: '/tmp',
    env: params.env ?? {},
    permissionMode: params.permissionMode,
    // Keep tests isolated from local config model overrides.
    model: null,
  });

  const backend = result.backend as unknown as AcpBackendLike;
  return backend.options.args;
}

function readFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

describe('Gemini ACP backend permissions', () => {
  it('fails closed when the Gemini CLI is unavailable', () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    expect(() => createGeminiBackend({ cwd: '/tmp', env: {}, model: null })).toThrow(/system install/i);
  });

  it.each([
    { mode: 'acceptEdits', approvalMode: 'auto_edit', sandbox: false },
    { mode: 'plan', approvalMode: 'plan', sandbox: false },
    { mode: 'safe-yolo', approvalMode: 'auto_edit', sandbox: false },
    { mode: 'yolo', approvalMode: 'yolo', sandbox: false },
    { mode: 'bypassPermissions', approvalMode: 'yolo', sandbox: false },
  ])(
    'maps permissionMode=$mode to --approval-mode $approvalMode and sandbox=$sandbox',
    ({ mode, approvalMode, sandbox }) => {
      const args = getBackendArgsForMode({ permissionMode: mode as PermissionMode });
      expect(args[0]).toBe('--acp');
      expect(readFlagValue(args, '--approval-mode')).toBe(approvalMode);
      expect(args.includes('--sandbox')).toBe(sandbox);
    },
  );

  it.each([
    { mode: 'default' },
    // 'read-only' also maps to the Gemini "default" approval mode internally.
    { mode: 'read-only' },
  ])(
    'omits --approval-mode for permissionMode=$mode so the Gemini CLI honors settings.json tools.approvalMode',
    ({ mode }) => {
      const args = getBackendArgsForMode({ permissionMode: mode as PermissionMode });
      expect(args[0]).toBe('--acp');
      expect(args).not.toContain('--approval-mode');
    },
  );

  it('enables --sandbox when HAPPIER_GEMINI_USE_SANDBOX is truthy', () => {
    const args = getBackendArgsForMode({
      permissionMode: 'default',
      env: {
        HAPPIER_GEMINI_USE_SANDBOX: 'true',
      },
    });
    expect(args.includes('--sandbox')).toBe(true);
  });
});
