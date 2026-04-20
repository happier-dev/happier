import { describe, expect, it } from 'vitest';

import { resolvePermissionPolicy } from './permissionPolicy';

describe('resolvePermissionPolicy', () => {
  it('passes through legacy execution-run policies', () => {
    expect(resolvePermissionPolicy('no_tools')).toBe('no_tools');
    expect(resolvePermissionPolicy('read_only')).toBe('read_only');
    expect(resolvePermissionPolicy('workspace_write')).toBe('workspace_write');
  });

  it('maps canonical PermissionMode tokens to Claude SDK execution-run policy', () => {
    expect(resolvePermissionPolicy('read-only')).toBe('read_only');
    expect(resolvePermissionPolicy('safe-yolo')).toBe('parent_session_prompt');
    expect(resolvePermissionPolicy('yolo')).toBe('parent_session_prompt');
    expect(resolvePermissionPolicy('acceptEdits')).toBe('parent_session_prompt');
    expect(resolvePermissionPolicy('bypassPermissions')).toBe('parent_session_prompt');
    expect(resolvePermissionPolicy('auto')).toBe('parent_session_prompt');
  });

  it('defaults to read_only for empty/unknown values', () => {
    expect(resolvePermissionPolicy('')).toBe('read_only');
    expect(resolvePermissionPolicy('not-a-mode')).toBe('read_only');
  });
});
