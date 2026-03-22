import type { PermissionMode } from '@/api/types';

import type { CodexSessionConfig } from '../types';

export type CodexMcpPolicy = {
  approvalPolicy: NonNullable<CodexSessionConfig['approval-policy']>;
  sandbox: NonNullable<CodexSessionConfig['sandbox']>;
};

export type CodexAppServerApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export type CodexAppServerSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export type CodexAppServerSandboxPolicy =
  | { type: 'readOnly'; access: { type: 'fullAccess' }; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      readOnlyAccess: { type: 'fullAccess' };
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: 'dangerFullAccess' };

export type CodexAppServerPolicy = {
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandbox;
  sandboxPolicy: CodexAppServerSandboxPolicy;
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
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'acceptEdits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'plan':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'default':
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
}

export function resolveCodexAppServerPolicyForPermissionMode(
  permissionMode: PermissionMode,
  params: Readonly<{ directory: string }>,
): CodexAppServerPolicy {
  const policy = resolveCodexMcpPolicyForPermissionMode(permissionMode);

  return {
    approvalPolicy:
      policy.approvalPolicy === 'untrusted'
        ? 'untrusted'
        : policy.approvalPolicy === 'on-request'
          ? 'on-request'
          : 'never',
    sandbox:
      policy.sandbox === 'workspace-write'
        ? 'workspace-write'
        : policy.sandbox === 'danger-full-access'
          ? 'danger-full-access'
          : 'read-only',
    sandboxPolicy:
      policy.sandbox === 'workspace-write'
        ? {
            type: 'workspaceWrite',
            writableRoots: [params.directory],
            readOnlyAccess: { type: 'fullAccess' },
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : policy.sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: true },
  };
}
