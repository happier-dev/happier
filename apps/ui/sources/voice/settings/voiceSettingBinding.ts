import type { Settings } from '@/sync/domains/settings/settings';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { voiceSettingsOwner } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { captureConversationLanguagePreferenceOwner } from './language/conversationLanguage';
import { createVoiceSettingBindingsV1 } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

const registry = createDefaultVoiceProviderRegistry();
export const { voiceServiceChoiceBinding, voiceConversationLanguageBinding, voiceSettingBinding, voiceLocalConversationBinding, voiceGreetingBinding, voiceAgentSelectionBinding, voiceCustomAgentBinding, updateVoiceConversationLanguagePreference, updateVoiceLocalConversationSetting,
 voiceMemoryRestoreBinding, resolveVoiceMemoryRestoreChoice, applyVoiceMemoryRestoreChoice, voiceExecutionMachineBinding, voiceDiagnosticsCaptureBinding } = createVoiceSettingBindingsV1<Settings>({
 owner: voiceSettingsOwner, registry, unavailableValue: SETTING_VALUE_UNAVAILABLE,
 captureLanguageOwner: (providerId, capturedRegistry) => captureConversationLanguagePreferenceOwner(providerId, capturedRegistry as VoiceProviderRegistry),
});
export type { LocalConversationPreferencePath } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
