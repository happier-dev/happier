import { parseBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';
import { getCanonicalFeatureId, isFeatureId, type FeatureId } from '@happier-dev/protocol/features/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveUiFeatureToggleEnabled } from './featureRegistry';

export type FeatureLocalPolicySettings = Readonly<Pick<Settings, 'experiments' | 'featureToggles'>>;

type FeatureLocalPolicyResolver = (settings: FeatureLocalPolicySettings) => boolean;

const LOCAL_POLICY_BY_FEATURE: Readonly<Partial<Record<FeatureId, FeatureLocalPolicyResolver>>> = {
    // Usage is shown wherever the Home serves it; its server bit is the only decision (the former
    // experimental, off-by-default switch existed only while the surfaces were unvalidated).
    'connectedServices.quotas': () => true,
    'updates.ota': () => parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_FEATURE_UPDATES_OTA__ENABLED, true),
    'auth.recovery.providerReset': () => true,
    'auth.ui.recoveryKeyReminder': () => true,
    'app.analytics': () => true,
    'app.ui.storeReviewPrompts': () => true,
    'app.ui.sessionGettingStartedGuidance': () => true,
    'app.ui.changelog': () => true,
    bugReports: () => true,
    'terminal.renderer.native': () => true,
    'terminal.renderer.iosGhostty': () => true,
    'terminal.renderer.androidTermux': () => true,
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
    const canonical = getCanonicalFeatureId(featureId);
    const resolver = LOCAL_POLICY_BY_FEATURE[canonical];
    if (resolver) return resolver(settings);
    // The registry owns Account controls; adding one must not require a second policy row.
    return isFeatureId(canonical) ? resolveUiFeatureToggleEnabled(settings, canonical) : true;
}
