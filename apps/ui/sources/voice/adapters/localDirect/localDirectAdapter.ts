import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import type { VoiceAdapterController } from '@/voice/session/types';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VoiceLocalDirectSchema } from './settings';

export function createLocalDirectVoiceAdapter(): VoiceAdapterController {
  return createLocalVoiceAdapter('local_direct', {
    contextUpdates: false,
    textTurns: false,
    resolveSurfaceCapabilities: (voiceSettings) => {
      const parsedVoice = voiceSettingsParse(voiceSettings);
      const envelope = parsedVoice.providers.local_direct;
      if (parsedVoice.providerId !== 'local_direct'
        || envelope?.schemaVersion !== 1
        || !VoiceLocalDirectSchema.safeParse(envelope.config).success) return null;
      return {
        allowsGlobalStart: false,
        controlSessionScope: 'surface',
        requiresVoiceAgentFeature: false,
        bargeInEnabled: false,
        cancelResponse: 'immediate',
      };
    },
  });
}
