import type { PermissionMode } from '@/api/types';

import type { CodexSessionConfig } from '../types';

export type CodexMcpPolicy = {
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
};

/**
 * Centralized mapping used by both remote MCP and local Codex TUI launch.
 * This keeps approval + sandbox behavior consistent across mode switches.
 */
export function resolveCodexMcpPolicyForPermissionMode(permissionMode: PermissionMode): CodexMcpPolicy {
  switch (permissionMode) {
    case 'read-only':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'safe-yolo':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'on-failure', sandbox: 'danger-full-access' };
    case 'bypassPermissions':
      return { approvalPolicy: 'on-failure', sandbox: 'danger-full-access' };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}
