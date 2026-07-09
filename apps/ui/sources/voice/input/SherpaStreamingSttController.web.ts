import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';

import type { SttController, SttStartParams } from './sttController';

export type SherpaStreamingSttController = SttController;

export type CreateSherpaStreamingSttControllerDeps = {
  getSettings: () => any;
};

export function createSherpaStreamingSttController(
  _deps: CreateSherpaStreamingSttControllerDeps,
): SherpaStreamingSttController {
  return {
    start: async ({ sink }: SttStartParams) => {
      // Sherpa streaming STT is native-only. On web, surface an actionable error.
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_stt_unavailable' }));
    },
    stop: async () => ({ finalText: '' }),
  };
}
