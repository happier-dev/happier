import { describe, expect, it } from 'vitest';

import {
  EXECUTION_RUN_ACTION_PERMISSION_INPUTS,
  EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION,
  ExecutionRunActionPermissionModeSchema,
} from './executionRunActionPermissionMode.js';

describe('ExecutionRunActionPermissionModeSchema', () => {
  it('accepts preferred permission intent spellings and projects the retained execution-run wire tokens', () => {
    expect(EXECUTION_RUN_ACTION_PERMISSION_INPUTS).toEqual(['read_only', 'default', 'auto', 'yolo']);
    expect(ExecutionRunActionPermissionModeSchema.parse('read_only')).toBe('read_only');
    expect(ExecutionRunActionPermissionModeSchema.parse('auto')).toBe('workspace_write');
  });

  it('preserves retained wire tokens, accepts compatibility aliases, and rejects unsupported plan mode', () => {
    expect(ExecutionRunActionPermissionModeSchema.parse('no_tools')).toBe('no_tools');
    expect(ExecutionRunActionPermissionModeSchema.parse('read-only')).toBe('read_only');
    expect(ExecutionRunActionPermissionModeSchema.parse('workspace_write')).toBe('workspace_write');
    expect(ExecutionRunActionPermissionModeSchema.parse('safe-yolo')).toBe('workspace_write');
    expect(ExecutionRunActionPermissionModeSchema.parse('acceptEdits')).toBe('workspace_write');
    expect(ExecutionRunActionPermissionModeSchema.parse('bypassPermissions')).toBe('yolo');
    expect(ExecutionRunActionPermissionModeSchema.safeParse('plan').success).toBe(false);
    expect(ExecutionRunActionPermissionModeSchema.safeParse('surprise-me').success).toBe(false);
  });

  it('advertises the preferred public vocabulary independently of retained wire tokens', () => {
    expect(EXECUTION_RUN_ACTION_PERMISSION_MODE_DESCRIPTION).toContain('read_only | default | auto | yolo');
  });
});
