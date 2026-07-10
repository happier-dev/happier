import { describe, expect, it } from 'vitest';

import {
  assertNonEscalatingPermissionMode,
  resolveNearestPermissionModeAtOrBelow,
  resolvePermissionPrivilegeOrdinal,
} from './privilege.js';

describe('permission privilege policy', () => {
  it('maps canonical runtime and execution-run aliases onto privilege ordinals', () => {
    expect(resolvePermissionPrivilegeOrdinal('plan')).toBe(0);
    expect(resolvePermissionPrivilegeOrdinal('read-only')).toBe(0);
    expect(resolvePermissionPrivilegeOrdinal('read_only')).toBe(0);
    expect(resolvePermissionPrivilegeOrdinal('no_tools')).toBe(0);
    expect(resolvePermissionPrivilegeOrdinal('default')).toBe(1);
    expect(resolvePermissionPrivilegeOrdinal('acceptEdits')).toBe(2);
    expect(resolvePermissionPrivilegeOrdinal('safe-yolo')).toBe(2);
    expect(resolvePermissionPrivilegeOrdinal('workspace_write')).toBe(2);
    expect(resolvePermissionPrivilegeOrdinal('bypassPermissions')).toBe(3);
    expect(resolvePermissionPrivilegeOrdinal('yolo')).toBe(3);
  });

  it('rejects explicit requests above the caller permission ordinal', () => {
    expect(assertNonEscalatingPermissionMode({
      requestedMode: 'workspace_write',
      callerMode: 'default',
    })).toEqual(expect.objectContaining({
      ok: false,
      reason: 'permission_escalation_denied',
      requestedOrdinal: 2,
      callerOrdinal: 1,
    }));
  });

  it('inherits the nearest supported same-or-lower mode when permission is omitted', () => {
    expect(resolveNearestPermissionModeAtOrBelow({
      requestedMode: undefined,
      callerMode: 'safe-yolo',
      supportedModes: ['read_only', 'default', 'workspace_write'],
    })).toEqual(expect.objectContaining({
      ok: true,
      requestedMode: 'workspace_write',
      requestedOrdinal: 2,
      callerOrdinal: 2,
    }));
  });
});
