import type {
  ExecutionRunUserTranscriptDirective,
  ExecutionRunReplaySeedRequest,
  ExecutionRunResumeHandle,
  VoiceAgentOutputEventV1,
  VoiceAssistantAction,
} from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';

export type VoiceAgentAgentSource = 'session' | 'agent';
export type VoiceAgentVerbosity = 'short' | 'balanced';
export type VoiceAgentTranscriptPersistenceMode = 'ephemeral' | 'persistent';

export type VoiceAgentSendTurnOptions = Readonly<{
  onOutputEvent?: (event: VoiceAgentOutputEventV1) => void | Promise<void>;
  signal?: AbortSignal;
  userTranscript?: ExecutionRunUserTranscriptDirective;
}>;

export type VoiceAgentStartParams = Readonly<{
  sessionId: string;
  profileId?: string | null;
  agentSource?: VoiceAgentAgentSource;
  agentId?: string;
  verbosity?: VoiceAgentVerbosity;
  chatModelId: string;
  commitModelId: string;
  /**
   * Daemon-only: forces commits to use a separate vendor session even when commitModelId matches chatModelId.
   */
  commitIsolation?: boolean;
  permissionIntent: PermissionIntent;
  idleTtlSeconds: number;
  initialContext: string;
  /**
   * Daemon-only: controls whether initial context is injected during bootstrap or deferred until
   * the first real user turn.
   */
  initialContextMode?: 'bootstrap' | 'first_turn';
  /**
   * Daemon-only: optional bootstrap behavior for newly created sessions.
   * When enabled, the daemon will warm the vendor session before the first user turn.
   */
  bootstrapMode?: 'ready_handshake' | 'none';
  /**
   * Daemon-only: timeout budget for bootstrap handshakes.
   * Used to avoid leaving the UI in "starting" when a provider stalls during prewarm.
   */
  bootstrapTimeoutMs?: number;
  transcript?: Readonly<{ persistenceMode?: VoiceAgentTranscriptPersistenceMode; epoch?: number }>;
  replay?: ExecutionRunReplaySeedRequest | null;
  /**
   * Daemon-only: if provided, the client will attempt to ensure/reattach to this execution run id.
   */
  existingRunId?: string | null;
  /**
   * Daemon-only: when ensuring a runId, controls whether the daemon may vendor-resume the run
   * when it is present but not currently running.
   */
  resumeWhenInactive?: boolean;
  /**
   * Daemon-only: resume handle used when starting a new execution run via provider resume.
   */
  resumeHandle?: ExecutionRunResumeHandle | null;
  /**
   * Daemon-only: controls execution-run retention policy.
   */
  retentionPolicy?: 'ephemeral' | 'resumable';
  /**
   * Unified voice tool surface for the current UI state. Used by both local and daemon-backed
   * voice agents so prompts never advertise tools that the UI will reject or privacy-block.
   */
  disabledActionIds?: readonly string[];
}>;

export type VoiceAgentStartResult = Readonly<{
  voiceAgentId: string;
  effective?: {
    chatModelId: string;
    commitModelId: string;
    permissionIntent: PermissionIntent;
  };
}>;

export type VoiceAgentTurnStreamEvent =
  | Readonly<{ t: 'voice_output'; output: VoiceAgentOutputEventV1 }>
  | Readonly<{ t: 'delta'; textDelta: string }>
  | Readonly<{ t: 'done'; assistantText: string; actions?: VoiceAssistantAction[] }>
  | Readonly<{ t: 'error'; error: string; errorCode?: string }>
  | Readonly<{ t: 'cancelled' }>;

const PROCESS_LOCAL_VOICE_AGENT_ACTION_EFFECT_ID = Symbol.for(
  'happier.voice.processLocalVoiceAgentActionEffectId',
);

/**
 * Carries canonical stream identity through the current UI process's internal turn response
 * without adding a field to the public VoiceAssistantAction protocol shape. This metadata is not
 * persisted and provides no cross-restart guarantee. Transport normalization preserves the action
 * object reference, while JSON/protocol consumers continue to see only `{ t, args }`.
 */
export type VoiceAgentActionWithEffectId = VoiceAssistantAction & Readonly<{
  [PROCESS_LOCAL_VOICE_AGENT_ACTION_EFFECT_ID]?: string;
}>;

export function attachVoiceAgentActionEffectId(
  action: VoiceAssistantAction,
  effectId: string,
): VoiceAgentActionWithEffectId {
  const actionWithEffectId = { ...action } as VoiceAgentActionWithEffectId;
  Object.defineProperty(actionWithEffectId, PROCESS_LOCAL_VOICE_AGENT_ACTION_EFFECT_ID, {
    configurable: false,
    enumerable: false,
    value: effectId,
    writable: false,
  });
  return actionWithEffectId;
}

export function readVoiceAgentActionEffectId(action: unknown): string | null {
  if (!action || typeof action !== 'object') return null;
  const effectId = (action as VoiceAgentActionWithEffectId)[PROCESS_LOCAL_VOICE_AGENT_ACTION_EFFECT_ID];
  return typeof effectId === 'string' && effectId.trim().length > 0 ? effectId : null;
}

export type VoiceAgentHandle = Readonly<{
  client: VoiceAgentClient;
  voiceAgentId: string;
  backend: 'daemon' | 'openai_compat';
  rpcSessionId: string;
  agentBackendId: string | null;
}>;

export interface VoiceAgentClient {
  start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult>;
  sendTurn(
    params: Readonly<{
      sessionId: string;
      voiceAgentId: string;
      userText: string;
      displayUserText?: string;
      /**
       * Aborts the in-flight non-streaming daemon turn so barge-in / user cancel actually terminates
       * the read loop and cancels the daemon turn stream, instead of letting it poll to timeout.
       */
      signal?: AbortSignal;
      userTranscript?: ExecutionRunUserTranscriptDirective;
    }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }>;
  welcome(
    params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>,
  ): Promise<{ assistantText: string }>;
  startTurnStream(
    params: Readonly<{
      sessionId: string;
      voiceAgentId: string;
      userText: string;
      displayUserText?: string;
      resume?: boolean;
      userTranscript?: ExecutionRunUserTranscriptDirective;
    }>,
  ): Promise<{ streamId: string }>;
  readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }>;
  cancelTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string }>): Promise<{ ok: true }>;
  commitUserTranscript?(params: Readonly<{
    sessionId: string;
    voiceAgentId: string;
    text: string;
    displayText?: string;
    localId: string;
  }>): Promise<{ ok: true }>;
  commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }>;
  stop(params: Readonly<{ sessionId: string; voiceAgentId: string }>): Promise<{ ok: true }>;
}
