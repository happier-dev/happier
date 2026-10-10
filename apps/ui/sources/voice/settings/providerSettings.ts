export * from '@happier-dev/protocol/voice/settings/providerSettings';
import { createExternalVoiceProviderSettingsOwner } from '@happier-dev/protocol/voice/settings/providerSettings';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';

export function resolveExternalVoiceProviderSettingsOwner(providerId: string) {
  return createExternalVoiceProviderSettingsOwner(providerId, getExternalVoiceProviderRegistration(providerId)?.descriptor?.providerSettings);
}
