import { normalizeAcpPermissionIntent } from '@happier-dev/agents';

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
  switch (normalizeAcpPermissionIntent(permissionMode)) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'plan':
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}
