import { builtInSettingUiDeclaration, defineSettingsPage, settingsHosts, type SettingRef, type SettingsPageDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { voiceSettingBinding, voiceGreetingBinding, voiceLocalConversationBinding, voiceAgentSelectionBinding, voiceCustomAgentBinding, voiceConversationLanguageBinding } from './voiceSettingBinding';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectConversationLanguagePreference } from './language/conversationLanguage';
import { voiceExecutionMachineBinding } from './executionMachineChoice';
import { voiceMemoryRestoreBinding } from './memoryRestore';
import { voiceDiagnosticsCaptureBinding } from '@/voice/diagnostics/diagnosticsSettings';
import { voiceSettingsOperation } from './voiceSettingsOperation';

/** Search, public Actions and the rendered root control use the same selected consumer fact. */
export function resolveVoiceConversationLanguageSetting(voice: VoiceSettings, registry: VoiceProviderRegistry): SettingRef {
    const preference = projectConversationLanguagePreference(voice, registry);
    const base = VOICE_CONVERSATIONS_SETTINGS.settings.assistantLanguage;
    const labels = builtInSettingUiDeclaration(base.anchor, preference.kind);
    const entry = voice.providerId ? registry.get(voice.providerId) : null;
    return {
        ...base,
        titleKey: labels.titleKey,
        descriptionKey: labels.descriptionKey,
        keywordKeys: labels.keywordKeys,
        ...(entry && entry.source.kind !== 'built_in' && entry.kind === 'voice.conversation-provider.v1' && entry.declaration
            ? { contribution: { pluginId: entry.pluginId, localId: entry.declaration.id } } : {}),
        storage: preference.kind === 'unavailable' ? undefined : voiceConversationLanguageBinding(registry, voice),
    };
}

export function projectVoiceSettingsPageDeclarations(declarations: readonly SettingsPageDeclaration[], voice: VoiceSettings, registry: VoiceProviderRegistry): readonly SettingsPageDeclaration[] {
    const setting = resolveVoiceConversationLanguageSetting(voice, registry);
    return declarations.map((page) => page.pageId === 'voiceConversations'
        ? { ...page, settings: { ...page.settings, assistantLanguage: setting } } : page);
}

/**
 * The searchable settings of the Voice intent pages. Rows render their labels from these
 * declarations, including conditional rows. Search reveals their section without changing the
 * selected service; the section explains any missing prerequisite.
 */
export const VOICE_DICTATION_SETTINGS = defineSettingsPage({
    pageId: 'voiceDictation',
    sections: {
        dictation: {
            titleKey: 'settingsVoice.dictation.title',
            settings: {
                provider: { storage: voiceSettingBinding('dictation.stt.provider') },
                language: { storage: voiceSettingBinding('dictation.language') },
                sttAssetId: { storage: voiceSettingBinding('dictation.stt.localNeural.assetId') },
                sttLanguage: { storage: voiceSettingBinding('dictation.stt.localNeural.language') },
                sttExecution: { storage: voiceSettingBinding('dictation.stt.localNeural.execution') },
                executionMachine: { storage: voiceExecutionMachineBinding },
                sttPrepareModel: {  operation: voiceSettingsOperation('stt_prepare', 'dictation') },
                sttRemoveModel: {  operation: voiceSettingsOperation('stt_remove', 'dictation') },
                sttUpdateModel: { host: settingsHosts.native, operation: voiceSettingsOperation('stt_update', 'dictation') },
                readiness: {  operation: voiceSettingsOperation('readiness_inspect', 'dictation') },
            },
        },
    },
});

export const VOICE_CONVERSATIONS_SETTINGS = defineSettingsPage({
    pageId: 'voiceConversations',
    sections: {
        provider: {
            titleKey: 'settingsVoice.providerSectionTitle',
            settings: {
                provider: { storage: voiceSettingBinding('providerId') },
                greeting: { storage: voiceGreetingBinding },
            },
        },
        language: {
            titleKey: 'settingsVoice.languageTitle',
            settings: {
                assistantLanguage: { storage: voiceSettingBinding('assistantLanguage') },
            },
        },
        local: {
            titleKey: 'settingsVoice.pages.conversations.thinkTitle',
            settings: {
                conversationMode: { storage: voiceLocalConversationBinding('conversationMode') },
                executionMachine: { storage: voiceExecutionMachineBinding },
                handsFree: { storage: voiceLocalConversationBinding('handsFree.enabled') },
                silenceMs: { storage: voiceLocalConversationBinding('handsFree.endpointing.silenceMs') },
                minSpeechMs: { storage: voiceLocalConversationBinding('handsFree.endpointing.minSpeechMs') },
                sttProvider: { storage: voiceLocalConversationBinding('stt.provider') },
                sttAssetId: { storage: voiceLocalConversationBinding('stt.localNeural.assetId') },
                sttLanguage: { storage: voiceLocalConversationBinding('stt.localNeural.language') },
                sttExecution: { storage: voiceLocalConversationBinding('stt.localNeural.execution') },
                sttPrepareModel: {  operation: voiceSettingsOperation('stt_prepare') },
                sttRemoveModel: {  operation: voiceSettingsOperation('stt_remove') },
                sttUpdateModel: { host: settingsHosts.native, operation: voiceSettingsOperation('stt_update') },
                ttsProvider: { storage: voiceLocalConversationBinding('tts.provider') },
                autoSpeakReplies: { storage: voiceLocalConversationBinding('tts.autoSpeakReplies') },
                bargeInEnabled: { storage: voiceLocalConversationBinding('tts.bargeInEnabled') },
                ttsAssetId: { storage: voiceLocalConversationBinding('tts.localNeural.assetId') },
                ttsVoiceId: { storage: voiceLocalConversationBinding('tts.localNeural.voiceId') },
                ttsSpeed: { storage: voiceLocalConversationBinding('tts.localNeural.speed') },
                ttsExecution: { storage: voiceLocalConversationBinding('tts.localNeural.execution') },
                ttsPrepareModel: {  operation: voiceSettingsOperation('tts_prepare') },
                ttsRemoveModel: {  operation: voiceSettingsOperation('tts_remove') },
                ttsUpdateModel: { host: settingsHosts.native, operation: voiceSettingsOperation('tts_update') },
                ttsPreview: { host: settingsHosts.native, operation: voiceSettingsOperation('tts_preview') },
                testTts: {   operation: voiceSettingsOperation('tts_test') },
                readiness: {  operation: voiceSettingsOperation('readiness_inspect') },
                agentSource: { storage: voiceLocalConversationBinding('agent.agentSource') },
                agent: { storage: voiceAgentSelectionBinding },
                customAgent: { storage: voiceCustomAgentBinding },
                permissionIntent: { storage: voiceLocalConversationBinding('agent.permissionIntent') },
                chatModelSource: { storage: voiceLocalConversationBinding('agent.chatModelSource') },
                chatModelId: { storage: voiceLocalConversationBinding('agent.chatModelId') },
                commitModelSource: { storage: voiceLocalConversationBinding('agent.commitModelSource') },
                commitModelId: { storage: voiceLocalConversationBinding('agent.commitModelId') },
                verbosity: { storage: voiceLocalConversationBinding('agent.verbosity') },
            },
        },
        agentLifecycle: {
            titleKey: 'settingsVoice.local.conversation.rootSessionPolicy.title',
            settings: {
                stayInVoiceHome: { storage: voiceLocalConversationBinding('agent.stayInVoiceHome') },
                teleportEnabled: { storage: voiceLocalConversationBinding('agent.teleportEnabled') },
                rootSessionPolicy: { storage: voiceLocalConversationBinding('agent.rootSessionPolicy') },
                maxWarmRoots: { storage: voiceLocalConversationBinding('agent.maxWarmRoots') },
                idleTtlSeconds: { storage: voiceLocalConversationBinding('agent.idleTtlSeconds') },
                prewarmOnConnect: { storage: voiceLocalConversationBinding('agent.prewarmOnConnect') },
                commitIsolation: { storage: voiceLocalConversationBinding('agent.commitIsolation') },
            },
        },
        streaming: {
            titleKey: 'settingsVoice.local.conversation.streaming.enableTitle',
            settings: {
                streamingEnabled: { storage: voiceLocalConversationBinding('streaming.enabled') },
                streamingTtsEnabled: { storage: voiceLocalConversationBinding('streaming.ttsEnabled') },
                ttsChunkChars: { storage: voiceLocalConversationBinding('streaming.ttsChunkChars') },
            },
        },
    },
});

export const VOICE_PRIVACY_SETTINGS = defineSettingsPage({
    pageId: 'voicePrivacy',
    sections: {
        contextSharing: {
            titleKey: 'settingsVoice.pages.privacy.startTitle',
            settings: {
                currentUiContextMode: { storage: voiceSettingBinding('privacy.currentUiContextMode') },
                shareSessionSummary: { storage: voiceSettingBinding('privacy.shareSessionSummary') },
                shareRecentMessages: { storage: voiceSettingBinding('privacy.shareRecentMessages') },
                recentMessagesCount: { storage: voiceSettingBinding('privacy.recentMessagesCount') },
                shareToolNames: { storage: voiceSettingBinding('privacy.shareToolNames') },
                sharePermissionRequests: { storage: voiceSettingBinding('privacy.sharePermissionRequests') },
                shareDeviceInventory: { storage: voiceSettingBinding('privacy.shareDeviceInventory') },
            },
        },
        // Moved from Advanced (plan §4.5): ongoing snippets are what the service reads while you talk.
        updates: {
            titleKey: 'settingsVoice.pages.privacy.liveTitle',
            settings: {
                activeSession: { storage: voiceSettingBinding('ui.updates.activeSession') },
                otherSessions: { storage: voiceSettingBinding('ui.updates.otherSessions') },
                snippetsMaxMessages: { storage: voiceSettingBinding('ui.updates.snippetsMaxMessages') },
                includeUserMessagesInSnippets: { storage: voiceSettingBinding('ui.updates.includeUserMessagesInSnippets') },
                otherSessionsSnippetsMode: { storage: voiceSettingBinding('ui.updates.otherSessionsSnippetsMode') },
            },
        },
        // Voice agent memory (plan §4.5): remembering, how it is restored, and the Forget operation.
        memory: {
            titleKey: 'settingsVoice.pages.privacy.memoryTitle',
            settings: {
                rememberPastConversations: { storage: voiceLocalConversationBinding('agent.transcript.persistenceMode') },
                restoreMemoryBy: { storage: voiceMemoryRestoreBinding },
                fallbackToReplay: { storage: voiceLocalConversationBinding('agent.providerResume.fallbackToReplay') },
                restoreMessagesCount: { storage: voiceLocalConversationBinding('agent.replay.recentMessagesCount') },
                forgetVoiceAgentMemory: {   operation: voiceSettingsOperation('memory_forget') },
            },
        },
        history: {
            titleKey: 'settingsVoice.history.sectionTitle',
            settings: {
                voiceHistory: {},
            },
        },
        diagnostics: {
            titleKey: 'settingsVoice.diagnostics.title',
            settings: {
                diagnosticsEnabled: { storage: voiceSettingBinding('diagnostics.enabled'), operation: voiceSettingsOperation('diagnostics_enabled') },
                diagnosticsSttInput: { storage: voiceDiagnosticsCaptureBinding('captureSttInput') },
                diagnosticsTtsOutput: { storage: voiceDiagnosticsCaptureBinding('captureTtsOutput') },
                diagnosticsLocation: {  operation: voiceSettingsOperation('diagnostics_inspect') },
                diagnosticsRetention: {},
                diagnosticsBackupPolicy: {},
                diagnosticsExport: {  operation: voiceSettingsOperation('diagnostics_export') },
                diagnosticsCleanup: {   operation: voiceSettingsOperation('diagnostics_cleanup') },
                diagnosticsDelete: {   operation: voiceSettingsOperation('diagnostics_delete') },
                diagnosticsSessionOptOut: {  operation: voiceSettingsOperation('diagnostics_session_opt_out') },
                diagnosticsRetryShutdown: {  operation: voiceSettingsOperation('diagnostics_retry_shutdown') },
            },
        },
    },
});

export const VOICE_ADVANCED_SETTINGS = defineSettingsPage({
    pageId: 'voiceAdvanced',
    sections: {
        input: {
            titleKey: 'voicePresence.howYouTalk',
            settings: {
                holdToTalk: {},
            },
        },
        surface: {
            titleKey: 'settingsVoice.pages.advanced.onScreenTitle',
            settings: {
                activityFeedEnabled: { storage: voiceSettingBinding('ui.activityFeedEnabled') },
                activityFeedAutoExpandOnStart: { storage: voiceSettingBinding('ui.activityFeedAutoExpandOnStart') },
                presenceContainer: {},
                scopeDefault: { storage: voiceSettingBinding('ui.scopeDefault') },
            },
        },
        // Moved from the local conversation sections (plan §4.5): one plain request timeout.
        connection: {
            titleKey: 'settingsVoice.pages.advanced.connectionTitle',
            settings: {
                executionMachine: { storage: voiceExecutionMachineBinding },
                networkTimeoutMs: { storage: voiceLocalConversationBinding('networkTimeoutMs') },
            },
        },
        models: {
            titleKey: 'settingsVoice.pages.advanced.speechModelsTitle',
            settings: {
                speechModels: {  operation: voiceSettingsOperation('models_inspect') },
                installSpeechModel: {  operation: voiceSettingsOperation('model_install') },
                removeSpeechModel: {  operation: voiceSettingsOperation('model_remove') },
                defaultSpeechModel: {  operation: voiceSettingsOperation('model_default') },
            },
        },
    },
});
