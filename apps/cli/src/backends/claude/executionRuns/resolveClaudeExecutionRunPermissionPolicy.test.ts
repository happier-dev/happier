import { describe, expect, it } from 'vitest';

import { resolveClaudeExecutionRunPermissionPolicy } from './resolveClaudeExecutionRunPermissionPolicy';

describe('resolveClaudeExecutionRunPermissionPolicy', () => {
  it('passes through legacy execution-run policies', () => {
    expect(resolveClaudeExecutionRunPermissionPolicy('no_tools')).toBe('no_tools');
    expect(resolveClaudeExecutionRunPermissionPolicy('read_only')).toBe('read_only');
    expect(resolveClaudeExecutionRunPermissionPolicy('workspace_write')).toBe('workspace_write');
  });

  it('maps canonical PermissionMode tokens to Claude SDK execution-run policy', () => {
    expect(resolveClaudeExecutionRunPermissionPolicy('read-only')).toBe('read_only');
    expect(resolveClaudeExecutionRunPermissionPolicy('safe-yolo')).toBe('workspace_write');
    expect(resolveClaudeExecutionRunPermissionPolicy('yolo')).toBe('workspace_write');
    expect(resolveClaudeExecutionRunPermissionPolicy('acceptEdits')).toBe('workspace_write');
    expect(resolveClaudeExecutionRunPermissionPolicy('bypassPermissions')).toBe('workspace_write');
  });

  it('defaults to read_only for empty/unknown values', () => {
    expect(resolveClaudeExecutionRunPermissionPolicy('')).toBe('read_only');
    expect(resolveClaudeExecutionRunPermissionPolicy('not-a-mode')).toBe('read_only');
  });
});

