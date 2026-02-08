import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

function getBackendArgsForMode(permissionMode: PermissionMode): string[] {
  const result = createGeminiBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
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
    { mode: 'default', approvalMode: 'default', sandbox: true },
    { mode: 'acceptEdits', approvalMode: 'auto-edit', sandbox: true },
    { mode: 'plan', approvalMode: 'default', sandbox: true },
    { mode: 'read-only', approvalMode: 'default', sandbox: true },
    { mode: 'safe-yolo', approvalMode: 'auto-edit', sandbox: true },
    { mode: 'yolo', approvalMode: 'yolo', sandbox: false },
    { mode: 'bypassPermissions', approvalMode: 'yolo', sandbox: false },
  ])(
    'maps permissionMode=$mode to --approval-mode $approvalMode and sandbox=$sandbox',
    ({ mode, approvalMode, sandbox }) => {
      const args = getBackendArgsForMode(mode as PermissionMode);
      expect(args[0]).toBe('--experimental-acp');
      expect(readFlagValue(args, '--approval-mode')).toBe(approvalMode);
      expect(args.includes('--sandbox')).toBe(sandbox);
    },
  );
});
