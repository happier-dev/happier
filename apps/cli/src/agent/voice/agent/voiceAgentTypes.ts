import type { CatalogAgentId as AgentId } from '@/agent/catalog/ids';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type {
  AcpConfigOptionOverridesV1,
  ProviderBoundModelRef,
  VoiceAgentOutputEventV1,
  VoiceAssistantAction,
} from '@happier-dev/protocol';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';

export type Verbosity = 'short' | 'balanced';

export type VoiceAgentStartParams = Readonly<{
  /**
   * Optional stable id to use as the voice-agent instance key. When omitted, a
   * random id is generated.
   */
  voiceAgentId?: string;
  agentId: AgentId;
  profileId?: string | null;
  contextSessionId?: string | null;
  chatModelId: string;
  commitModelId: string;
  chatModelSelection?: ProviderBoundModelRef;
  commitModelSelection?: ProviderBoundModelRef;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  commitIsolation?: boolean;
  permissionIntent: PermissionIntent;
  idleTtlSeconds: number;
  initialContext: string;
  initialContextMode?: 'bootstrap' | 'first_turn';
  verbosity?: Verbosity;
  resumeHandle?: ExecutionRunResumeHandle | null;
  /**
   * Connected-services selection for the voice run's backends. Threaded to the backend factory so
   * a voice run with an explicit selection materializes its connected-service auth env instead of
   * silently running on the runner's native account (R3-2 fail-closed). `null` opts out (native);
   * `undefined` defers to session-mirrored defaulting inside the run runtime resolver.
   */
  connectedServices?: ConnectedServiceBindingsV1 | null;
  disabledActionIds?: readonly string[];
  /**
   * Optional one-time bootstrap behavior for newly created (non-resumed) sessions.
   * - `ready_handshake`: send a bootstrap prompt and require the model to reply with `READY`.
   * - `none` / undefined: no bootstrap; first user turn seeds the system prompt.
   */
  bootstrapMode?: 'ready_handshake' | 'none';
  /**
   * Optional timeout budget for bootstrap handshakes.
   * When omitted, the backend default response-completion timeout applies.
   */
  bootstrapTimeoutMs?: number;
}>;

export type VoiceAgentStartResult = Readonly<{
  voiceAgentId: string;
  effective: {
    chatModelId: string;
    commitModelId: string;
    permissionIntent: PermissionIntent;
  };
}>;

export type VoiceAgentSendTurnResult = Readonly<{ assistantText: string; actions?: VoiceAssistantAction[] }>;
export type VoiceAgentCommitResult = Readonly<{ commitText: string }>;
export type VoiceAgentTurnStreamEvent =
  | Readonly<{ t: 'voice_output'; output: VoiceAgentOutputEventV1 }>
  | Readonly<{ t: 'delta'; textDelta: string }>
  | Readonly<{ t: 'done'; assistantText: string; actions?: VoiceAssistantAction[] }>
  | Readonly<{ t: 'cancelled' }>
  | Readonly<{ t: 'error'; error: string; errorCode?: string }>;
export type VoiceAgentTurnStreamStartResult = Readonly<{ streamId: string }>;
export type VoiceAgentTurnStreamReadResult = Readonly<{
  streamId: string;
  events: VoiceAgentTurnStreamEvent[];
  nextCursor: number;
  done: boolean;
  /** Canonical terminal record, independent of the caller's pagination page. */
  terminalEvent?: VoiceAgentTurnStreamEvent;
}>;

export class VoiceAgentError extends Error {
  readonly code:
    | 'VOICE_AGENT_NOT_FOUND'
    | 'VOICE_AGENT_BUSY'
    | 'VOICE_AGENT_INVALID_CURSOR'
    | 'VOICE_AGENT_TURN_COMPLETED'
    | 'VOICE_AGENT_UNSUPPORTED'
    | 'VOICE_AGENT_START_FAILED';

  constructor(code: VoiceAgentError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type BackendFactory = (opts: {
  agentId: AgentId;
  modelId: string;
  modelSelection?: ProviderBoundModelRef;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  permissionIntent: PermissionIntent;
  start?: Readonly<{ intent: 'voice_agent' }>;
  connectedServices?: ConnectedServiceBindingsV1 | null;
}) => ExecutionRunHostRuntime;

export type ResolveVoiceSystemAppendBlocksArgs = Readonly<{
  profileId?: string | null;
  sessionId?: string | null;
  workingDirectory?: string | null;
}>;

export type VoiceAgentTurn = { role: 'user' | 'assistant'; text: string };

export type VoiceAgentTurnStreamState = {
  id: string;
  userText: string;
  events: VoiceAgentTurnStreamEvent[];
  done: boolean;
  run: Promise<void>;
  completedHistory: boolean;
  cancelled: boolean;
  deltaHold: string;
  outputSpeechBuffer: string;
  outputSpeechChars: number;
  suppressActionDeltas: boolean;
  outputSeq: number;
  outputSegmentIndex: number;
};

export type VoiceAgentInstance = {
  id: string;
  agentId: AgentId;
  createRuntime: BackendFactory;
  chatBackend: ExecutionRunHostRuntime;
  chatSessionId: string;
  commitIsolation: boolean;
  commitBackend: ExecutionRunHostRuntime | null;
  commitSessionId: string | null;
  commitResumeSessionId: string | null;
  permissionIntent: PermissionIntent;
  verbosity: Verbosity;
  chatModelId: string;
  commitModelId: string;
  chatModelSelection?: ProviderBoundModelRef;
  commitModelSelection?: ProviderBoundModelRef;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  initialContext: string;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  disabledActionIds: readonly string[];
  memoryRecallGuidanceEnabled: boolean;
  systemAppendBlocks: readonly string[];
  chatSessionSeeded: boolean;
  welcomed: boolean;
  history: VoiceAgentTurn[];
  lastUsedAt: number;
  idleTtlMs: number;
  inFlight: Promise<unknown> | null;
  lifecycleInFlight: Promise<void> | null;
  chatGeneration: number;
  chatBuffer: string;
  commitBuffer: string;
  clearChatBuffer: () => void;
  clearCommitBuffer: () => void;
  unsubscribeChatMessages: () => void;
  activeTurnStream: VoiceAgentTurnStreamState | null;
  dispose: () => Promise<void>;
};
