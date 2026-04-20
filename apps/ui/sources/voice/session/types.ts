export type VoiceAdapterId = string;

export type VoiceSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VoiceSessionMode = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

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
}>;
