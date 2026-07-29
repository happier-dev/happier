import { describe, expect, it } from 'vitest';

import { normalizeSessionControlPermissionModeForBackendTarget } from './permissionModes';

describe('backend target permission modes', () => {
  it('normalizes built-in provider permission aliases through catalog entries', () => {
    expect(normalizeSessionControlPermissionModeForBackendTarget({
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      permissionMode: 'safe-yolo',
    })).toBe('acceptEdits');

    expect(normalizeSessionControlPermissionModeForBackendTarget({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'safe-yolo',
    })).toBe('safe-yolo');
  });

  it('leaves configured or unsupported backend targets unchanged', () => {
    expect(normalizeSessionControlPermissionModeForBackendTarget({
      backendTarget: { kind: 'backend', backendId: 'custom', sourceKind: 'configured' },
      permissionMode: 'safe-yolo',
    })).toBe('safe-yolo');
  });
});
