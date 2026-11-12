import type { ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol';

import type { MeterTone } from '@/components/ui/lists/MeterBar';

import { resolveQuotaTone } from './resolveQuotaTone';

export type AccountHealth = 'healthy' | 'attention' | 'error';

export type DeriveAccountHealthInput = Readonly<{
    status?: ConnectedServiceCredentialHealthStatusV1 | null;
    capacityPct: number | null;
    /** Provider credits still serve the account once its included limits are spent. */
    creditsAvailable?: boolean;
    isStale?: boolean;
}>;

const SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = {
    healthy: 0,
    attention: 1,
    error: 2,
};

function worst(a: AccountHealth, b: AccountHealth): AccountHealth {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function statusToHealth(
    status: ConnectedServiceCredentialHealthStatusV1 | null | undefined,
): AccountHealth {
    if (status === 'needs_reauth') return 'error';
    if (status === 'refresh_failed_retryable') return 'attention';
    return 'healthy';
}

function toneToHealth(tone: MeterTone): AccountHealth {
    if (tone === 'danger') return 'error';
    if (tone === 'warning') return 'attention';
    // success + neutral (no data) are not, by themselves, problems.
    return 'healthy';
}

/**
 * Derive an account's health from the worst-of its credential status, quota
 * capacity, and staleness. The capacity dimension consumes `resolveQuotaTone`
 * so the health dot can never disagree with the meter bar at the 10% boundary.
 */
export function deriveAccountHealth(input: DeriveAccountHealthInput): AccountHealth {
    let health = statusToHealth(input.status);
    const capacityHealth = toneToHealth(resolveQuotaTone(input.capacityPct));
    // Spent included limits with credit headroom still work (at a cost): attention, never error.
    health = worst(health, input.creditsAvailable === true && capacityHealth === 'error' ? 'attention' : capacityHealth);
    if (input.isStale) health = worst(health, 'attention');
    return health;
}
