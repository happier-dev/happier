import { parseBooleanEnv, type FeatureId } from '@happier-dev/protocol';
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
    'connectedServices.quotas': (settings) => resolveUiFeatureToggleEnabled(settings, 'connectedServices.quotas'),
    channelBridges: (settings) => resolveUiFeatureToggleEnabled(settings, 'channelBridges'),
    'updates.ota': () => parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_UPDATES_OTA__ENABLED, true),
    'attachments.uploads': (settings) => resolveUiFeatureToggleEnabled(settings, 'attachments.uploads'),
    'social.friends': (settings) => resolveUiFeatureToggleEnabled(settings, 'social.friends'),
    'auth.recovery.providerReset': () => true,
    'auth.ui.recoveryKeyReminder': () => true,
    'app.analytics': () => true,
    'app.ui.storeReviewPrompts': () => true,
    'app.ui.sessionGettingStartedGuidance': () => true,
    'app.ui.changelog': () => true,
    'app.ui.onboardingTour': () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED, false),
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
    // `browser.automation` is SERVER-represented + default-ALLOW (§13.4 — the server owns the gate
    // and can disable it independently). The UI local policy must NOT force it closed: a
    // server-represented decision combines `localPolicyEnabled && serverEnabled`, so a hardcoded
    // `() => false` here would override the server bit and keep the capability dark. It deliberately
    // has NO entry — the unlisted-id fallback returns true so the server bit governs (the dangerous
    // agent-initiated exercise is still approval-gated by the active agent-approval floor). The finer
    // injectedPage/eval tiers stay client-represented + fail-closed (operator opt-in on top of the
    // gate) — a REAL env opt-in (mirroring the CLI `featureLocalPolicy`), defaulting false, never a
    // hardcoded constant that no operator could ever flip on.
    'browser.automation.injectedPage': () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_BROWSER_AUTOMATION_INJECTED_PAGE__ENABLED, false),
    'browser.automation.eval': () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_BROWSER_AUTOMATION_EVAL__ENABLED, false),
    // The plugin UI tiers (hostedWeb / structuredMessages / reactNativeBundles)
    // are SERVER-represented + default-ALLOW kill-switches (§4.1/§13.5.3 — the server/build owns the
    // kill-switch and can disable a tier independently). The UI local policy must NOT force them
    // closed: a server-represented decision combines `localPolicyEnabled && serverEnabled`, so a
    // hardcoded `() => false` here would override the now-ON server bit and keep the tier dark. They
    // deliberately have NO entry — the unlisted-id fallback returns true so the server bit governs.
    // Per-plugin install/enable/trust/runtime derivation (5.1/5.2) still governs actual render. The
    // finer dev-only hot-reload tier stays client-represented + fail-closed via a REAL env opt-in
    // (mirroring the CLI `featureLocalPolicy`), defaulting false — never a dead constant.
    'plugins.ui.reactNativeBundles.devHotReload': () =>
        parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_PLUGINS_UI_REACT_NATIVE_BUNDLES_DEV_HOT_RELOAD__ENABLED, false),
};

export function resolveLocalFeaturePolicyEnabled(featureId: FeatureId, settings: FeatureLocalPolicySettings): boolean {
    const resolver = LOCAL_POLICY_BY_FEATURE[featureId];
    if (!resolver) return true;
    return resolver(settings);
}
