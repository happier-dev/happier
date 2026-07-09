import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

import type {
  WebDaemonSpeechPcmCapture as DaemonSpeechPcmCapture,
  WebDaemonSpeechPcmCaptureOptions as DaemonSpeechPcmCaptureOptions,
} from './WebDaemonSpeechPcmCapture.web';

export type { DaemonSpeechPcmCapture, DaemonSpeechPcmCaptureOptions };

export function createDaemonSpeechPcmCapture(
  options: DaemonSpeechPcmCaptureOptions,
): DaemonSpeechPcmCapture {
  return {
    start: async () => {
      options.onError?.(createVoiceMachineError({
        kind: 'provider_error',
        reason: 'daemon_streaming_stt_pcm_capture_unavailable',
      }));
    },
    stop: async () => {},
    waitForDrain: async () => {},
    isActive: () => false,
  };
}
