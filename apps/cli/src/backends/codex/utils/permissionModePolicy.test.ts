import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';

import { resolveCodexMcpPolicyForPermissionMode } from './permissionModePolicy';

describe('resolveCodexMcpPolicyForPermissionMode', () => {
  it.each([
    ['default', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
    ['read-only', { approvalPolicy: 'never', sandbox: 'read-only' }],
    ['safe-yolo', { approvalPolicy: 'on-failure', sandbox: 'workspace-write' }],
    ['yolo', { approvalPolicy: 'on-failure', sandbox: 'danger-full-access' }],
    ['bypassPermissions', { approvalPolicy: 'on-failure', sandbox: 'danger-full-access' }],
    ['acceptEdits', { approvalPolicy: 'on-request', sandbox: 'workspace-write' }],
    ['plan', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
  ] satisfies Array<[PermissionMode, { approvalPolicy: string; sandbox: string }]>)(
    'maps %s to expected policy and sandbox',
    (permissionMode, expected) => {
      expect(resolveCodexMcpPolicyForPermissionMode(permissionMode)).toEqual(expected);
    },
  );
});
