import type { ExecutionRunResumeHandle, VoiceAssistantAction } from '@happier-dev/protocol';

export type VoiceAgentPermissionPolicy = 'no_tools' | 'read_only';
export type VoiceAgentAgentSource = 'session' | 'agent';
export type VoiceAgentVerbosity = 'short' | 'balanced';
export type VoiceAgentTranscriptPersistenceMode = 'ephemeral' | 'persistent';

export type VoiceAgentStartParams = Readonly<{
  sessionId: string;
  agentSource?: VoiceAgentAgentSource;
  agentId?: string;
  verbosity?: VoiceAgentVerbosity;
  chatModelId: string;
  commitModelId: string;
  permissionPolicy: VoiceAgentPermissionPolicy;
  idleTtlSeconds: number;
  initialContext: string;
  transcript?: Readonly<{ persistenceMode?: VoiceAgentTranscriptPersistenceMode; epoch?: number }>;
  /**
   * Daemon-only: if provided, the client will attempt to ensure/reattach to this execution run id.
   */
  existingRunId?: string | null;
  /**
   * Daemon-only: resume handle used when starting a new execution run via provider resume.
   */
  resumeHandle?: ExecutionRunResumeHandle | null;
  /**
   * Daemon-only: controls execution-run retention policy.
   */
  retentionPolicy?: 'ephemeral' | 'resumable';
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

export interface VoiceAgentClient {
  start(params: VoiceAgentStartParams): Promise<VoiceAgentStartResult>;
  sendTurn(
    params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string }>,
  ): Promise<{ assistantText: string; actions?: VoiceAssistantAction[] }>;
  startTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; userText: string }>): Promise<{ streamId: string }>;
  readTurnStream(
    params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string; cursor: number; maxEvents?: number }>,
  ): Promise<{ streamId: string; events: VoiceAgentTurnStreamEvent[]; nextCursor: number; done: boolean }>;
  cancelTurnStream(params: Readonly<{ sessionId: string; voiceAgentId: string; streamId: string }>): Promise<{ ok: true }>;
  commit(params: Readonly<{ sessionId: string; voiceAgentId: string; kind: 'session_instruction'; maxChars?: number }>): Promise<{ commitText: string }>;
  stop(params: Readonly<{ sessionId: string; voiceAgentId: string }>): Promise<{ ok: true }>;
}
