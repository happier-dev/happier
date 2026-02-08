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
      setPermissionMode: (mode: PermissionMode) => calls.push(String(mode)),
    };

    const effective = applyPermissionModeToCodexPermissionHandler({
      permissionHandler: handler,
      permissionMode: raw as PermissionMode | null | undefined,
    });

    expect(effective).toBe(expected);
    expect(calls).toEqual([expected]);
  });
});
