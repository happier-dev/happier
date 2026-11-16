import { describe, expect, it } from 'vitest';

import { resolveCodexTerminalPermissionPolicy } from './permissionPolicy.js';

describe('Codex terminal permission policy', () => {
  it.each([
    ['default', 'untrusted'], ['safe-yolo', 'on-request'], ['yolo', 'never'],
  ] as const)('disables the sandbox independently of %s approvals', (mode, approvalPolicy) => {
    expect(resolveCodexTerminalPermissionPolicy(mode, undefined, undefined, 'off')).toEqual({
      approvalPolicy, sandbox: 'danger-full-access',
    });
  });

  it('retains read-only authority when the sandbox preference is off', () => {
    expect(resolveCodexTerminalPermissionPolicy('yolo', 'deny', undefined, 'off')).toEqual({
      approvalPolicy: 'never', sandbox: 'read-only',
    });
    expect(resolveCodexTerminalPermissionPolicy('read-only', undefined, undefined, 'off')).toEqual({
      approvalPolicy: 'never', sandbox: 'read-only',
    });
  });

  it('enables the sandbox without changing hands-off approvals', () => {
    expect(resolveCodexTerminalPermissionPolicy('yolo', undefined, undefined, 'on')).toEqual({
      approvalPolicy: 'never', sandbox: 'workspace-write',
    });
  });
  it('keeps native write and escalation tools unavailable under an exclusive tool recipe', () => {
    expect(resolveCodexTerminalPermissionPolicy('yolo', undefined, 'deny')).toEqual({
      approvalPolicy: 'never', sandbox: 'read-only',
    });
  });
  it('keeps Happier coordination available with a read-only native sandbox under hands-off YOLO', () => {
    expect(resolveCodexTerminalPermissionPolicy('yolo', 'deny')).toEqual({
      approvalPolicy: 'never', sandbox: 'read-only',
    });
  });

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
