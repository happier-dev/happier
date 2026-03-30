import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';

import {
  resolveCodexAppServerPolicyForPermissionMode,
  resolveCodexMcpPolicyForPermissionMode,
} from './permissionModePolicy';

describe('resolveCodexMcpPolicyForPermissionMode', () => {
  it.each([
    ['default', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
    ['read-only', { approvalPolicy: 'never', sandbox: 'read-only' }],
    ['safe-yolo', { approvalPolicy: 'never', sandbox: 'workspace-write' }],
    ['yolo', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ['bypassPermissions', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ['acceptEdits', { approvalPolicy: 'on-request', sandbox: 'workspace-write' }],
    ['plan', { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
  ] satisfies Array<[PermissionMode, { approvalPolicy: string; sandbox: string }]>)(
    'maps %s to expected policy and sandbox',
    (permissionMode, expected) => {
      expect(resolveCodexMcpPolicyForPermissionMode(permissionMode)).toEqual(expected);
    },
  );
});

describe('resolveCodexAppServerPolicyForPermissionMode', () => {
  it.each([
    ['default', { approvalPolicy: { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } }, sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['__DIR__'], readOnlyAccess: { type: 'fullAccess' }, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }],
    ['read-only', { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: true } }],
    ['safe-yolo', { approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['__DIR__'], readOnlyAccess: { type: 'fullAccess' }, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }],
    ['yolo', { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }],
    ['bypassPermissions', { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }],
    ['acceptEdits', { approvalPolicy: { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } }, sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['__DIR__'], readOnlyAccess: { type: 'fullAccess' }, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }],
    ['plan', { approvalPolicy: { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } }, sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['__DIR__'], readOnlyAccess: { type: 'fullAccess' }, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }],
  ] satisfies Array<[
    PermissionMode,
    { approvalPolicy: unknown; sandbox: string; sandboxPolicy: Record<string, unknown> }
  ]>)('maps %s to expected app-server policy', (permissionMode, expected) => {
    expect(resolveCodexAppServerPolicyForPermissionMode(permissionMode, { directory: '__DIR__' })).toEqual(expected);
  });
});
