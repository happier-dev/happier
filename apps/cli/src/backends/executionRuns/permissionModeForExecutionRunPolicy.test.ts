import { describe, expect, it } from 'vitest';

import { permissionModeForExecutionRunPolicy } from './permissionModeForExecutionRunPolicy';

describe('permissionModeForExecutionRunPolicy', () => {
  it('maps execution-run safe policies to PermissionMode', () => {
    expect(permissionModeForExecutionRunPolicy('read_only')).toBe('read-only');
    expect(permissionModeForExecutionRunPolicy('no_tools')).toBe('read-only');
  });

  it('passes through canonical PermissionMode tokens', () => {
    expect(permissionModeForExecutionRunPolicy('read-only')).toBe('read-only');
    expect(permissionModeForExecutionRunPolicy('safe-yolo')).toBe('safe-yolo');
    expect(permissionModeForExecutionRunPolicy('yolo')).toBe('yolo');
    expect(permissionModeForExecutionRunPolicy('default')).toBe('default');
  });

  it('falls back to default for unknown values', () => {
    expect(permissionModeForExecutionRunPolicy('')).toBe('default');
    expect(permissionModeForExecutionRunPolicy('not-a-mode')).toBe('default');
  });
});

