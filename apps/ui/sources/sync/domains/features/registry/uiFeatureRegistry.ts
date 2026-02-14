import type { FeatureId } from '@happier-dev/protocol';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

export type UiFeatureDefinition = Readonly<{
    id: FeatureId;
    serverRequired: boolean;
    serverEnabled: (features: ServerFeatures) => boolean;
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

const ALWAYS_ENABLED = () => true;

export const UI_FEATURE_REGISTRY: Readonly<Record<FeatureId, UiFeatureDefinition>> = {
    automations: {
        id: 'automations',
        serverRequired: true,
        serverEnabled: (features) => features.features.automations.enabled === true,
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expAutomations',
            subtitleKey: 'settingsFeatures.expAutomationsSubtitle',
            icon: { ioniconName: 'timer-outline', color: '#007AFF' },
        },
    },
    'automations.existingSessionTarget': {
        id: 'automations.existingSessionTarget',
        serverRequired: true,
        serverEnabled: (features) => features.features.automations.enabled === true && features.features.automations.existingSessionTarget === true,
    },
    'execution.runs': {
        id: 'execution.runs',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'voice',
        serverRequired: true,
        serverEnabled: (features) => features.features.voice.enabled === true,
    },
    'social.friends': {
        id: 'social.friends',
        serverRequired: true,
        serverEnabled: (features) => features.features.social.friends.enabled === true,
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
        id: 'auth.recovery.providerReset',
        serverRequired: true,
        serverEnabled: (features) => features.features.auth.recovery.providerReset.enabled === true,
    },
    'auth.ui.recoveryKeyReminder': {
        id: 'auth.ui.recoveryKeyReminder',
        serverRequired: true,
        serverEnabled: (features) => features.features.auth.ui.recoveryKeyReminder.enabled === true,
    },
    bugReports: {
        id: 'bugReports',
        serverRequired: true,
        serverEnabled: (features) => features.features.bugReports.enabled === true,
    },
    'scm.writeOperations': {
        id: 'scm.writeOperations',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'files.reviewComments',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'files.diffSyntaxHighlighting',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'files.syntaxHighlighting.advanced',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlightingSubtitle',
            icon: { ioniconName: 'sparkles-outline', color: '#AF52DE' },
        },
    },
    'files.editor': {
        id: 'files.editor',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'session.typeSelector',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'zen.navigation',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'usage.reporting',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'messages.thinkingVisibility',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
        id: 'codex.resume.mcp',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'codex.resume.acp': {
        id: 'codex.resume.acp',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
};

export function getUiFeatureDefinition(featureId: FeatureId): UiFeatureDefinition {
    return UI_FEATURE_REGISTRY[featureId];
}
