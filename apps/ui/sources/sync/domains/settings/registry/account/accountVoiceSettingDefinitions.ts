import {
    VoiceSpeechDiagnosticsSettingsV1Schema,
    defineSettingDefinitions,
} from '@happier-dev/protocol';

import {
    VoiceSettingsSchema,
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    voiceSettingsDefaults,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
    VoiceSettingsPersistenceV1Schema,
    voiceSettingsPersistenceV1Defaults,
} from '@/sync/domains/settings/voiceSettingsPersistence';
import { BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES } from '@/voice/registry/generatedBundledVoiceEntries';
import { createVoiceProviderSettingsCatalog } from '@/voice/settings/providerSettings';

function hasNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function hasSecretValue(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (hasNonEmptyString(record.value)) return true;
    const encrypted = record.encryptedValue;
    return !!(encrypted && typeof encrypted === 'object' && !Array.isArray(encrypted));
}

function bucketCount(value: number, mediumMax: number, largeMax: number): 'small' | 'medium' | 'large' {
    if (value <= mediumMax) return 'small';
    if (value <= largeMax) return 'medium';
    return 'large';
}

function bucketTimeoutMs(value: number): 'small' | 'medium' | 'large' {
    if (value <= 10_000) return 'small';
    if (value <= 20_000) return 'medium';
    return 'large';
}

function bucketEndpointingMs(value: number): 'tight' | 'balanced' | 'loose' {
    if (value <= 500) return 'tight';
    if (value <= 2_000) return 'balanced';
    return 'loose';
}

function bucketTemperature(value: number): 'low' | 'medium' | 'high' {
    if (value <= 0.5) return 'low';
    if (value <= 1.0) return 'medium';
    return 'high';
}

function bucketNullableMaxTokens(value: number | null): 'none' | 'small' | 'medium' | 'large' {
    if (value == null) return 'none';
    if (value <= 1024) return 'small';
    if (value <= 4096) return 'medium';
    return 'large';
}

function bucketTurnStreamTimeoutMs(value: number | null): 'none' | 'small' | 'medium' | 'large' {
    if (value == null) return 'none';
    if (value <= 120_000) return 'small';
    if (value <= 300_000) return 'medium';
    return 'large';
}

const providerSettingsCatalog = createVoiceProviderSettingsCatalog({
    bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES,
});

function buildVoiceSummaryProperties(rawValue: VoiceSettings): Record<string, boolean | string> {
    const value = rawValue ?? voiceSettingsDefaults;
    const localDirect = readLocalDirectVoiceSettings(value);
    const localConversation = readLocalConversationVoiceSettings(value);
    const localAgent = localConversation.agent;

    return {
        providerId: value.providerId ?? 'off',
        uiScopeDefault: value.ui.scopeDefault,
        uiSurfaceLocation: value.ui.surfaceLocation,
        uiActivityFeedEnabled: value.ui.activityFeedEnabled,
        uiActivityFeedAutoExpandOnStart: value.ui.activityFeedAutoExpandOnStart,
        uiUpdatesActiveSession: value.ui.updates.activeSession,
        uiUpdatesOtherSessions: value.ui.updates.otherSessions,
        uiUpdatesSnippetsMaxMessagesBucket: bucketCount(value.ui.updates.snippetsMaxMessages, 3, 6),
        uiUpdatesIncludeUserMessagesInSnippets: value.ui.updates.includeUserMessagesInSnippets,
        uiUpdatesOtherSessionsSnippetsMode: value.ui.updates.otherSessionsSnippetsMode,

        privacyShareSessionSummary: value.privacy.shareSessionSummary,
        privacyShareRecentMessages: value.privacy.shareRecentMessages,
        privacyRecentMessagesCountBucket: bucketCount(value.privacy.recentMessagesCount, 5, 10),
        privacyShareToolNames: value.privacy.shareToolNames,
        privacySharePermissionRequests: value.privacy.sharePermissionRequests,
        privacyShareDeviceInventory: value.privacy.shareDeviceInventory,

        assistantLanguageConfigured: hasNonEmptyString(value.assistantLanguage),
        welcomeEnabled: value.welcome.enabled,
        welcomeMode: value.welcome.mode,
        welcomeTemplateConfigured: hasNonEmptyString(value.welcome.templateId),

        ...providerSettingsCatalog.projectAnalytics(value.providers),

        localDirectNetworkTimeoutBucket: bucketTimeoutMs(localDirect.networkTimeoutMs),
        localDirectHandsFreeEnabled: localDirect.handsFree.enabled,
        localDirectHandsFreeSilenceBucket: bucketEndpointingMs(localDirect.handsFree.endpointing.silenceMs),
        localDirectHandsFreeMinSpeechBucket: bucketEndpointingMs(localDirect.handsFree.endpointing.minSpeechMs),

        localConversationConversationMode: localConversation.conversationMode,
        localConversationNetworkTimeoutBucket: bucketTimeoutMs(localConversation.networkTimeoutMs),
        localConversationHandsFreeEnabled: localConversation.handsFree.enabled,
        localConversationHandsFreeSilenceBucket: bucketEndpointingMs(localConversation.handsFree.endpointing.silenceMs),
        localConversationHandsFreeMinSpeechBucket: bucketEndpointingMs(localConversation.handsFree.endpointing.minSpeechMs),
        localConversationAgentBackend: localAgent.backend,
        localConversationAgentAgentSource: localAgent.agentSource,
        localConversationAgentMachineTargetMode: value.executionMachine.mode,
        localConversationAgentFixedMachineConfigured: hasNonEmptyString(value.executionMachine.machineId),
        localConversationAgentStayInVoiceHome: localAgent.stayInVoiceHome,
        localConversationAgentTeleportEnabled: localAgent.teleportEnabled,
        localConversationAgentRootSessionPolicy: localAgent.rootSessionPolicy,
        localConversationAgentMaxWarmRootsBucket: bucketCount(localAgent.maxWarmRoots, 3, 5),
        localConversationAgentCustomVoiceHomeConfigured:
            localAgent.voiceHomeSubdirName !== readLocalConversationVoiceSettings(voiceSettingsDefaults).agent.voiceHomeSubdirName,
        localConversationAgentPermissionPolicy: localAgent.permissionIntent,
        localConversationAgentIdleTtlBucket: bucketCount(localAgent.idleTtlSeconds, 1800, 7200),
        localConversationAgentPrewarmOnConnect: localAgent.prewarmOnConnect,
        localConversationAgentResumabilityMode: localAgent.resumabilityMode,
        localConversationAgentProviderResumeFallbackToReplay: localAgent.providerResume.fallbackToReplay,
        localConversationAgentReplayStrategy: localAgent.replay.strategy,
        localConversationAgentReplayRecentMessagesBucket: bucketCount(localAgent.replay.recentMessagesCount, 16, 32),
        localConversationAgentCommitIsolation: localAgent.commitIsolation,
        localConversationAgentTranscriptPersistenceMode: localAgent.transcript.persistenceMode,
        localConversationAgentChatModelSource: localAgent.chatModelSource,
        localConversationAgentCustomChatModelConfigured: localAgent.chatModelId !== 'default',
        localConversationAgentCommitModelSource: localAgent.commitModelSource,
        localConversationAgentCustomCommitModelConfigured: localAgent.commitModelId !== 'default',
        localConversationAgentOpenaiCompatChatBaseUrlConfigured: hasNonEmptyString(localAgent.openaiCompat.chatBaseUrl),
        localConversationAgentOpenaiCompatChatApiKeyConfigured: hasSecretValue(localAgent.openaiCompat.chatApiKey),
        localConversationAgentOpenaiCompatChatModelConfigured: localAgent.openaiCompat.chatModel !== 'default',
        localConversationAgentOpenaiCompatCommitModelConfigured: localAgent.openaiCompat.commitModel !== 'default',
        localConversationAgentOpenaiCompatTemperatureBucket: bucketTemperature(localAgent.openaiCompat.temperature),
        localConversationAgentOpenaiCompatMaxTokensBucket: bucketNullableMaxTokens(localAgent.openaiCompat.maxTokens),
        localConversationAgentVerbosity: localAgent.verbosity,
        localConversationStreamingEnabled: localConversation.streaming.enabled,
        localConversationStreamingTtsEnabled: localConversation.streaming.ttsEnabled,
        localConversationStreamingTtsChunkCharsBucket: bucketCount(localConversation.streaming.ttsChunkChars, 200, 500),
        localConversationStreamingTurnReadPollIntervalBucket: bucketCount(localConversation.streaming.turnReadPollIntervalMs, 50, 150),
        localConversationStreamingTurnReadMaxEventsBucket: bucketCount(localConversation.streaming.turnReadMaxEvents, 64, 96),
        localConversationStreamingTurnStreamTimeoutBucket: bucketTurnStreamTimeoutMs(localConversation.streaming.turnStreamTimeoutMs),
    };
}

export const ACCOUNT_VOICE_SETTING_DEFINITIONS = defineSettingDefinitions({
    voiceSettingsV1: {
        schema: VoiceSettingsPersistenceV1Schema,
        default: voiceSettingsPersistenceV1Defaults,
        description: 'Canonical persisted Voice settings',
        storageScope: 'account',
    },
    voiceDiagnosticsV1: {
        schema: VoiceSpeechDiagnosticsSettingsV1Schema,
        default: VoiceSpeechDiagnosticsSettingsV1Schema.parse({}),
        description: 'Local speech diagnostics policy',
        storageScope: 'account',
    },
    voice: {
        schema: VoiceSettingsSchema,
        default: voiceSettingsDefaults,
        description: 'Voice settings',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrentProperties: buildVoiceSummaryProperties,
        },
    },
});
