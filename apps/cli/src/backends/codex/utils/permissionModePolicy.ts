import type { PermissionMode } from '@/api/types';

import type { CodexStartSessionConfig } from './startSessionConfig';

export type CodexMcpPolicy = {
  approvalPolicy: NonNullable<CodexStartSessionConfig['approval-policy']>;
  sandbox: NonNullable<CodexStartSessionConfig['sandbox']>;
};

export type CodexAppServerApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        /**
         * Controls whether Codex elicits approvals for MCP tool calls.
         *
         * We disable this for Happier sessions so low-risk session-control tools (e.g. change_title)
         * do not get blocked in permissioned modes.
         */
        mcp_elicitations: boolean;
        /**
         * Controls whether Codex elicits approvals for rule changes / rule application prompts.
         */
        rules: boolean;
        /**
         * Controls whether Codex elicits approvals for sandbox-relevant actions (command execution, edits, etc).
         */
        sandbox_approval: boolean;
        /**
         * Optional: approvals for permission escalation requests.
         */
        request_permissions?: boolean;
        /**
         * Optional: approvals for skill installation/enabling requests.
         */
        skill_approval?: boolean;
      };
    };

export type CodexAppServerApprovalsReviewer = 'user' | 'auto_review';

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
  approvalsReviewer?: CodexAppServerApprovalsReviewer;
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
  params: Readonly<{ directory: string; autoReviewAvailable?: boolean }>,
): CodexAppServerPolicy {
  const policy = resolveCodexMcpPolicyForPermissionMode(permissionMode);
  const useWorkspaceApprovalRequests =
    policy.sandbox === 'workspace-write'
    && (permissionMode === 'safe-yolo' || policy.approvalPolicy !== 'never');
  const autoReviewAvailable = params.autoReviewAvailable !== false;
  const granularApprovalPolicy: CodexAppServerApprovalPolicy = {
    granular: {
      // Enable MCP elicitations so Codex can ask our permission handler before invoking MCP tools.
      // This allows Happier to auto-approve low-risk session-control tools (e.g. change_title) while
      // still gating higher-risk tools through our unified approvals flow.
      mcp_elicitations: true,
      request_permissions: true,
      rules: true,
      sandbox_approval: true,
      skill_approval: false,
    },
  };

  return {
    approvalPolicy: useWorkspaceApprovalRequests ? granularApprovalPolicy : 'never',
    ...(useWorkspaceApprovalRequests
      ? { approvalsReviewer: permissionMode === 'safe-yolo' && autoReviewAvailable ? 'auto_review' : 'user' }
      : {}),
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
