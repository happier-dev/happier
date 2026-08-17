import type { ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol';

import type { MeterTone } from '@/components/ui/lists/MeterBar';

import { resolveQuotaTone } from './resolveQuotaTone';

export type AccountHealth = 'healthy' | 'attention' | 'error';

export type DeriveAccountHealthInput = Readonly<{
    status?: ConnectedServiceCredentialHealthStatusV1 | null;
    capacityPct: number | null;
    isStale?: boolean;
}>;

/**
 * The ONE severity ordering for `AccountHealth`. Higher means worse. Every
 * surface that ranks, sorts or folds account health reads it through
 * `worstAccountHealth` / `compareAccountHealthSeverity` below, so no screen can
 * define its own (previously inverted) copy of this table.
 */
const SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = {
    healthy: 0,
    attention: 1,
    error: 2,
};

function worst(a: AccountHealth, b: AccountHealth): AccountHealth {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Fold a set of account healths to the most severe one. An empty set is
 * `healthy`: nothing is known to be wrong.
 */
export function worstAccountHealth(values: ReadonlyArray<AccountHealth>): AccountHealth {
    return values.reduce<AccountHealth>((acc, value) => worst(acc, value), 'healthy');
}

/**
 * `Array.prototype.sort` comparator that puts the accounts needing attention
 * FIRST (error, then attention, then healthy). Returns 0 for equal severities so
 * callers keep their own stable tiebreak (name, id, …).
 */
export function compareAccountHealthSeverity(a: AccountHealth, b: AccountHealth): number {
    return SEVERITY_RANK[b] - SEVERITY_RANK[a];
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
    health = worst(health, toneToHealth(resolveQuotaTone(input.capacityPct)));
    if (input.isStale) health = worst(health, 'attention');
    return health;
}
