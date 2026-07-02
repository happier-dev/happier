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
): CodexTerminalPermissionPolicy {
  switch (permissionMode) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'yolo':
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}
