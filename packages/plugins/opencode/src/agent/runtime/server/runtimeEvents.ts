export type OpenCodeRuntimeIssue = Readonly<{
  v: 1;
  code: string;
  source: string;
  occurredAt: number;
  agentId: 'opencode';
  sanitizedPreview: string | null;
  usageLimit?: Readonly<{
    v: 1;
    resetAtMs: number | null;
    retryAfterMs: number | null;
    quotaScope: string;
    recoverability: string;
    limitCategory: string;
  }>;
}>;

export type OpenCodeRuntimeScope =
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'execution_run'; executionRunId: string }>;

export type OpenCodeHostRuntimeIdentity =
  | Readonly<{ happierSessionId: string; executionRunId?: never }>
  | Readonly<{ executionRunId: string; happierSessionId?: never }>;

export function resolveOpenCodeRuntimeScope(
  identity: OpenCodeHostRuntimeIdentity,
): OpenCodeRuntimeScope {
  return identity.executionRunId === undefined
    ? { kind: 'session', sessionId: identity.happierSessionId }
    : { kind: 'execution_run', executionRunId: identity.executionRunId };
}

type EventBase = Readonly<{ emittedAtMs: number }> & (
  | Readonly<{ sessionId: string; executionRunId?: never }>
  | Readonly<{ executionRunId: string; sessionId?: never }>
);

type TurnEventBase = EventBase & Readonly<{ turnId: string }>;

export type OpenCodeRuntimeEvent =
  | (EventBase & Readonly<{ kind: 'model-catalog-observed' }>)
  | (EventBase & Readonly<{ kind: 'mode-catalog-observed' }>)
  | (EventBase & Readonly<{ kind: 'available-commands'; commands: Array<Readonly<{ name: string; description?: string }>> }>)
  | (TurnEventBase & Readonly<{ kind: 'turn-start'; startedBy?: 'host' | 'provider' }>)
  | (TurnEventBase & Readonly<{ kind: 'message-delta'; channel: 'assistant' | 'reasoning'; text: string; messageId?: string }>)
  | (TurnEventBase & Readonly<{ kind: 'turn-complete' }>)
  | (TurnEventBase & Readonly<{ kind: 'turn-cancelled'; reason?: string }>)
  | (TurnEventBase & Readonly<{ kind: 'turn-failed'; issue: OpenCodeRuntimeIssue }>)
  | (TurnEventBase & Readonly<{
      kind: 'tool-call';
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
    }>)
  | (TurnEventBase & Readonly<{
      kind: 'tool-result';
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    }>)
  | (EventBase & Readonly<{
      kind: 'transcript-user-text';
      localId: string;
      text: string;
      meta?: unknown;
    }>)
  | (EventBase & Readonly<{
      kind: 'transcript-agent-message-committed';
      agentId: 'opencode';
      localId: string;
      body: unknown;
      meta?: unknown;
    }>)
  | (EventBase & Readonly<{
      kind: 'context-compaction';
      compactionId: string;
      phase: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
      trigger: 'manual' | 'automatic' | 'threshold' | 'overflow' | 'unknown';
      diagnostic?: Readonly<{
        code: string;
        severity: 'error';
        message?: string;
      }>;
    }>);
