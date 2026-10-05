import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { SETTING_ANCHOR_QUERY_PARAM, settingRendersOnHost, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { readLocalConversationVoiceSettings, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { isLocalVoiceProviderSelected, parseLocalVoiceSttSettings, parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { resolveStoredVoiceProviderId } from './resolveVoiceProviderId';
import { useVoiceContributedSettingsDeclarations } from './useVoiceContributedSettingRefs';
import { voiceSettingsDeclarationRegistry } from './voiceContributedSettingsDeclarations';
import { VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } from './voiceSettingsDeclarations';
import { parseRealtimeSettingsDescriptor, resolveRealtimeProviderConfig, resolveVisibleRealtimeSettingsDescriptor } from './panels/realtime/descriptor';

function isSettingsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only an admitted search target gets a prerequisite row; no selection or provider work runs here. */
export function VoiceSettingsSearchPrerequisite(props: Readonly<{
    intent: 'conversations' | 'dictation';
    voice: VoiceSettings;
}>) {
    const pageId = props.intent === 'dictation' ? 'voiceDictation' : 'voiceConversations';
    const declarations = useVoiceContributedSettingsDeclarations(pageId);
    const localize = useProjectedPluginLocalizedTextResolver();
    const params = useLocalSearchParams();
    const raw = params[SETTING_ANCHOR_QUERY_PARAM];
    const requested = Array.isArray(raw) ? raw[0] : raw;
    if (!requested) return null;
    const local = resolveLocalVoiceAdapterSettings({ voice: props.voice });
    const stt = parseLocalVoiceSttSettings(props.intent === 'dictation' && props.voice.dictation.sttBinding === 'explicit'
        ? props.voice.dictation.stt : local.config.stt);
    const tts = parseLocalVoiceTtsSettings(local.config.tts);
    const localSelected = isLocalVoiceProviderSelected({ voice: props.voice });
    const select = (choice: string, control: string) => t('settingsVoice.pages.search.select', { choice, control });
    const selectLocalService = () => {
        const entry = voiceSettingsDeclarationRegistry.get(local.adapterId);
        return select(tLoose(entry?.selectionOptions?.[0]?.titleKey ?? 'settingsVoice.mode.local'), t('settingsVoice.providerSectionTitle'));
    };
    let target: SettingRef | undefined;
    let reason: string | undefined;

    for (const declaration of declarations) {
        const setting = Object.values(declaration.settings).find((candidate) => candidate.anchor === requested);
        if (!setting) continue;
        const entry = voiceSettingsDeclarationRegistry.list().find((candidate) => declaration.sections[`provider.${candidate.providerId}`]);
        if (!entry) return null;
        const title = 'declaration' in entry && entry.declaration
            ? localize(entry.pluginId, entry.declaration.title)
            : tLoose(entry.selectionOptions?.[0]?.titleKey ?? 'settingsVoice.providerSectionTitle');
        const selected = entry.kind === 'voice.conversation-provider.v1'
            ? resolveStoredVoiceProviderId(props.voice.providerId) === entry.providerId
            : props.intent === 'dictation'
                ? stt.provider === entry.providerId
                : localSelected && (entry.roles.includes('conversation_stt') && stt.provider === entry.providerId
                    || entry.roles.includes('conversation_tts') && tts.provider === entry.providerId);
        target = setting;
        if (!selected) {
            reason = select(title, t(props.intent === 'dictation' ? 'settingsVoice.dictation.provider' : entry.kind === 'voice.conversation-provider.v1'
                ? 'settingsVoice.providerSectionTitle' : entry.roles.includes('conversation_stt')
                    ? 'settingsVoice.pages.conversations.speechRecognitionTitle' : 'settingsVoice.pages.conversations.voiceEngineTitle'));
            if (props.intent === 'conversations' && entry.kind === 'voice.speech-engine.v1' && !localSelected) reason = `${selectLocalService()} ${reason}`;
        } else if (entry.kind === 'voice.conversation-provider.v1' && entry.providerSettings) {
            const descriptor = parseRealtimeSettingsDescriptor(entry.providerId, entry.providerSettings.presentation);
            const owner = entry.providerSettings;
            const resolved = resolveRealtimeProviderConfig({ ...owner, parseConfig: (value) => {
                const parsed = owner.parseConfig(value);
                return isSettingsRecord(parsed) ? parsed : null;
            } }, props.voice.providers[entry.providerId] ?? null);
            if (descriptor && resolved.status === 'ready') {
                const visible = resolveVisibleRealtimeSettingsDescriptor(descriptor, resolved.config);
                const hidden = descriptor.fields.some((field) => declaration.settings[`provider.${entry.providerId}.${field.path}`]?.anchor === requested
                    && !visible.fields.includes(field))
                    || visible !== descriptor && ['credential', 'credentialSource'].some((path) => declaration.settings[`provider.${entry.providerId}.${path}`]?.anchor === requested);
                const ownAccount = entry.selectionOptions?.find((option) => option.modeId === 'byo');
                if (hidden && ownAccount) reason = select(tLoose(ownAccount.titleKey), t('settingsVoice.pages.conversations.payWithTitle'));
            }
        }
        break;
    }

    if (!target) {
        const declaration = props.intent === 'dictation' ? VOICE_DICTATION_SETTINGS : VOICE_CONVERSATIONS_SETTINGS;
        const match = Object.entries(declaration.settings).find(([, setting]) => setting.anchor === requested);
        if (!match) return null;
        const [id, setting] = match;
        const agentSetting = [VOICE_CONVERSATIONS_SETTINGS.sectionRefs.agentLifecycle.id, VOICE_CONVERSATIONS_SETTINGS.sectionRefs.streaming.id].includes(setting.sectionId)
            || /^(agent|customAgent|permissionIntent|chatModel|commitModel|verbosity)/u.test(id);
        const localConversation = readLocalConversationVoiceSettings(props.voice);
        target = setting;
        if (props.intent === 'conversations' && !resolveStoredVoiceProviderId(props.voice.providerId)
            && ['greeting', 'assistantLanguage'].includes(id)) {
            reason = t('settingsVoice.pages.search.chooseService');
        } else if (props.intent === 'conversations' && !localSelected
            && !['provider', 'greeting', 'assistantLanguage'].includes(id)) {
            reason = selectLocalService();
        } else if (props.intent === 'conversations' && local.adapterId === 'local_direct' && (agentSetting || id === 'conversationMode' || id === 'greeting')) {
            reason = selectLocalService();
        } else if (id.startsWith('stt') && id !== 'sttProvider' && stt.provider !== 'local_neural') {
            reason = select(t('settingsVoice.local.localNeuralStt.provider.title'), t(props.intent === 'dictation'
                ? 'settingsVoice.dictation.provider' : 'settingsVoice.pages.conversations.speechRecognitionTitle'));
        } else if (id.startsWith('tts') && id !== 'ttsProvider' && tts.provider !== 'local_neural'
            && setting.sectionId === VOICE_CONVERSATIONS_SETTINGS.settings.ttsProvider.sectionId) {
            reason = select(t('settingsVoice.local.localNeuralTts.provider.title'), t('settingsVoice.pages.conversations.voiceEngineTitle'));
        } else if (props.intent === 'conversations' && localConversation.conversationMode !== 'agent' && agentSetting) {
            reason = select(t('settingsVoice.pages.conversations.talkToAgent'), t('settingsVoice.pages.conversations.talkToTitle'));
        } else if (id === 'maxWarmRoots' && localConversation.agent.rootSessionPolicy !== 'keep_warm') {
            reason = select(t('settingsVoice.local.conversation.rootSessionPolicy.keepWarmTitle'), t('settingsVoice.local.conversation.rootSessionPolicy.title'));
        } else if (['agent', 'customAgent'].includes(id) && localConversation.agent.agentSource !== 'agent') {
            reason = select(t('settingsVoice.local.conversation.agentSource.fixedAgentTitle'), t('settingsVoice.local.mediatorAgentSource'));
        } else if (id === 'chatModelId' && localConversation.agent.chatModelSource !== 'custom') {
            reason = select(t('settingsVoice.local.mediatorChatModelSourceCustom'), t('settingsVoice.local.mediatorChatModelSource'));
        } else if (id === 'commitModelId' && localConversation.agent.commitModelSource !== 'custom') {
            reason = select(t('settingsVoice.local.mediatorCommitModelSourceCustom'), t('settingsVoice.local.mediatorCommitModelSource'));
        }
    }
    if (!reason || !target || !settingRendersOnHost(target)) return null;
    return <ItemGroup>
        <SettingRow setting={target} testID="settings.voice.searchPrerequisite" subtitle={reason} subtitleLines={0} disabled showChevron={false} />
    </ItemGroup>;
}
