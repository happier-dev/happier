import type { BundledVoiceConversationUiEntry } from '@happier-dev/bundled-voice-runtime-contract';

import { ElevenLabsVoiceProviderSettingsSchema } from '../../protocol/voice/index.js';

export const projectElevenLabsSettingsReadiness: NonNullable<
  BundledVoiceConversationUiEntry['internal']['projectSettingsReadiness']
> = (providerConfig) => {
  const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(providerConfig);
  if (!parsed.success) {
    throw new Error('invalid_elevenlabs_voice_provider_settings');
  }
  const hasRequiredAgent = parsed.data.billingMode !== 'byo'
    || (typeof parsed.data.byo.agentId === 'string' && parsed.data.byo.agentId.trim().length > 0);
  return Object.freeze({
    status: hasRequiredAgent ? 'ready' as const : 'missing_required_setting' as const,
  });
};
