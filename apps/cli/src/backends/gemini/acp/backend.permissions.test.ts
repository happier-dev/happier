import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

function getBackendArgsForMode(params: { permissionMode: PermissionMode; env?: Record<string, string> }): string[] {
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
  it.each([
    { mode: 'default', approvalMode: 'default', sandbox: false },
    { mode: 'acceptEdits', approvalMode: 'auto_edit', sandbox: false },
    { mode: 'plan', approvalMode: 'plan', sandbox: false },
    { mode: 'read-only', approvalMode: 'default', sandbox: false },
    { mode: 'safe-yolo', approvalMode: 'auto_edit', sandbox: false },
    { mode: 'yolo', approvalMode: 'yolo', sandbox: false },
    { mode: 'bypassPermissions', approvalMode: 'yolo', sandbox: false },
  ])(
    'maps permissionMode=$mode to --approval-mode $approvalMode and sandbox=$sandbox',
    ({ mode, approvalMode, sandbox }) => {
      const args = getBackendArgsForMode({ permissionMode: mode as PermissionMode });
      expect(args[0]).toBe('--experimental-acp');
      expect(readFlagValue(args, '--approval-mode')).toBe(approvalMode);
      expect(args.includes('--sandbox')).toBe(sandbox);
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
