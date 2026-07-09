export type VoiceAdapterId = string;

export type VoiceSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VoiceSessionMode = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/**
 * Transcript persistence mode for a provider-bound voice conversation.
 * `synthetic` projects UI-side transcript turns; `native_session` mirrors a
 * real backend session transcript.
 */
export type VoiceAdapterTranscriptMode = 'native_session' | 'synthetic';

export type VoiceSessionSnapshot = Readonly<{
  adapterId: VoiceAdapterId | null;
  sessionId: string | null;
  status: VoiceSessionStatus;
  mode: VoiceSessionMode;
  canStop: boolean;
  micMuted?: boolean;
  errorCode?: string;
  errorMessage?: string;
}>;

export type VoiceAdapterController = Readonly<{
  id: VoiceAdapterId;
  start: (opts: Readonly<{ sessionId: string; initialContext?: string }>) => Promise<void>;
  stop: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  toggle: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  interrupt: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  setMuted: (opts: Readonly<{ sessionId: string; muted: boolean }>) => Promise<void>;
  sendContextUpdate: (opts: Readonly<{ sessionId: string; update: string }>) => void;
  sendTextTurn?: (opts: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) => Promise<void>;
  getSnapshot: () => VoiceSessionSnapshot;
  subscribe?: (listener: () => void) => () => void;
  /**
   * Provider-owned capability that decides how this adapter's voice
   * conversation transcript is persisted, given the current settings.
   *
   * Returning `null` means the adapter does not expose a hidden voice
   * conversation session for the current settings (no binding). Generic
   * binding/sync code reads this capability instead of branching on the
   * adapter id, keeping provider-specific decisions provider-owned.
   */
  resolveBindingTranscriptMode?: (
    settings: unknown,
  ) => VoiceAdapterTranscriptMode | null;
}>;
