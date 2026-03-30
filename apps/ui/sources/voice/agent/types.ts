import type { ExecutionRunReplaySeedRequest, ExecutionRunResumeHandle, VoiceAssistantAction } from '@happier-dev/protocol';

export type VoiceAgentPermissionPolicy = 'no_tools' | 'read_only';
export type VoiceAgentAgentSource = 'session' | 'agent';
export type VoiceAgentVerbosity = 'short' | 'balanced';
export type VoiceAgentTranscriptPersistenceMode = 'ephemeral' | 'persistent';

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
  permissionPolicy: VoiceAgentPermissionPolicy;
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
    permissionPolicy: VoiceAgentPermissionPolicy;
  };
}>;

export type VoiceAgentTurnStreamEvent =
  | Readonly<{ t: 'delta'; textDelta: string }>
  | Readonly<{ t: 'done'; assistantText: string; actions?: VoiceAssistantAction[] }>
  | Readonly<{ t: 'error'; error: string; errorCode?: string }>;

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
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }>;
  welcome(
    params: Readonly<{ sessionId: string; voiceAgentId: string; welcomeText?: string }>,
  ): Promise<{ assistantText: string }>;
  startTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string; displayUserText?: string; resume?: boolean }>,
  ): Promise<{ streamId: string }>;
  readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }>;
  cancelTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string }>): Promise<{ ok: true }>;
  commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }>;
  stop(params: Readonly<{ sessionId: string; voiceAgentId: string }>): Promise<{ ok: true }>;
}
