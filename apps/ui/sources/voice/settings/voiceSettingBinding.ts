import type { Settings } from '@/sync/domains/settings/settings';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { voiceSettingsOwner } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { captureConversationLanguagePreferenceOwner } from './language/conversationLanguage';
import { createVoiceSettingBindingsV1 } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { rebaseVoiceSettingsEdit } from './voiceSettingsEdit';

/** The mounted editor's one compound edit uses the same admitted Account CAS as field Actions. */
export const voiceSettingsEditBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: () => null,
    parse: value => value === null ? { success: true, value: null } : { success: false },
    mutate: () => null,
    prepare: async (_settings, _value, services, context) => {
        const edit = services.voiceSettingsEdit;
        if (!edit) return null;
        return settings => {
            if (context?.signal?.aborted || context?.isCurrent() === false) return null;
            if (edit.before.assistantLanguage !== edit.next.assistantLanguage && !edit.isLanguageOwnerCurrent(settings.voice)) {
                throw new Error('voice_settings_provider_changed');
            }
            return { voice: rebaseVoiceSettingsEdit(settings.voice, edit.before, edit.next) };
        };
    },
} satisfies SettingStorageBinding;

const registry = createDefaultVoiceProviderRegistry();
export const { voiceServiceChoiceBinding, voiceConversationLanguageBinding, voiceSettingBinding, voiceLocalConversationBinding, voiceGreetingBinding, voiceAgentSelectionBinding, voiceAgentConnectedServicesBinding, voiceCustomAgentBinding, updateVoiceConversationLanguagePreference, updateVoiceLocalConversationSetting,
 voiceMemoryRestoreBinding, resolveVoiceMemoryRestoreChoice, applyVoiceMemoryRestoreChoice, voiceExecutionMachineBinding, voiceDiagnosticsCaptureBinding } = createVoiceSettingBindingsV1<Settings>({
 owner: voiceSettingsOwner, registry, unavailableValue: SETTING_VALUE_UNAVAILABLE,
 captureLanguageOwner: (providerId, capturedRegistry) => captureConversationLanguagePreferenceOwner(providerId, capturedRegistry as VoiceProviderRegistry),
});
export type { LocalConversationPreferencePath } from '@happier-dev/protocol/voice/settings/voiceSettingBindings';
