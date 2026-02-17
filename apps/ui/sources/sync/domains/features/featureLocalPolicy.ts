import { parseBooleanEnv, type FeatureId } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveUiFeatureToggleEnabled } from './featureRegistry';

type FeatureLocalPolicyResolver = (settings: Settings) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
    automations: (settings) => resolveUiFeatureToggleEnabled(settings, 'automations'),
    // Existing-session targeting is a subordinate capability of automations; keep it tied to the parent toggle.
    'automations.existingSessionTarget': (settings) => resolveUiFeatureToggleEnabled(settings, 'automations'),
    'execution.runs': (settings) => resolveUiFeatureToggleEnabled(settings, 'execution.runs'),
    voice: (settings) => resolveUiFeatureToggleEnabled(settings, 'voice'),
    connectedServices: () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED, true),
    'connectedServices.quotas': () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, false),
    'updates.ota': () => parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_UPDATES_OTA__ENABLED, true),
    'social.friends': (settings) => resolveUiFeatureToggleEnabled(settings, 'social.friends'),
    'auth.recovery.providerReset': () => true,
    'auth.ui.recoveryKeyReminder': () => true,
    'app.analytics': () => true,
    'app.ui.storeReviewPrompts': () => true,
    'app.ui.sessionGettingStartedGuidance': () => true,
    'app.ui.changelog': () => true,
    bugReports: () => true,
    'scm.writeOperations': (settings) => resolveUiFeatureToggleEnabled(settings, 'scm.writeOperations'),
    'files.reviewComments': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.reviewComments'),
    'files.diffSyntaxHighlighting': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.diffSyntaxHighlighting'),
    'files.editor': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.editor'),
    'files.syntaxHighlighting.advanced': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.syntaxHighlighting.advanced'),
    'session.typeSelector': (settings) => resolveUiFeatureToggleEnabled(settings, 'session.typeSelector'),
    'zen.navigation': (settings) => resolveUiFeatureToggleEnabled(settings, 'zen.navigation'),
    'usage.reporting': (settings) => resolveUiFeatureToggleEnabled(settings, 'usage.reporting'),
    'messages.thinkingVisibility': (settings) => resolveUiFeatureToggleEnabled(settings, 'messages.thinkingVisibility'),
    'codex.resume.mcp': (settings) => settings.codexBackendMode === 'mcp_resume',
    'codex.resume.acp': (settings) => settings.codexBackendMode === 'acp',
};

export function resolveLocalFeaturePolicyEnabled(featureId: FeatureId, settings: Settings): boolean {
    const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
    if (!resolver) return true;
    return resolver(settings);
}
