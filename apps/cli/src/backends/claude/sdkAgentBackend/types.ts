import type { SessionId } from '@/agent/core/AgentBackend';

export type ClaudeSdkPermissionPolicy =
  | 'no_tools'
  | 'read_only'
  | 'workspace_write'
  | 'parent_session_prompt';

export type ClaudePermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt: true };

export type PendingClaudePermissionRequest = Readonly<{
  toolName: string;
  input: Record<string, unknown>;
  resolve: (decision: ClaudePermissionDecision) => void;
}>;

export type PendingClaudeTurn = {
  resolve: () => void;
  reject: (error: Error) => void;
  buffer: string[];
};

export type ClaudeSdkAgentBackendOptions = Readonly<{
  cwd: string;
  modelId: string;
  permissionPolicy: ClaudeSdkPermissionPolicy;
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type VendorSessionIdResolver = ((id: SessionId) => void) | null;
