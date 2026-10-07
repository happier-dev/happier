import { SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES } from '@happier-dev/protocol/account/settings/accountSettings';

export const QUOTA_GAUGE_WINDOW_MODES = SESSION_PROVIDER_USAGE_GAUGE_WINDOW_MODES;
export type ConnectedServiceQuotaGaugeWindowMode = typeof QUOTA_GAUGE_WINDOW_MODES[number];

export function isQuotaGaugeWindowMode(value: string): value is ConnectedServiceQuotaGaugeWindowMode {
    return QUOTA_GAUGE_WINDOW_MODES.some((mode) => mode === value);
}

/** An explicit choice overrides the predecessor single-window preference. */
export function resolveQuotaGaugeWindowModes(
    modes: readonly ConnectedServiceQuotaGaugeWindowMode[] | null | undefined,
    legacyMode: ConnectedServiceQuotaGaugeWindowMode = 'most_constrained',
): ConnectedServiceQuotaGaugeWindowMode[] {
    if (!modes?.length) return [legacyMode];
    if (modes.includes('most_constrained')) return ['most_constrained'];
    return [...new Set(modes)];
}
