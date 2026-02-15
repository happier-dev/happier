export type VoiceAdapterId = string;

export type VoiceSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VoiceSessionMode = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export type VoiceSessionSnapshot = Readonly<{
  adapterId: VoiceAdapterId | null;
  sessionId: string | null;
  status: VoiceSessionStatus;
  mode: VoiceSessionMode;
  canStop: boolean;
  errorCode?: string;
  errorMessage?: string;
}>;

export type VoiceAdapterController = Readonly<{
  id: VoiceAdapterId;
  start: (opts: Readonly<{ sessionId: string; initialContext?: string }>) => Promise<void>;
  stop: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  toggle: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  interrupt: (opts: Readonly<{ sessionId: string }>) => Promise<void>;
  sendContextUpdate: (opts: Readonly<{ sessionId: string; update: string }>) => void;
  getSnapshot: () => VoiceSessionSnapshot;
  subscribe?: (listener: () => void) => () => void;
}>;
