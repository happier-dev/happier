type DeviceSttStatePatch = {
  status?: 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';
  sessionId?: string | null;
  error?: string | null;
};

export type SherpaStreamingSttController = Readonly<{
  clearHandsFreeSession: (sessionId?: string) => void;
  isHandsFreeSession: (sessionId: string) => boolean;
  start: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  setHandsFreeSession: (sessionId: string | null) => void;
}>;

export function createSherpaStreamingSttController(deps: {
  setState: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  canAutoStopTurn: (sessionId: string) => boolean;
  onAutoStopTurn: (sessionId: string) => void;
}): SherpaStreamingSttController {
  let handsFreeSessionId: string | null = null;

  return {
    clearHandsFreeSession: (sessionId?: string) => {
      if (sessionId && handsFreeSessionId && handsFreeSessionId !== sessionId) return;
      handsFreeSessionId = null;
    },
    isHandsFreeSession: (sessionId: string) => handsFreeSessionId === sessionId,
    setHandsFreeSession: (sessionId: string | null) => {
      handsFreeSessionId = sessionId;
    },
    start: async (_sessionId: string) => {
      // Sherpa streaming STT is native-only. resolveLocalSttProvider routes web to device STT, so this
      // is reached only by a direct caller; surface an actionable error rather than a silent no-op.
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_stt_unavailable' });
    },
    stop: async (_sessionId: string) => '',
  };
}

