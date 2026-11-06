import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ProviderBoundModelRef,
  VoiceAgentOutputEventV1,
  VoiceAgentOutputTurnV1,
  VoiceAssistantAction,
  ExecutionRunVoiceAgentIntentInputV1,
} from '@happier-dev/protocol';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

export type Verbosity = 'short' | 'balanced';

export type VoiceAgentStartParams = Readonly<{
  /**
   * Optional stable id to use as the voice-agent instance key. When omitted, a
   * random id is generated.
   */
  voiceAgentId?: string;
  backendTarget: BackendTargetRefV1;
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
  voicePolicy?: ExecutionRunVoiceAgentIntentInputV1['voicePolicy'];
  initialContextMode?: 'bootstrap' | 'first_turn';
  verbosity?: Verbosity;
  resumeHandle?: ExecutionRunResumeHandle | null;
  /**
   * Host-resolved chat credential selection. `null` selects native auth;
   * `undefined` preserves the existing runtime/Account-default resolution.
   * Legacy direct Manager callers share this route with commit unless they
   * supply the host-private commitConnectedServices override.
   */
  connectedServices?: ConnectedServiceBindingsV2 | null;
  /** Host-resolved commit route; omission retains the shared legacy route. */
  commitConnectedServices?: ConnectedServiceBindingsV2 | null;
  disabledActionIds?: readonly string[];
  /**
   * Optional one-time bootstrap behavior for newly created (non-resumed) sessions.
   * - `ready_handshake`: complete a warm-up turn, discarding its model text.
   * - `none` / undefined: no bootstrap; first user turn seeds the system prompt.
   */
  bootstrapMode?: 'ready_handshake' | 'none';
  /**
   * Optional warm-up response budget for legacy callers, after native provisioning
   * and prompt admission. This never limits execution-run startup preparation.
   * When omitted, only an existing explicit operator response timeout applies.
   */
  bootstrapTimeoutMs?: number;
}>;

export type VoiceAgentStartResult = Readonly<{
  voiceAgentId: string;
  preparedInstructionsFor?: VoicePromptPreparation['preparedInstructionsFor'];
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
  preparedInstructionsFor?: VoicePromptPreparation['preparedInstructionsFor'];
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
    | 'VOICE_AGENT_START_FAILED'
    | ConnectedServiceUxDiagnosticV1['code'];

  readonly details?: Readonly<{ uxDiagnostic: ConnectedServiceUxDiagnosticV1 }>;

  constructor(code: VoiceAgentError['code'], message: string, readonly uxDiagnostic?: ConnectedServiceUxDiagnosticV1) {
    super(message);
    this.code = code;
    if (uxDiagnostic) this.details = { uxDiagnostic };
  }
}

export type BackendFactory = (opts: {
  backendTarget: BackendTargetRefV1;
  backendId: string;
  modelId: string;
  modelSelection?: ProviderBoundModelRef;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  permissionIntent: PermissionIntent;
  start?: Readonly<{ intent: 'voice_agent' }>;
  connectedServices?: ConnectedServiceBindingsV2 | null;
}) => ExecutionRunHostRuntime;

export type ResolveVoicePromptPreparationArgs = Readonly<{
  profileId?: string | null;
  sessionId?: string | null;
  workingDirectory?: string | null;
  signal?: AbortSignal;
}>;

export type VoicePromptPreparation = Readonly<{
  systemAppendBlocks: readonly string[];
  memoryRecallGuidanceEnabled: boolean;
  disabledActionIds: readonly string[];
  /** Admitted reserved entry; carriers publish this only after successful delivery. */
  preparedInstructionsFor?: Readonly<{ serverId: string; sessionId: string }>;
}>;

export type VoiceAgentTurn = { role: 'user' | 'assistant' | 'context'; text: string };

export type VoiceAgentTurnStreamState = {
  id: string;
  userText: string;
  events: VoiceAgentTurnStreamEvent[];
  done: boolean;
  run: Promise<void>;
  completedHistory: boolean;
  cancelled: boolean;
  preparedInstructionsFor?: VoicePromptPreparation['preparedInstructionsFor'];
  preparationAbortController: AbortController;
  deltaHold: string;
  outputSpeechBuffer: string;
  outputSpeechText: string;
  outputBudget: VoiceAgentOutputTurnV1;
  outputIncomplete: boolean;
  suppressActionDeltas: boolean;
  outputSeq: number;
  outputSegmentIndex: number;
  targetChars?: number;
  onEventsChanged: () => void;
  eventWaiters: Set<() => void>;
};

export type VoiceAgentInstance = {
  id: string;
  backendTarget: BackendTargetRefV1;
  backendId: string;
  createRuntime: BackendFactory;
  chatBackend: ExecutionRunHostRuntime;
  replacementChatBackend: ExecutionRunHostRuntime | null;
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
  voicePolicy?: ExecutionRunVoiceAgentIntentInputV1['voicePolicy'];
  connectedServices?: ConnectedServiceBindingsV2 | null;
  commitConnectedServices?: ConnectedServiceBindingsV2 | null;
  requestedDisabledActionIds: readonly string[];
  disabledActionIds: readonly string[];
  memoryRecallGuidanceEnabled: boolean;
  systemAppendBlocksContext: ResolveVoicePromptPreparationArgs;
  systemAppendBlocks: readonly string[];
  chatSessionSeeded: boolean;
  welcomed: boolean;
  history: VoiceAgentTurn[];
  cancelIdleDeadline: (() => void) | null;
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
