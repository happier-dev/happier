import { normalizeAcpPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';

import type { CodexTerminalPermissionPolicy } from './invocation.js';

export type CodexTerminalPermissionMode =
  | 'default'
  | 'read-only'
  | 'safe-yolo'
  | 'yolo'
  | 'bypassPermissions'
  | 'acceptEdits'
  | 'plan';

export function resolveCodexTerminalPermissionPolicy(
  permissionMode: CodexTerminalPermissionMode | string,
  workspaceWrites?: 'allow' | 'deny',
  unlistedTools?: 'ask' | 'deny',
  nativeSandbox?: 'on' | 'off',
): CodexTerminalPermissionPolicy {
  if (workspaceWrites === 'deny' || unlistedTools === 'deny') return { approvalPolicy: 'never', sandbox: 'read-only' };
  const writableSandbox = nativeSandbox === 'off' ? 'danger-full-access' : 'workspace-write';
  switch (normalizeAcpPermissionIntent(permissionMode)) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: nativeSandbox === 'off' ? 'danger-full-access' : 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'on-request', sandbox: writableSandbox };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: nativeSandbox === 'on' ? 'workspace-write' : 'danger-full-access' };
    case 'plan':
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: writableSandbox };
  }
}
