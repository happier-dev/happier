export const QUOTA_GAUGE_WINDOW_MODES = ['most_constrained', 'daily', 'weekly', 'primary', 'secondary', 'session'] as const;

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

/** Unset preferences show every available limit; explicit window choices remain authoritative. */
export function isAutomaticQuotaGaugeWindowSelection(
    modes: readonly ConnectedServiceQuotaGaugeWindowMode[] | null | undefined,
    legacyMode: ConnectedServiceQuotaGaugeWindowMode = 'most_constrained',
): boolean {
    return !modes?.length && legacyMode === 'most_constrained';
}
