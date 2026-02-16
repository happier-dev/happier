import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import { applyPermissionModeToCodexPermissionHandler } from './applyPermissionModeToHandler';

describe('applyPermissionModeToCodexPermissionHandler', () => {
  it.each([
    { raw: 'bypassPermissions', expected: 'yolo' },
    { raw: 'safe-yolo', expected: 'safe-yolo' },
    { raw: 'read-only', expected: 'read-only' },
    { raw: 'default', expected: 'default' },
    { raw: null, expected: 'default' },
    { raw: undefined, expected: 'default' },
    { raw: 'definitely-unknown', expected: 'default' },
  ])('normalizes "$raw" to "$expected" and updates the handler', ({ raw, expected }) => {
    const calls: string[] = [];
    const handler = {
      setPermissionMode: (mode: PermissionMode, updatedAt?: number) =>
        calls.push(`${String(mode)}:${typeof updatedAt === 'number' ? updatedAt : 'none'}`),
    };

    const effective = applyPermissionModeToCodexPermissionHandler({
      permissionHandler: handler,
      permissionMode: raw as PermissionMode | null | undefined,
    });

    expect(effective).toBe(expected);
    expect(calls).toEqual([`${expected}:none`]);
  });

  it('passes through permissionModeUpdatedAt when provided', () => {
    const calls: Array<{ mode: string; updatedAt?: number }> = [];
    const handler = {
      setPermissionMode: (mode: PermissionMode, updatedAt?: number) => calls.push({ mode: String(mode), updatedAt }),
    };

    applyPermissionModeToCodexPermissionHandler({
      permissionHandler: handler,
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1234,
    });

    expect(calls).toEqual([{ mode: 'read-only', updatedAt: 1234 }]);
  });
});
