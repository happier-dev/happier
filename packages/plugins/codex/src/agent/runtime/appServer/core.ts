import type {
  AgentSessionConversationRollbackRequest,
  AgentSessionConversationRollbackResult,
  AgentSessionConversationRollbackReconciliationResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionRuntimeIssueV1 } from '@happier-dev/plugin-sdk/sessions';

export type CodexAppServerRuntimeIssue = SessionRuntimeIssueV1;

export type CodexAppServerRollbackTarget =
  | Readonly<{ type: 'latest_turn' }>
  | Readonly<{ type: 'before_user_message'; userMessageSeq: number }>;

type CodexAppServerEventBase = Readonly<{
  sessionId: string;
  emittedAtMs: number;
  sidechainId?: string;
}>;

type CodexAppServerTurnEventBase = CodexAppServerEventBase & Readonly<{
  turnId: string;
  agentTurnId?: string;
}>;

type NativeProviderCheckpoint = Extract<
  AgentSessionRuntimeEvent,
  { kind: 'turn-rollback-boundary' }
>['providerCheckpoint'];

type NativeUsageObservation = Omit<
  Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>,
  'sequence' | 'sessionId' | 'emittedAtMs'
>;

export type CodexAppServerEvent =
  | (CodexAppServerEventBase & Readonly<{
      kind: 'message-delta';
      turnId: string;
      delta: unknown;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'tool-call';
      turnId: string;
      toolCallId: string;
      toolName: string;
      toolInput: unknown;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'tool-progress';
      turnId: string;
      toolCallId: string;
      progress: unknown;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'tool-result';
      turnId: string;
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    }>)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-start';
      startedBy?: string;
    }>)
  | (CodexAppServerTurnEventBase & Readonly<{ kind: 'turn-progress' }>)
  | (CodexAppServerTurnEventBase & Readonly<{ kind: 'turn-complete' }>)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-failed';
      issue: CodexAppServerRuntimeIssue;
    }>)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-cancelled';
      reason?: string;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'turn-agent-id-observed';
      turnId: string;
      agentTurnId: string;
    }>)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-input-appended';
      localInputId?: string;
      userMessageSeq?: number;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'transcript-agent-message-committed';
      agentId: string;
      localId: string;
      body: unknown;
      meta?: Readonly<Record<string, unknown>>;
    }>)
  | (CodexAppServerEventBase & NativeUsageObservation)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-rollback-boundary-observed';
      startUserMessageSeq?: number;
      startSeqInclusive?: number;
      endSeqInclusive?: number | null;
      agentRollbackOrdinal?: number;
      providerCheckpoint?: NativeProviderCheckpoint;
    }>)
  | (CodexAppServerTurnEventBase & Readonly<{
      kind: 'turn-rollback-applied';
      restoredToTurnId: string;
      agentRollbackOrdinal?: number;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'session-ended';
      reason?: string;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'session-id-publish';
      publishedSessionId: string;
      source: string;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'descriptor-update';
      descriptor: unknown;
    }>)
  | (CodexAppServerEventBase & Readonly<{
      kind: 'backend-error';
      error: Readonly<{ message: string; code?: string }>;
    }>);

export type CodexAppServerEventInput = CodexAppServerEvent extends infer Event
  ? Event extends CodexAppServerEvent
    ? Omit<Event, 'sessionId' | 'emittedAtMs'>
    : never
  : never;

export type CodexAppServerInput = Readonly<{
  text: string;
  structuredInput?: unknown;
}>;

export type CodexAppServerSendOptions = Readonly<{
  signal?: AbortSignal;
  localInputId?: string;
  localInputIds?: readonly string[];
  turnId?: string;
  deliverAs?: 'steer' | 'followUp';
  modelId?: string;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
}>;

export type CodexAppServerSendResult = Readonly<{
  status: 'accepted' | 'unsupported' | 'unavailable' | 'rejected';
  turnId?: string;
  agentTurnId?: string;
  diagnostic?: string;
}>;

export type CodexAppServerCancelResult = Readonly<{
  status: 'cancelled' | 'not_running' | 'unsupported' | 'unavailable';
  diagnostic?: string;
}>;

export type CodexAppServerSession = Readonly<{
  identity: Readonly<{
    read(): Readonly<{ providerSessionId: string | null }>;
  }>;
  events: Readonly<{
    subscribe(handler: (event: CodexAppServerEvent) => void): () => void;
  }>;
  send(
    input: CodexAppServerInput,
    options?: CodexAppServerSendOptions,
  ): Promise<CodexAppServerSendResult>;
  cancel?(expectedTurnId?: string): Promise<CodexAppServerCancelResult>;
  permissions?: Readonly<{ capability: 'inline' }>;
  updateConfig?(update: Readonly<{
    modelId?: string;
    permissionMode?: string;
    configOption?: Readonly<Record<string, unknown>>;
  }>): Promise<void>;
  runtimeAuth?: AgentSessionRuntimeAuthControl;
  dispose(reason?: 'session_closed' | 'plugin_deactivated' | 'host_shutdown' | 'runtime_recovery'): Promise<void>;
  rollbackNativeConversation(
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackResult>;
  reconcileNativeConversationRollback(
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackReconciliationResult>;
}>;

export type CodexAppServerSessionTurn = Readonly<{
  turnId: string;
  agentId?: string;
  agentTurnId?: string;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  updatedAt: number;
  terminalAt?: number;
  lastRuntimeIssue?: CodexAppServerRuntimeIssue | null;
  transcriptAnchors?: Readonly<{
    startUserMessageSeq?: number;
    userMessageSeqs?: readonly number[];
    startSeqInclusive?: number;
    endSeqInclusive?: number | null;
  }>;
  rollback?: Readonly<{
    state: 'eligible' | 'rolled_back';
    reason?: string;
    agentRollbackOrdinal?: number;
    providerCheckpoint?: NativeProviderCheckpoint;
    updatedAt: number;
  }>;
}>;
