import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import type { VoiceAdapterController } from '@/voice/session/types';
import { projectLocalVoiceSurfaceCapabilities } from '@/voice/registry/voiceProviderSurfaceCapabilities';

export function createLocalDirectVoiceAdapter(): VoiceAdapterController {
  return createLocalVoiceAdapter('local_direct', {
    contextUpdates: false,
    textTurns: false,
    resolveSurfaceCapabilities: (voiceSettings) => projectLocalVoiceSurfaceCapabilities('local_direct', voiceSettings),
  });
}
