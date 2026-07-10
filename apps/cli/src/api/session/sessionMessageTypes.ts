import type { TranscriptRawAgentEventV1 } from '@happier-dev/protocol';

type AcpSidechainMeta = { sidechainId?: string };
type TranscriptEventLifecycle = {
  lifecycleId?: string;
};
type ConnectedServiceRuntimeAuthRecoverySessionEventMessage = Extract<
  TranscriptRawAgentEventV1,
  { type: 'connected-service-runtime-auth-recovery' }
>;
type ContextCompactionPhase = 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
type ContextCompactionSource =
  | 'agent-event'
  | 'agent-status'
  | 'agent-hook'
  | 'transcript-inference'
  | 'user-command'
  | 'runtime';
type ContextCompactionEventFields = {
  phase: ContextCompactionPhase;
  provider?: string;
  backendId?: string;
  agentId?: string;
  trigger?: 'manual' | 'auto' | 'threshold' | 'overflow' | 'unknown';
  source?: ContextCompactionSource;
  agentEventId?: string;
  agentSessionId?: string;
  turnId?: string;
  tokenCountBefore?: number;
  tokenCountAfter?: number;
  tokenCountSource?: string;
  retryAttempt?: number;
  errorCode?: string;
  sanitizedErrorPreview?: string;
};

export type ACPMessageData = AcpSidechainMeta & (
  | { type: 'message'; message: string }
  | { type: 'reasoning'; message: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
  | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
  | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
  | { type: 'terminal-output'; data: string; callId: string }
  | { type: 'task_started'; id: string }
  | { type: 'task_complete'; id: string }
  | { type: 'turn_failed'; id: string }
  | { type: 'turn_cancelled'; id: string }
  | { type: 'turn_aborted'; id: string }
  | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
  | { type: 'permission-response'; permissionId: string; approved: boolean; decision?: string; toolName?: string }
  | { type: 'token_count'; [key: string]: unknown }
  | (TranscriptEventLifecycle & { type: 'context-compaction' } & ContextCompactionEventFields)
);

export type ACPProvider = string;

export type SessionEventMessage =
  | (TranscriptEventLifecycle & { type: 'switch'; mode: 'local' | 'remote' })
  | (TranscriptEventLifecycle & { type: 'message'; message: string })
  | (TranscriptEventLifecycle & { type: 'context-compaction' } & ContextCompactionEventFields)
  | ConnectedServiceRuntimeAuthRecoverySessionEventMessage
  | { type: 'permission-mode-changed'; mode: import('../types').PermissionMode }
  | (TranscriptEventLifecycle & { type: 'ready' });
