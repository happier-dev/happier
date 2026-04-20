import type { MicSession } from '@/voice/runtime/mic/MicSession';

type DeviceSttStatePatch = {
  controlSessionId: string;
  reason: string;
};

export type SherpaStreamingSttController = Readonly<{
  start: (sessionId: string, micSession?: MicSession | null) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
}>;

export function createSherpaStreamingSttController(deps: {
  onCaptureStarted: (controlSessionId: string) => void;
  onCaptureError: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
}): SherpaStreamingSttController {
  return {
    start: async (_sessionId: string, _micSession?: MicSession | null) => {
      // Sherpa streaming STT is native-only. On web, surface an actionable error.
      deps.onCaptureError({ controlSessionId: _sessionId, reason: 'local_neural_stt_unavailable' });
    },
    stop: async (_sessionId: string) => '',
  };
}
