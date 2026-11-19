import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import type { TranscriptPeerSenderV1, TranscriptRawAgentEventV1 } from '@happier-dev/protocol';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

type AcpSidechainMeta = { sidechainId?: string };
type TranscriptEventLifecycle = {
  lifecycleId?: string;
};
type ConnectedServiceRuntimeAuthRecoverySessionEventMessage = Extract<
  TranscriptRawAgentEventV1,
  { type: 'connected-service-runtime-auth-recovery' }
>;
type TypedAgentSessionEventMessage = {
  type: 'event';
  id: string;
  data: TranscriptRawAgentEventV1;
};
type SourceFactConsumedMessage = {
  type: 'output';
  data: {
    type: 'progress';
    marker: 'source_fact_consumed';
    reason: 'host_prompt_echo' | 'host_structured_output';
  };
};
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
  trigger?: 'manual' | 'auto' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
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
  continuation?: 'paused';
  pauseReason?: 'agent-idle-after-compaction';
};

export type ACPMessageData = AcpSidechainMeta & (
  | { type: 'message'; message: string; peer?: TranscriptPeerSenderV1 }
  | { type: 'reasoning'; message: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string;
      permission?: { id: string; status: 'pending'; turnId?: string; source: string; nativeChoices: NativePermissionChoicesV1 } }
  | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean;
      permissions?: { date: number; result: 'approved' | 'denied' | 'canceled'; decision?: string } }
  | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
  | { type: 'terminal-output'; data: string; callId: string }
  | { type: 'task_started'; id: string }
  | { type: 'task_complete'; id: string }
  | { type: 'turn_failed'; id: string }
  | { type: 'turn_cancelled'; id: string; cause?: Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>['cause'] }
  | { type: 'turn_aborted'; id: string }
  | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
  | { type: 'permission-response'; permissionId: string; approved: boolean; decision?: string; toolName?: string }
  | { type: 'token_count'; [key: string]: unknown }
  | TypedAgentSessionEventMessage
  | SourceFactConsumedMessage
  | (TranscriptEventLifecycle & { type: 'context-compaction' } & ContextCompactionEventFields)
);

export type ACPProvider = string;

export type SessionEventMessage =
  | Extract<TranscriptRawAgentEventV1, { type: 'prompt-composition' }>
  | Extract<TranscriptRawAgentEventV1, { type: 'worker-update' | 'worker-report' | 'goal-changed' }>
  | (TranscriptEventLifecycle & { type: 'switch'; mode: 'local' | 'remote' })
  | (TranscriptEventLifecycle & Extract<TranscriptRawAgentEventV1, { type: 'message' }>)
  | (TranscriptEventLifecycle & { type: 'context-compaction' } & ContextCompactionEventFields)
  | ConnectedServiceRuntimeAuthRecoverySessionEventMessage
  | { type: 'permission-mode-changed'; mode: import('../types').PermissionMode }
  | (TranscriptEventLifecycle & {
      type: 'ready';
      /** Exact completed host turn; contextless readiness is not finished work. */
      completedTurnId?: string;
      /** Host-composed owner delivery responsibility; projected beside ciphertext for the authenticated runtime. */
      ownerActivityDelivery?: 'rich_sender' | 'home_required';
    });
