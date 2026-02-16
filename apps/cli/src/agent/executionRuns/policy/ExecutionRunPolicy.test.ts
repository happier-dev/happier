import { describe, expect, it } from 'vitest';

import { isSafePermissionModeForIntent } from './ExecutionRunPolicy';

describe('isSafePermissionModeForIntent', () => {
  it('treats memory_hints as read-only or no-tools only', () => {
    expect(isSafePermissionModeForIntent('memory_hints' as any, 'no_tools')).toBe(true);
    expect(isSafePermissionModeForIntent('memory_hints' as any, 'read_only')).toBe(true);
    expect(isSafePermissionModeForIntent('memory_hints' as any, 'workspace_write')).toBe(false);
  });
});

