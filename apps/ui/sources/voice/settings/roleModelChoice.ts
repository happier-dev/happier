import { createVoiceSettingBindingsV1 } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
import { voiceSettingsOwner, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

/** Picker and editor replay consume the same protocol-owned role-model mutation as Actions. */
export const { updateVoiceRoleModelChoice } = createVoiceSettingBindingsV1<{ voice: VoiceSettings }>({
    owner: voiceSettingsOwner, registry: createDefaultVoiceProviderRegistry(), unavailableValue: null,
});
