import { defineSettingsPage, settingsHosts, type SettingRef, type SettingsPageDeclaration } from '@/components/settings/catalog/settingDeclarations';
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
    const entry = voice.providerId ? registry.get(voice.providerId) : null;
    return {
        ...base,
        titleKey: preference.kind === 'single_language' ? 'settingsVoice.pages.conversations.iSpeakTitle' : base.titleKey,
        descriptionKey: preference.kind === 'single_language' ? 'settingsVoice.pages.conversations.languageCoupledDescription' : base.descriptionKey,
        keywordKeys: preference.kind === 'single_language' ? [base.titleKey, ...(base.keywordKeys ?? [])] : base.keywordKeys,
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
                provider: { titleKey: 'settingsVoice.dictation.provider', descriptionKey: 'settingsVoice.dictation.providerSubtitle', storage: voiceSettingBinding('dictation.stt.provider') },
                language: { titleKey: 'settingsVoice.dictation.language', descriptionKey: 'settingsVoice.dictation.languageSubtitle', storage: voiceSettingBinding('dictation.language') },
                sttAssetId: { titleKey: 'settingsVoice.local.localNeuralStt.modelPack.title', storage: voiceSettingBinding('dictation.stt.localNeural.assetId') },
                sttLanguage: { titleKey: 'settingsVoice.local.localNeuralStt.language.title', storage: voiceSettingBinding('dictation.stt.localNeural.language') },
                sttExecution: { titleKey: 'settingsVoice.local.daemonInference.execution.title', storage: voiceSettingBinding('dictation.stt.localNeural.execution') },
                executionMachine: { titleKey: 'settingsVoice.pages.advanced.computerTitle', descriptionKey: 'settingsVoice.pages.advanced.computerDescription', storage: voiceExecutionMachineBinding },
                sttPrepareModel: { titleKey: 'settingsVoice.local.localNeuralStt.modelFiles.title', operation: voiceSettingsOperation('stt_prepare', 'dictation') },
                sttRemoveModel: { titleKey: 'settingsVoice.local.localNeuralStt.removeModelFiles.title', operation: voiceSettingsOperation('stt_remove', 'dictation') },
                sttUpdateModel: { titleKey: 'settingsVoice.local.kokoro.updates.title', host: settingsHosts.native, operation: voiceSettingsOperation('stt_update', 'dictation') },
                readiness: { titleKey: 'settingsVoice.local.models.statusTitle', operation: voiceSettingsOperation('readiness_inspect', 'dictation') },
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
                provider: { titleKey: 'settingsVoice.providerSectionTitle', descriptionKey: 'settingsVoice.providerSectionDescription', storage: voiceSettingBinding('providerId') },
                greeting: { titleKey: 'settingsVoice.pages.conversations.greetingTitle', storage: voiceGreetingBinding },
            },
        },
        language: {
            titleKey: 'settingsVoice.languageTitle',
            settings: {
                assistantLanguage: { titleKey: 'settingsVoice.pages.conversations.replyInTitle', descriptionKey: 'settingsVoice.pages.conversations.replyInDescription', storage: voiceSettingBinding('assistantLanguage') },
            },
        },
        local: {
            titleKey: 'settingsVoice.pages.conversations.thinkTitle',
            settings: {
                conversationMode: { titleKey: 'settingsVoice.pages.conversations.talkToTitle', storage: voiceLocalConversationBinding('conversationMode') },
                executionMachine: { titleKey: 'settingsVoice.pages.advanced.computerTitle', descriptionKey: 'settingsVoice.pages.advanced.computerDescription', storage: voiceExecutionMachineBinding },
                handsFree: { titleKey: 'settingsVoice.local.conversation.handsFree.enableTitle', storage: voiceLocalConversationBinding('handsFree.enabled') },
                silenceMs: { titleKey: 'settingsVoice.local.conversation.handsFree.silenceTitle', storage: voiceLocalConversationBinding('handsFree.endpointing.silenceMs') },
                minSpeechMs: { titleKey: 'settingsVoice.local.conversation.handsFree.minSpeechTitle', storage: voiceLocalConversationBinding('handsFree.endpointing.minSpeechMs') },
                sttProvider: { titleKey: 'settingsVoice.pages.conversations.speechRecognitionTitle', storage: voiceLocalConversationBinding('stt.provider') },
                sttAssetId: { titleKey: 'settingsVoice.local.localNeuralStt.modelPack.title', storage: voiceLocalConversationBinding('stt.localNeural.assetId') },
                sttLanguage: { titleKey: 'settingsVoice.local.localNeuralStt.language.title', storage: voiceLocalConversationBinding('stt.localNeural.language') },
                sttExecution: { titleKey: 'settingsVoice.local.daemonInference.execution.title', storage: voiceLocalConversationBinding('stt.localNeural.execution') },
                sttPrepareModel: { titleKey: 'settingsVoice.local.localNeuralStt.modelFiles.title', operation: voiceSettingsOperation('stt_prepare') },
                sttRemoveModel: { titleKey: 'settingsVoice.local.localNeuralStt.removeModelFiles.title', operation: voiceSettingsOperation('stt_remove') },
                sttUpdateModel: { titleKey: 'settingsVoice.local.kokoro.updates.title', host: settingsHosts.native, operation: voiceSettingsOperation('stt_update') },
                ttsProvider: { titleKey: 'settingsVoice.pages.conversations.voiceEngineTitle', storage: voiceLocalConversationBinding('tts.provider') },
                autoSpeakReplies: { titleKey: 'settingsVoice.local.autoSpeak', descriptionKey: 'settingsVoice.local.autoSpeakSubtitle', storage: voiceLocalConversationBinding('tts.autoSpeakReplies') },
                bargeInEnabled: { titleKey: 'settingsVoice.pages.conversations.interruptTitle', descriptionKey: 'settingsVoice.pages.conversations.interruptDescription', storage: voiceLocalConversationBinding('tts.bargeInEnabled') },
                ttsAssetId: { titleKey: 'settingsVoice.local.kokoro.assetPack.title', storage: voiceLocalConversationBinding('tts.localNeural.assetId') },
                ttsVoiceId: { titleKey: 'settingsVoice.local.kokoro.voice.title', storage: voiceLocalConversationBinding('tts.localNeural.voiceId') },
                ttsSpeed: { titleKey: 'settingsVoice.local.kokoro.speed.title', descriptionKey: 'settingsVoice.local.kokoro.speed.subtitle', storage: voiceLocalConversationBinding('tts.localNeural.speed') },
                ttsExecution: { titleKey: 'settingsVoice.local.daemonInference.execution.title', storage: voiceLocalConversationBinding('tts.localNeural.execution') },
                ttsPrepareModel: { titleKey: 'settingsVoice.local.kokoro.model.title', operation: voiceSettingsOperation('tts_prepare') },
                ttsRemoveModel: { titleKey: 'settingsVoice.local.kokoro.removeAssets.title', operation: voiceSettingsOperation('tts_remove') },
                ttsUpdateModel: { titleKey: 'settingsVoice.local.kokoro.updates.title', host: settingsHosts.native, operation: voiceSettingsOperation('tts_update') },
                ttsPreview: { titleKey: 'settingsVoice.local.kokoro.voice.title', host: settingsHosts.native, operation: voiceSettingsOperation('tts_preview') },
                testTts: { titleKey: 'settingsVoice.local.testTts', descriptionKey: 'settingsVoice.local.testTtsSubtitle', operation: voiceSettingsOperation('tts_test') },
                readiness: { titleKey: 'settingsVoice.local.models.statusTitle', operation: voiceSettingsOperation('readiness_inspect') },
                agentSource: { titleKey: 'settingsVoice.local.mediatorAgentSource', storage: voiceLocalConversationBinding('agent.agentSource') },
                agent: { titleKey: 'settingsVoice.local.mediatorAgentId', storage: voiceAgentSelectionBinding },
                customAgent: { titleKey: 'settingsVoice.local.mediatorAgentId', descriptionKey: 'settingsVoice.local.conversation.customBackendIdSubtitle', storage: voiceCustomAgentBinding },
                permissionIntent: { titleKey: 'settingsVoice.pages.conversations.itMayTitle', storage: voiceLocalConversationBinding('agent.permissionIntent') },
                chatModelSource: { titleKey: 'settingsVoice.local.mediatorChatModelSource', storage: voiceLocalConversationBinding('agent.chatModelSource') },
                chatModelId: { titleKey: 'settingsVoice.local.conversation.chatModelId.title', storage: voiceLocalConversationBinding('agent.chatModelId') },
                commitModelSource: { titleKey: 'settingsVoice.local.mediatorCommitModelSource', storage: voiceLocalConversationBinding('agent.commitModelSource') },
                commitModelId: { titleKey: 'settingsVoice.local.conversation.commitModelId.title', storage: voiceLocalConversationBinding('agent.commitModelId') },
                verbosity: { titleKey: 'settingsVoice.pages.conversations.repliesTitle', storage: voiceLocalConversationBinding('agent.verbosity') },
            },
        },
        agentLifecycle: {
            titleKey: 'settingsVoice.local.conversation.rootSessionPolicy.title',
            settings: {
                stayInVoiceHome: { titleKey: 'settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle', storage: voiceLocalConversationBinding('agent.stayInVoiceHome') },
                teleportEnabled: { titleKey: 'settingsVoice.local.conversation.agentMachine.allowTeleportTitle', storage: voiceLocalConversationBinding('agent.teleportEnabled') },
                rootSessionPolicy: { titleKey: 'settingsVoice.local.conversation.rootSessionPolicy.title', storage: voiceLocalConversationBinding('agent.rootSessionPolicy') },
                maxWarmRoots: { titleKey: 'settingsVoice.local.conversation.rootSessionPolicy.maxWarmRootsTitle', storage: voiceLocalConversationBinding('agent.maxWarmRoots') },
                idleTtlSeconds: { titleKey: 'settingsVoice.local.mediatorIdleTtl', storage: voiceLocalConversationBinding('agent.idleTtlSeconds') },
                prewarmOnConnect: { titleKey: 'settingsVoice.local.conversation.prewarm.title', storage: voiceLocalConversationBinding('agent.prewarmOnConnect') },
                commitIsolation: { titleKey: 'settingsVoice.local.conversation.commitIsolation.title', storage: voiceLocalConversationBinding('agent.commitIsolation') },
            },
        },
        streaming: {
            titleKey: 'settingsVoice.local.conversation.streaming.enableTitle',
            settings: {
                streamingEnabled: { titleKey: 'settingsVoice.local.conversation.streaming.enableTitle', storage: voiceLocalConversationBinding('streaming.enabled') },
                streamingTtsEnabled: { titleKey: 'settingsVoice.local.conversation.streaming.enableTtsTitle', storage: voiceLocalConversationBinding('streaming.ttsEnabled') },
                ttsChunkChars: { titleKey: 'settingsVoice.local.conversation.streaming.ttsChunkCharsTitle', storage: voiceLocalConversationBinding('streaming.ttsChunkChars') },
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
                currentUiContextMode: { titleKey: 'settingsVoice.pages.privacy.screenTitle', descriptionKey: 'settingsVoice.pages.privacy.screenDescription', storage: voiceSettingBinding('privacy.currentUiContextMode') },
                shareSessionSummary: { titleKey: 'settingsVoice.pages.privacy.summariesTitle', storage: voiceSettingBinding('privacy.shareSessionSummary') },
                shareRecentMessages: { titleKey: 'settingsVoice.pages.privacy.recentTitle', descriptionKey: 'settingsVoice.pages.privacy.recentDescription', storage: voiceSettingBinding('privacy.shareRecentMessages') },
                recentMessagesCount: { titleKey: 'settingsVoice.pages.privacy.recentCountTitle', descriptionKey: 'settingsVoice.pages.privacy.recentCountDescription', storage: voiceSettingBinding('privacy.recentMessagesCount') },
                shareToolNames: { titleKey: 'settingsVoice.pages.privacy.toolsTitle', descriptionKey: 'settingsVoice.pages.privacy.toolsDescription', storage: voiceSettingBinding('privacy.shareToolNames') },
                sharePermissionRequests: { titleKey: 'settingsVoice.pages.privacy.permissionsTitle', descriptionKey: 'settingsVoice.pages.privacy.permissionsDescription', storage: voiceSettingBinding('privacy.sharePermissionRequests') },
                shareDeviceInventory: { titleKey: 'settingsVoice.pages.privacy.devicesTitle', descriptionKey: 'settingsVoice.pages.privacy.devicesDescription', storage: voiceSettingBinding('privacy.shareDeviceInventory') },
            },
        },
        // Moved from Advanced (plan §4.5): ongoing snippets are what the service reads while you talk.
        updates: {
            titleKey: 'settingsVoice.pages.privacy.liveTitle',
            settings: {
                activeSession: { titleKey: 'settingsVoice.pages.privacy.liveActiveTitle', storage: voiceSettingBinding('ui.updates.activeSession') },
                otherSessions: { titleKey: 'settingsVoice.pages.privacy.liveOtherTitle', storage: voiceSettingBinding('ui.updates.otherSessions') },
                snippetsMaxMessages: { titleKey: 'settingsVoice.pages.privacy.livePerUpdateTitle', storage: voiceSettingBinding('ui.updates.snippetsMaxMessages') },
                includeUserMessagesInSnippets: { titleKey: 'settingsVoice.pages.privacy.liveIncludeMineTitle', descriptionKey: 'settingsVoice.pages.privacy.liveIncludeMineDescription', storage: voiceSettingBinding('ui.updates.includeUserMessagesInSnippets') },
                otherSessionsSnippetsMode: { titleKey: 'settingsVoice.pages.privacy.liveOtherModeTitle', storage: voiceSettingBinding('ui.updates.otherSessionsSnippetsMode') },
            },
        },
        // Voice agent memory (plan §4.5): remembering, how it is restored, and the Forget operation.
        memory: {
            titleKey: 'settingsVoice.pages.privacy.memoryTitle',
            settings: {
                rememberPastConversations: { titleKey: 'settingsVoice.pages.privacy.rememberTitle', descriptionKey: 'settingsVoice.pages.privacy.rememberOffDescription', storage: voiceLocalConversationBinding('agent.transcript.persistenceMode') },
                restoreMemoryBy: { titleKey: 'settingsVoice.pages.privacy.restoreTitle', storage: voiceMemoryRestoreBinding },
                fallbackToReplay: { titleKey: 'settingsVoice.pages.privacy.fallbackTitle', descriptionKey: 'settingsVoice.pages.privacy.fallbackDescription', storage: voiceLocalConversationBinding('agent.providerResume.fallbackToReplay') },
                restoreMessagesCount: { titleKey: 'settingsVoice.pages.privacy.restoreCountTitle', descriptionKey: 'settingsVoice.pages.privacy.restoreCountDescription', storage: voiceLocalConversationBinding('agent.replay.recentMessagesCount') },
                forgetVoiceAgentMemory: { titleKey: 'settingsVoice.pages.privacy.forgetTitle', descriptionKey: 'settingsVoice.pages.privacy.forgetDescription', operation: voiceSettingsOperation('memory_forget') },
            },
        },
        history: {
            titleKey: 'settingsVoice.history.sectionTitle',
            settings: {
                voiceHistory: { titleKey: 'settingsVoice.history.entryTitle', descriptionKey: 'settingsVoice.history.entrySubtitle' },
            },
        },
        diagnostics: {
            titleKey: 'settingsVoice.diagnostics.title',
            settings: {
                diagnosticsEnabled: { titleKey: 'settingsVoice.diagnostics.enabled', descriptionKey: 'settingsVoice.diagnostics.enabledSubtitle', storage: { ...voiceSettingBinding('diagnostics.enabled'), access: 'read_only' }, operation: voiceSettingsOperation('diagnostics_enabled') },
                diagnosticsSttInput: { titleKey: 'settingsVoice.diagnostics.sttInput', storage: voiceDiagnosticsCaptureBinding('captureSttInput') },
                diagnosticsTtsOutput: { titleKey: 'settingsVoice.diagnostics.ttsOutput', storage: voiceDiagnosticsCaptureBinding('captureTtsOutput') },
                diagnosticsLocation: { titleKey: 'settingsVoice.diagnostics.location', operation: voiceSettingsOperation('diagnostics_inspect') },
                diagnosticsRetention: { titleKey: 'settingsVoice.diagnostics.retention' },
                diagnosticsBackupPolicy: { titleKey: 'settingsVoice.diagnostics.backupPolicy' },
                diagnosticsExport: { titleKey: 'settingsVoice.diagnostics.exportTitle', operation: voiceSettingsOperation('diagnostics_export') },
                diagnosticsCleanup: { titleKey: 'settingsVoice.diagnostics.retryCleanup', descriptionKey: 'settingsVoice.diagnostics.retryCleanupSubtitle', operation: voiceSettingsOperation('diagnostics_cleanup') },
                diagnosticsDelete: { titleKey: 'settingsVoice.diagnostics.deleteAll', descriptionKey: 'settingsVoice.diagnostics.deleteAllSubtitle', operation: voiceSettingsOperation('diagnostics_delete') },
                diagnosticsSessionOptOut: { titleKey: 'settingsVoice.diagnostics.sessionOptOut', operation: voiceSettingsOperation('diagnostics_session_opt_out') },
                diagnosticsRetryShutdown: { titleKey: 'settingsVoice.diagnostics.retryShutdown', operation: voiceSettingsOperation('diagnostics_retry_shutdown') },
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
                holdToTalk: { titleKey: 'voicePresence.holdToTalkTitle', descriptionKey: 'voicePresence.holdToTalkDescription', storage: { scope: 'local', key: 'voiceHoldToTalkEnabled', access: 'read_write', allowedValues: [false, true] } },
            },
        },
        surface: {
            titleKey: 'settingsVoice.pages.advanced.onScreenTitle',
            settings: {
                activityFeedEnabled: { titleKey: 'settingsVoice.pages.advanced.transcriptTitle', descriptionKey: 'settingsVoice.pages.advanced.transcriptDescription', storage: voiceSettingBinding('ui.activityFeedEnabled') },
                activityFeedAutoExpandOnStart: { titleKey: 'settingsVoice.pages.advanced.autoOpenTitle', descriptionKey: 'settingsVoice.pages.advanced.autoOpenDescription', storage: voiceSettingBinding('ui.activityFeedAutoExpandOnStart') },
                presenceContainer: { titleKey: 'settingsVoice.pages.advanced.showLiveAsTitle', descriptionKey: 'settingsVoice.pages.advanced.showLiveAsDescription', storage: { scope: 'local', key: 'voicePresenceContainer', access: 'read_write', allowedValues: [null, 'top_bar', 'island', 'orb'] } },
                scopeDefault: { titleKey: 'settingsVoice.pages.advanced.scopeTitle', storage: voiceSettingBinding('ui.scopeDefault') },
            },
        },
        // Moved from the local conversation sections (plan §4.5): one plain request timeout.
        connection: {
            titleKey: 'settingsVoice.pages.advanced.connectionTitle',
            settings: {
                executionMachine: { titleKey: 'settingsVoice.pages.advanced.computerTitle', descriptionKey: 'settingsVoice.pages.advanced.computerDescription', storage: voiceExecutionMachineBinding },
                networkTimeoutMs: { titleKey: 'settingsVoice.pages.advanced.timeoutTitle', descriptionKey: 'settingsVoice.pages.advanced.timeoutDescription', storage: voiceLocalConversationBinding('networkTimeoutMs') },
            },
        },
        models: {
            titleKey: 'settingsVoice.pages.advanced.speechModelsTitle',
            settings: {
                speechModels: { titleKey: 'settingsVoice.pages.advanced.speechModelsTitle', operation: voiceSettingsOperation('models_inspect') },
                installSpeechModel: { titleKey: 'settingsVoice.local.models.installSubtitle', operation: voiceSettingsOperation('model_install') },
                removeSpeechModel: { titleKey: 'settingsVoice.local.models.removeConfirmTitle', operation: voiceSettingsOperation('model_remove') },
                defaultSpeechModel: { titleKey: 'settingsVoice.local.models.setDefaultSubtitle', operation: voiceSettingsOperation('model_default') },
            },
        },
    },
});
