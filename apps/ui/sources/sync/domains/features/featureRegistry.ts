import type { FeatureId } from '@happier-dev/protocol';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

export type UiFeatureDefinition = Readonly<{
    id: FeatureId;
    serverRequired: boolean;
    serverEnabled: (features: ServerFeatures) => boolean;
}>;

const ALWAYS_ENABLED = () => true;

export const UI_FEATURE_REGISTRY: Readonly<Record<FeatureId, UiFeatureDefinition>> = {
    automations: {
        id: 'automations',
        serverRequired: true,
        serverEnabled: (features) => features.features.automations.enabled === true,
    },
    'automations.existingSessionTarget': {
        id: 'automations.existingSessionTarget',
        serverRequired: true,
        serverEnabled: (features) => features.features.automations.enabled === true && features.features.automations.existingSessionTarget === true,
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
    },
    'files.reviewComments': {
        id: 'files.reviewComments',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'files.diffSyntaxHighlighting': {
        id: 'files.diffSyntaxHighlighting',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'files.editor': {
        id: 'files.editor',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'files.syntaxHighlighting.advanced': {
        id: 'files.syntaxHighlighting.advanced',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'session.typeSelector': {
        id: 'session.typeSelector',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'zen.navigation': {
        id: 'zen.navigation',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'inbox.friends': {
        id: 'inbox.friends',
        serverRequired: true,
        serverEnabled: (features) => features.features.social.friends.enabled === true,
    },
    'usage.reporting': {
        id: 'usage.reporting',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
    },
    'messages.thinkingVisibility': {
        id: 'messages.thinkingVisibility',
        serverRequired: false,
        serverEnabled: ALWAYS_ENABLED,
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
