import type { FeatureId } from '@happier-dev/protocol';
import type { Settings } from '@/sync/domains/settings/settings';

type FeatureLocalPolicyResolver = (settings: Settings) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Record<FeatureId, FeatureLocalPolicyResolver>> = {
    automations: (settings) => settings.experiments === true && settings.expAutomations !== false,
    'automations.existingSessionTarget': (settings) => settings.experiments === true && settings.expAutomations !== false,
    voice: () => true,
    'social.friends': (settings) => settings.experiments === true && settings.expInboxFriends === true,
    'auth.recovery.providerReset': () => true,
    'auth.ui.recoveryKeyReminder': () => true,
    bugReports: () => true,
    'scm.writeOperations': (settings) => settings.experiments === true && settings.expScmOperations === true,
    'session.typeSelector': (settings) => settings.experiments === true && settings.expSessionType === true,
    'zen.navigation': (settings) => settings.experiments === true && settings.expZen === true,
    'inbox.friends': (settings) => settings.experiments === true && settings.expInboxFriends === true,
    'usage.reporting': (settings) => settings.experiments === true && settings.expUsageReporting === true,
    'messages.thinkingVisibility': (settings) => settings.experiments === true && settings.expShowThinkingMessages === true,
    'codex.resume.mcp': (settings) => settings.codexBackendMode === 'mcp_resume',
    'codex.resume.acp': (settings) => settings.codexBackendMode === 'acp',
};

export function resolveLocalFeaturePolicyEnabled(featureId: FeatureId, settings: Settings): boolean {
    return LOCAL_POLICY_BY_FEATURE[featureId](settings);
}
