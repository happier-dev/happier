import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { createQwenBackend } from './backend';

type AcpBackendLike = {
  options: {
    args: string[];
  };
};

function readArgs(permissionMode: PermissionMode | undefined): string[] {
  const backend = createQwenBackend({
    cwd: '/tmp',
    env: {},
    permissionMode,
  }) as unknown as AcpBackendLike;
  return backend.options.args;
}

describe('Qwen ACP backend permissions', () => {
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
});
