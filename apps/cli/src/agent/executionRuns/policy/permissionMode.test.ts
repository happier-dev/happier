import { describe, expect, it } from 'vitest';

import { permissionMode } from './permissionMode';

describe('permissionMode', () => {
  it('maps execution-run safe policies to PermissionIntent', () => {
    expect(permissionMode('read_only')).toBe('read-only');
    expect(permissionMode('no_tools')).toBe('read-only');
    expect(permissionMode('workspace_write')).toBe('safe-yolo');
  });

  it('passes through canonical PermissionIntent tokens', () => {
    expect(permissionMode('read-only')).toBe('read-only');
    expect(permissionMode('safe-yolo')).toBe('safe-yolo');
    expect(permissionMode('yolo')).toBe('yolo');
    expect(permissionMode('default')).toBe('default');
    expect(permissionMode('plan')).toBe('plan');
  });

  it('normalizes legacy provider permission aliases at the execution-run boundary', () => {
    expect(permissionMode('acceptEdits')).toBe('safe-yolo');
    expect(permissionMode('bypassPermissions')).toBe('yolo');
  });

  it('falls back to default for unknown values', () => {
    expect(permissionMode('')).toBe('default');
    expect(permissionMode('not-a-mode')).toBe('default');
  });
});
