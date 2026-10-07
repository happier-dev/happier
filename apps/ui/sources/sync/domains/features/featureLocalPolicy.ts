import { parseBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveUiFeatureToggleEnabled } from './featureRegistry';

export type FeatureLocalPolicySettings = Readonly<Pick<Settings, 'experiments' | 'featureToggles'>>;

type FeatureLocalPolicyResolver = (settings: FeatureLocalPolicySettings) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
    automations: (settings) => resolveUiFeatureToggleEnabled(settings, 'automations'),
    'execution.runs': (settings) => resolveUiFeatureToggleEnabled(settings, 'execution.runs'),
    'pets.companion': (settings) => resolveUiFeatureToggleEnabled(settings, 'pets.companion'),
    voice: (settings) => resolveUiFeatureToggleEnabled(settings, 'voice'),
    'voice.agent': (settings) => resolveUiFeatureToggleEnabled(settings, 'voice.agent'),
    'voice.daemonInference': (settings) => resolveUiFeatureToggleEnabled(settings, 'voice.daemonInference'),
    // Usage is shown wherever the Home serves it; its server bit is the only decision (the former
    // experimental, off-by-default switch existed only while the surfaces were unvalidated).
    'connectedServices.quotas': () => true,
    'updates.ota': () => parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_UPDATES_OTA__ENABLED, true),
    'attachments.uploads': (settings) => resolveUiFeatureToggleEnabled(settings, 'attachments.uploads'),
    'social.friends': (settings) => resolveUiFeatureToggleEnabled(settings, 'social.friends'),
    'auth.recovery.providerReset': () => true,
    'auth.ui.recoveryKeyReminder': () => true,
    'app.analytics': () => true,
    'app.ui.storeReviewPrompts': () => true,
    'app.ui.sessionGettingStartedGuidance': () => true,
    'app.ui.changelog': () => true,
    // The unfinished demo journey is intentionally paused. Keep its implementation available for
    // future work, but do not let legacy rollout configuration mount or load it in pre-auth flows.
    'app.ui.onboardingTour': () => false,
    'app.ui.liveActivities': (settings) => resolveUiFeatureToggleEnabled(settings, 'app.ui.liveActivities'),
    'app.ui.homeScreenWidgets': (settings) => resolveUiFeatureToggleEnabled(settings, 'app.ui.homeScreenWidgets'),
    bugReports: () => true,
    'scm.writeOperations': (settings) => resolveUiFeatureToggleEnabled(settings, 'scm.writeOperations'),
    'files.reviewComments': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.reviewComments'),
    'files.diffSyntaxHighlighting': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.diffSyntaxHighlighting'),
    'files.editor': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.editor'),
    'files.markdownRichEditor': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.markdownRichEditor'),
    'files.syntaxHighlighting.advanced': (settings) => resolveUiFeatureToggleEnabled(settings, 'files.syntaxHighlighting.advanced'),
    'memory.search': (settings) => resolveUiFeatureToggleEnabled(settings, 'memory.search'),
    'terminal.embeddedPty': (settings) => resolveUiFeatureToggleEnabled(settings, 'terminal.embeddedPty'),
    'terminal.renderer.native': () => true,
    'terminal.renderer.iosGhostty': () => true,
    'terminal.renderer.androidTermux': () => true,
    'sessions.folders': (settings) => resolveUiFeatureToggleEnabled(settings, 'sessions.folders'),
    'sessions.direct': (settings) => resolveUiFeatureToggleEnabled(settings, 'sessions.direct'),
    'zen.navigation': (settings) => resolveUiFeatureToggleEnabled(settings, 'zen.navigation'),
    'usage.reporting': (settings) => resolveUiFeatureToggleEnabled(settings, 'usage.reporting'),
    // Browser automation defers to the server decision and action approval. Dormant
    // injectedPage/eval ids add no local environment opt-in; all use the unlisted-id fallback.
    // The plugin UI tiers (hostedWeb / reactNativeBundles)
    // are SERVER-represented + default-ALLOW kill-switches (§4.1/§13.5.3 — the server/build owns the
    // kill-switch and can disable a tier independently). The UI local policy must NOT force them
    // closed: a server-represented decision combines `localPolicyEnabled && serverEnabled`, so a
    // hardcoded `() => false` here would override the now-ON server bit and keep the tier dark. They
    // deliberately have NO entry — the unlisted-id fallback returns true so the server bit governs.
    // Per-plugin install/enable/trust/runtime derivation (5.1/5.2) still governs actual render.
};

export function resolveLocalFeaturePolicyEnabled(featureId: FeatureId, settings: FeatureLocalPolicySettings): boolean {
    const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
    if (!resolver) return true;
    return resolver(settings);
}
