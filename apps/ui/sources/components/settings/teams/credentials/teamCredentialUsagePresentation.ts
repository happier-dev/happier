import type { TeamCredentialUsageQueryResultV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

type UsageCoverage = TeamCredentialUsageQueryResultV1['coverage'];

/**
 * The period's cost as its figure shows it. A cost the Home could not price for every model is not a
 * total: like the account Usage page (`usagePageCostCaption`), it reads as unknown with the reason,
 * never as the sum of the priced part, and never as a measured zero. A period with nothing recorded at
 * all is a known zero (`nothingRecorded`): there is no usage left unpriced.
 */
export function teamCredentialUsageCost(
    resolvedUsd: number | null,
    coverage: UsageCoverage | null,
    nothingRecorded = false,
): Readonly<{ amountUsd: number | null; caption?: string }> {
    if (nothingRecorded && resolvedUsd !== null) return { amountUsd: resolvedUsd };
    if (coverage?.costCoverage === 'partial') return { amountUsd: null, caption: t('teams.credentials.usage.costPartialShort') };
    if (coverage?.costCoverage === 'unavailable' || resolvedUsd === null) {
        return { amountUsd: null, caption: t('teams.credentials.usage.costUnavailable') };
    }
    return { amountUsd: resolvedUsd };
}

/**
 * The period's tokens: a partial total is a floor that says so; an unavailable one is unknown unless
 * nothing at all was recorded, which is a known zero.
 */
export function teamCredentialUsageTokens(
    measured: number | null,
    coverage: UsageCoverage | null,
    nothingRecorded = false,
): Readonly<{ tokens: number | null; caption?: string }> {
    if (nothingRecorded && measured !== null) return { tokens: measured };
    if (coverage?.tokenCoverage === 'unavailable' || measured === null) {
        return { tokens: null, caption: t('teams.credentials.usage.tokenUnavailable') };
    }
    if (coverage?.tokenCoverage === 'partial') return { tokens: measured, caption: t('teams.credentials.usage.tokenPartialShort') };
    return { tokens: measured };
}

/**
 * The one caveat line under the totals: what they leave out by where usage was observed. Token and
 * cost gaps are said by their own figures, so they are not repeated here.
 */
export function teamCredentialUsageCaveat(coverage: UsageCoverage | null): string | null {
    if (coverage === null) return null;
    const parts = [
        coverage.directRecordedUseOnly ? t('teams.credentials.usage.directIncomplete') : null,
        coverage.requestCountCoverage === 'brokered_only' ? t('teams.credentials.usage.requestIncomplete') : null,
        coverage.unobservedExternalRequestCount > 0
            ? t('teams.credentials.usage.externalObservationsIncomplete', { count: coverage.unobservedExternalRequestCount })
            : null,
    ].filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(' ');
    return coverage.tokenCoverage === 'complete' && coverage.costCoverage === 'complete'
        ? t('teams.credentials.usage.recordedByHappier')
        : null;
}

type UsageBucketGranularity = 'hour' | 'day' | 'week' | 'month';

function stepBucket(startMs: number, granularity: UsageBucketGranularity, direction: 1 | -1): number {
    if (granularity === 'month') {
        const date = new Date(startMs);
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, date.getUTCDate(),
            date.getUTCHours(), date.getUTCMinutes());
    }
    const size = granularity === 'hour' ? 3_600_000 : granularity === 'day' ? 86_400_000 : 7 * 86_400_000;
    return startMs + direction * size;
}

/**
 * The time axis of a usage chart: one slot per bucket from the range's start (or, for all time, the
 * first recorded bucket) to its end, aligned to the Home's own buckets. A slot the Home sent no bucket
 * for is a period with nothing recorded, drawn as an empty slot instead of being skipped, so the axis
 * reads as time. Every slot carries whether the Home recorded it.
 */
export function contiguousTeamCredentialUsageBuckets(
    recordedStartsMs: readonly number[],
    range: Readonly<{ startMs: number; endMs: number; granularity: UsageBucketGranularity }>,
): readonly Readonly<{ bucketStartMs: number; recorded: boolean }>[] {
    if (recordedStartsMs.length === 0) return [];
    const recorded = new Set(recordedStartsMs);
    const first = Math.min(...recordedStartsMs);
    const last = Math.max(...recordedStartsMs);
    const lower = range.startMs > 0 ? range.startMs : first;
    // Step back while the bucket before `start` still overlaps the range ([previous, start) ends after `lower`).
    let start = first;
    while (start > lower) start = stepBucket(start, range.granularity, -1);
    const slots: { bucketStartMs: number; recorded: boolean }[] = [];
    for (let at = start; at < Math.max(range.endMs, last + 1); at = stepBucket(at, range.granularity, 1)) {
        slots.push({ bucketStartMs: at, recorded: recorded.has(at) });
    }
    return slots;
}
