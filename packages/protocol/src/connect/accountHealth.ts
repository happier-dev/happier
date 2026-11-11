import type { ConnectedServiceCredentialHealthStatusV1 } from './connectedServiceSchemas.js';

export type AccountHealth = 'healthy' | 'attention' | 'error';
export type ConnectedAccountQuotaTone = 'neutral' | 'success' | 'warning' | 'danger';
export type DeriveAccountHealthInput = Readonly<{
    status?: ConnectedServiceCredentialHealthStatusV1 | null;
    capacityPct: number | null;
    /** Provider credits still serve the account once its included limits are spent. */
    creditsAvailable?: boolean;
    isStale?: boolean;
}>;
const SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = { healthy: 0, attention: 1, error: 2 };
function worst(a: AccountHealth, b: AccountHealth): AccountHealth {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
export function worstAccountHealth(values: readonly AccountHealth[]): AccountHealth {
    return values.reduce<AccountHealth>((acc, value) => worst(acc, value), 'healthy');
}
/** Worst first; stable ties remain the caller's domain order. */
export function compareAccountHealthSeverity(a: AccountHealth, b: AccountHealth): number {
    return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}
// Existing remaining-capacity boundaries, shared by health and every meter.
export const QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT = 10;
export const QUOTA_REMAINING_WARNING_THRESHOLD_PCT = 25;
export function resolveQuotaTone(remainingPct: number | null): ConnectedAccountQuotaTone {
    if (remainingPct === null || !Number.isFinite(remainingPct)) return 'neutral';
    if (remainingPct <= QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT) return 'danger';
    if (remainingPct <= QUOTA_REMAINING_WARNING_THRESHOLD_PCT) return 'warning';
    return 'success';
}
export function resolveQuotaMeterTone(meter: Readonly<{
    remainingPct: number | null;
    status: 'ok' | 'unavailable' | 'estimated' | (string & {});
}>): ConnectedAccountQuotaTone {
    if (meter.status === 'unavailable' || meter.status === 'estimated') return 'neutral';
    return resolveQuotaTone(meter.remainingPct);
}
/** Credential, capacity and freshness health use one ordering in UI and Actions. */
export function deriveAccountHealth(input: DeriveAccountHealthInput): AccountHealth {
    let health: AccountHealth = input.status === 'needs_reauth' ? 'error'
        : input.status === 'refresh_failed_retryable' ? 'attention' : 'healthy';
    const tone = resolveQuotaTone(input.capacityPct);
    // Spent included limits with credit headroom still work (at a cost): attention, never error.
    const capacityHealth: AccountHealth = tone === 'danger' ? (input.creditsAvailable === true ? 'attention' : 'error')
        : tone === 'warning' ? 'attention' : 'healthy';
    health = worst(health, capacityHealth);
    if (input.isStale) health = worst(health, 'attention');
    return health;
}
