import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import type { VoiceAdapterController } from '@/voice/session/types';

export function createLocalDirectVoiceAdapter(): VoiceAdapterController {
  return createLocalVoiceAdapter('local_direct', {
    contextUpdates: false,
    textTurns: false,
  });
}
