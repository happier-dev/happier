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

type EventBase = Readonly<{
  sessionId: string;
  emittedAtMs: number;
}>;

type TurnEventBase = EventBase & Readonly<{ turnId: string }>;

export type OpenCodeRuntimeEvent =
  | (TurnEventBase & Readonly<{ kind: 'turn-start' }>)
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
