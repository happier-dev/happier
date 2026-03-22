import type { AgentBackend, AgentId, SessionId } from '@/agent/core/AgentBackend';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import type { ExecutionRunResumeHandle } from '@happier-dev/protocol';

export type PermissionPolicy = 'no_tools' | 'read_only';
export type Verbosity = 'short' | 'balanced';

export type VoiceAgentStartParams = Readonly<{
  agentId: AgentId;
  profileId?: string | null;
  contextSessionId?: string | null;
  chatModelId: string;
  commitModelId: string;
  commitIsolation?: boolean;
  permissionPolicy: PermissionPolicy;
  idleTtlSeconds: number;
  initialContext: string;
  initialContextMode?: 'bootstrap' | 'first_turn';
  verbosity?: Verbosity;
  resumeHandle?: ExecutionRunResumeHandle | null;
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
    permissionPolicy: PermissionPolicy;
  };
}>;

export type VoiceAgentSendTurnResult = Readonly<{ assistantText: string; actions?: VoiceAssistantAction[] }>;
export type VoiceAgentCommitResult = Readonly<{ commitText: string }>;
export type VoiceAgentTurnStreamEvent =
  | Readonly<{ t: 'delta'; textDelta: string }>
  | Readonly<{ t: 'done'; assistantText: string; actions?: VoiceAssistantAction[] }>
  | Readonly<{ t: 'error'; error: string; errorCode?: string }>;
export type VoiceAgentTurnStreamStartResult = Readonly<{ streamId: string }>;
export type VoiceAgentTurnStreamReadResult = Readonly<{
  streamId: string;
  events: VoiceAgentTurnStreamEvent[];
  nextCursor: number;
  done: boolean;
}>;

export class VoiceAgentError extends Error {
  readonly code:
    | 'VOICE_AGENT_NOT_FOUND'
    | 'VOICE_AGENT_BUSY'
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
  permissionPolicy: PermissionPolicy;
  start?: Readonly<{ intent: 'voice_agent' }>;
}) => AgentBackend;

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
  suppressActionDeltas: boolean;
};

export type VoiceAgentInstance = {
  id: string;
  agentId: AgentId;
  chatBackend: AgentBackend;
  chatSessionId: SessionId;
  commitIsolation: boolean;
  commitBackend: AgentBackend | null;
  commitSessionId: SessionId | null;
  commitResumeSessionId: SessionId | null;
  permissionPolicy: PermissionPolicy;
  verbosity: Verbosity;
  chatModelId: string;
  commitModelId: string;
  initialContext: string;
  disabledActionIds: readonly string[];
  memoryRecallGuidanceEnabled: boolean;
  systemAppendBlocks: readonly string[];
  bootstrapped: boolean;
  history: VoiceAgentTurn[];
  lastUsedAt: number;
  idleTtlMs: number;
  inFlight: Promise<unknown> | null;
  chatBuffer: string;
  commitBuffer: string;
  clearChatBuffer: () => void;
  clearCommitBuffer: () => void;
  activeTurnStream: VoiceAgentTurnStreamState | null;
  dispose: () => Promise<void>;
};
