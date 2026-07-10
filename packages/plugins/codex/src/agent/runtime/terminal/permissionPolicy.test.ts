import { describe, expect, it } from 'vitest';

import { resolveCodexTerminalPermissionPolicy } from './permissionPolicy.js';

describe('Codex terminal permission policy', () => {
  it.each([
    {
      mode: 'read_only',
      expected: { approvalPolicy: 'never', sandbox: 'read-only' },
    },
    {
      mode: 'no_tools',
      expected: { approvalPolicy: 'never', sandbox: 'read-only' },
    },
    {
      mode: 'workspace_write',
      expected: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    },
  ])('accepts public protocol permission alias $mode', ({ mode, expected }) => {
    expect(resolveCodexTerminalPermissionPolicy(mode)).toEqual(expected);
  });

  it('maps safe-yolo to prompting workspace-write permissions', () => {
    expect(resolveCodexTerminalPermissionPolicy('safe-yolo')).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  it('keeps yolo as full auto-approval with no sandbox', () => {
    expect(resolveCodexTerminalPermissionPolicy('yolo')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });
});
