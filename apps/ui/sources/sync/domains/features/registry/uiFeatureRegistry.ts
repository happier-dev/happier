import type { FeatureId } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

export type UiFeatureDefinition = Readonly<{
    settingsToggle?: Readonly<{
        showInSettings: boolean;
        isExperimental: boolean;
        defaultEnabled: boolean;
        titleKey: TranslationKey;
        subtitleKey: TranslationKey;
        icon: Readonly<{
            ioniconName: string;
            color: string;
        }>;
    }>;
}>;

export const UI_FEATURE_REGISTRY = {
    automations: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expAutomations',
            subtitleKey: 'settingsFeatures.expAutomationsSubtitle',
            icon: { ioniconName: 'timer-outline', color: '#007AFF' },
        },
    },
    'execution.runs': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expExecutionRuns',
            subtitleKey: 'settingsFeatures.expExecutionRunsSubtitle',
            icon: { ioniconName: 'code-slash-outline', color: '#AF52DE' },
        },
    },
    voice: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.voice',
            subtitleKey: 'settingsFeatures.voiceSubtitle',
            icon: { ioniconName: 'mic-outline', color: '#34C759' },
        },
    },
    'voice.happierVoice': {
        settingsToggle: undefined,
    },
    'voice.agent': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expVoiceAgent',
            subtitleKey: 'settingsFeatures.expVoiceAgentSubtitle',
            icon: { ioniconName: 'sparkles-outline', color: '#AF52DE' },
        },
    },
    connectedServices: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expConnectedServices',
            subtitleKey: 'settingsFeatures.expConnectedServicesSubtitle',
            icon: { ioniconName: 'link-outline', color: '#007AFF' },
        },
    },
    'connectedServices.quotas': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expConnectedServicesQuotas',
            subtitleKey: 'settingsFeatures.expConnectedServicesQuotasSubtitle',
            icon: { ioniconName: 'analytics-outline', color: '#34C759' },
        },
    },
    'updates.ota': {
        settingsToggle: undefined,
    },
    'sharing.session': {
        settingsToggle: undefined,
    },
    'sharing.public': {
        settingsToggle: undefined,
    },
    'sharing.contentKeys': {
        settingsToggle: undefined,
    },
    'sharing.pendingQueueV2': {
        settingsToggle: undefined,
    },
    'social.friends': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            // Historically not auto-enabled by the experiments master switch; keep it opt-in.
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFriends',
            subtitleKey: 'settingsFeatures.expFriendsSubtitle',
            icon: { ioniconName: 'people-outline', color: '#007AFF' },
        },
    },
    'auth.recovery.providerReset': {
        settingsToggle: undefined,
    },
    'auth.ui.recoveryKeyReminder': {
        settingsToggle: undefined,
    },
    'app.analytics': {
        settingsToggle: undefined,
    },
    'app.ui.storeReviewPrompts': {
        settingsToggle: undefined,
    },
    'app.ui.sessionGettingStartedGuidance': {
        settingsToggle: undefined,
    },
    'app.ui.changelog': {
        settingsToggle: undefined,
    },
    bugReports: {
        settingsToggle: undefined,
    },
    'attachments.uploads': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expAttachmentsUploads',
            subtitleKey: 'settingsFeatures.expAttachmentsUploadsSubtitle',
            icon: { ioniconName: 'attach-outline', color: '#007AFF' },
        },
    },
    'scm.writeOperations': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expScmOperations',
            subtitleKey: 'settingsFeatures.expScmOperationsSubtitle',
            icon: { ioniconName: 'git-branch-outline', color: '#FF9500' },
        },
    },
    'files.reviewComments': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFilesReviewComments',
            subtitleKey: 'settingsFeatures.expFilesReviewCommentsSubtitle',
            icon: { ioniconName: 'chatbox-ellipses-outline', color: '#34C759' },
        },
    },
    'files.diffSyntaxHighlighting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesDiffSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesDiffSyntaxHighlightingSubtitle',
            icon: { ioniconName: 'color-palette-outline', color: '#007AFF' },
        },
    },
    'files.syntaxHighlighting.advanced': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlightingSubtitle',
            icon: { ioniconName: 'sparkles-outline', color: '#AF52DE' },
        },
    },
    'memory.search': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expMemorySearch',
            subtitleKey: 'settingsFeatures.expMemorySearchSubtitle',
            icon: { ioniconName: 'search-outline', color: '#34C759' },
        },
    },
    'files.editor': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFilesEditor',
            subtitleKey: 'settingsFeatures.expFilesEditorSubtitle',
            icon: { ioniconName: 'create-outline', color: '#FF9500' },
        },
    },
    'session.typeSelector': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expSessionType',
            subtitleKey: 'settingsFeatures.expSessionTypeSubtitle',
            icon: { ioniconName: 'layers-outline', color: '#AF52DE' },
        },
    },
    'zen.navigation': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expZen',
            subtitleKey: 'settingsFeatures.expZenSubtitle',
            icon: { ioniconName: 'leaf-outline', color: '#34C759' },
        },
    },
    'usage.reporting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expUsageReporting',
            subtitleKey: 'settingsFeatures.expUsageReportingSubtitle',
            icon: { ioniconName: 'analytics-outline', color: '#007AFF' },
        },
    },
    'messages.thinkingVisibility': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expShowThinkingMessages',
            subtitleKey: 'settingsFeatures.expShowThinkingMessagesSubtitle',
            icon: { ioniconName: 'chatbubbles-outline', color: '#34C759' },
        },
    },
    'codex.resume.mcp': {
        settingsToggle: undefined,
    },
    'codex.resume.acp': {
        settingsToggle: undefined,
    },
} satisfies Readonly<Record<FeatureId, UiFeatureDefinition>>;

export function getUiFeatureDefinition(featureId: FeatureId): UiFeatureDefinition {
    return UI_FEATURE_REGISTRY[featureId];
}
