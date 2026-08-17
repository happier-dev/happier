import { describe, expect, it } from 'vitest';

import { resolveEffectivePermissionMode } from './permissionPrivilege.js';

describe('resolveEffectivePermissionMode', () => {
  it('clamps a broader mutable mode to the admitted causal ceiling before a handler can branch', () => {
    expect(resolveEffectivePermissionMode({
      currentMode: 'yolo',
      admittedPermissionCeiling: 'default',
      supportedModes: ['plan', 'read-only', 'default', 'safe-yolo', 'yolo'],
    })).toEqual({
      ok: true,
      currentMode: 'yolo',
      admittedPermissionCeiling: 'default',
      effectiveMode: 'default',
      currentOrdinal: 3,
      admittedCeilingOrdinal: 1,
      effectiveOrdinal: 1,
    });
  });

  it('uses the exact admitted mode instead of a same-ordinal provider alias', () => {
    expect(resolveEffectivePermissionMode({
      currentMode: 'acceptEdits',
      admittedPermissionCeiling: 'safe-yolo',
      supportedModes: ['default', 'acceptEdits', 'safe-yolo', 'yolo'],
    })).toEqual(expect.objectContaining({
      ok: true,
      currentMode: 'acceptEdits',
      effectiveMode: 'safe-yolo',
      effectiveOrdinal: 2,
    }));
  });

  it.each([
    ['plan', 'read-only', 0],
    ['read-only', 'plan', 0],
    ['acceptEdits', 'safe-yolo', 2],
    ['bypassPermissions', 'yolo', 3],
  ] as const)('does not ordinal-alias %s with the exact admitted %s ceiling', (currentMode, admittedPermissionCeiling, effectiveOrdinal) => {
    expect(resolveEffectivePermissionMode({
      currentMode,
      admittedPermissionCeiling,
      supportedModes: ['plan', 'read-only', 'default', 'acceptEdits', 'safe-yolo', 'bypassPermissions', 'yolo'],
    })).toEqual(expect.objectContaining({
      ok: true,
      effectiveMode: admittedPermissionCeiling,
      effectiveOrdinal,
    }));
  });

  it('selects the nearest strictly narrower supported mode when the exact causal ceiling is unavailable', () => {
    expect(resolveEffectivePermissionMode({
      currentMode: 'bypassPermissions',
      admittedPermissionCeiling: 'safe-yolo',
      supportedModes: ['read-only', 'default', 'acceptEdits'],
    })).toEqual(expect.objectContaining({
      ok: true,
      effectiveMode: 'default',
      effectiveOrdinal: 1,
    }));
  });

  it.each([
    [undefined, 'admitted_permission_ceiling_missing'],
    ['not-a-permission-intent', 'admitted_permission_ceiling_invalid'],
  ] as const)('fails closed when admitted causal authority is %s', (admittedPermissionCeiling, reason) => {
    expect(resolveEffectivePermissionMode({
      currentMode: 'yolo',
      admittedPermissionCeiling,
    })).toEqual({ ok: false, reason });
  });
});
