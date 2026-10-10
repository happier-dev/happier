export * from '@happier-dev/protocol/voice/settings/voiceSettings';
import { createVoiceSettingsOwner } from '@happier-dev/protocol/voice/settings/voiceSettings';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from '@/voice/registry/generatedBundledVoiceEntries';
import { resolveExternalVoiceProviderSettingsOwner } from '@/voice/settings/providerSettings';

export const voiceSettingsOwner = createVoiceSettingsOwner({
  bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  resolveExternalProviderSettingsOwner: resolveExternalVoiceProviderSettingsOwner,
});
export const { CanonicalVoiceSettingsSchema, getCanonicalVoiceProviderSettingsOwner, isReservedVoiceSettingsRootKey, VoiceSettingsSchema, readVoiceProviderSettingsConfig, readLocalDirectVoiceSettings, readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig, writeLocalDirectVoiceSettings, writeLocalConversationVoiceSettings, readVoiceDiagnosticsSettings, writeVoiceDiagnosticsSettings, voiceSettingsDefaults, readVoiceSettingsInput, readVoiceExecutionMachineSettings, voiceSettingsParse, projectVoiceSettingsAnalytics } = voiceSettingsOwner;
