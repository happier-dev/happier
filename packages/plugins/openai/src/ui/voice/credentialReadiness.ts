import { OpenAiRealtimeSettingsV1Schema } from '../../protocol/voice/settings.js';

export function projectOpenAiRealtimeCredentialReadiness(
  providerConfig: unknown,
  context: Readonly<{
    accountProfile: unknown;
    savedSecret: Readonly<{ status: 'ready' | 'missing' }>;
  }>,
) {
  const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig);
  if (parsed.success && parsed.data.authentication.source === 'voice_saved_secret') {
    return Object.freeze({
      status: context.savedSecret.status,
      detailKey: context.savedSecret.status === 'ready'
        ? 'settingsVoice.externalCredentials.ready'
        : 'settingsVoice.externalCredentials.missing',
    });
  }
  return Object.freeze({
    status: 'unknown' as const,
    detailKey: parsed.success
      ? 'settingsVoice.realtimeProviders.authentication.chooseAccount'
      : 'settingsVoice.externalCredentials.missing',
  });
}
