import { readUsageHomeHttpFailure } from '@happier-dev/protocol/usage/usageHomeHttpFailure';
import { HappyError } from '@/utils/errors/errors';
import { readUsageAuthorityRefusalCode, USAGE_COACH_PREFERENCES_READ_SOURCE, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

type CoverageStatus = Pick<UsageQuerySourceState, 'source' | 'status' | 'errorCode' | 'unreadSessions'>;

export function usagePageReadFamily(source: string): string {
    if (source === USAGE_COACH_PREFERENCES_READ_SOURCE) return 'how_you_work';
    return source.startsWith('quota:') ? 'quota' : source;
}

function hasRetryableUnreadWork(state: CoverageStatus): boolean {
    return (state.unreadSessions?.failed ?? 0) > 0 || (state.unreadSessions?.timed_out ?? 0) > 0;
}

export function isUsageCoverageFailure(source: CoverageStatus): boolean {
    return source.status === 'error' || source.source === 'work' && (source.errorCode === 'work_evidence_failed'
        || source.status === 'stale' && hasRetryableUnreadWork(source))
        || source.status === 'stale' && source.errorCode !== undefined && usagePageReadFamily(source.source) === 'quota'
        || source.source === USAGE_COACH_PREFERENCES_READ_SOURCE && source.status === 'pending' && source.errorCode !== undefined;
}

export function needsNewerServer(gap: Pick<UsageQuerySourceState, 'status' | 'updateRequired'>): boolean {
    return (gap.status === 'error' || gap.status === 'unsupported') && gap.updateRequired?.component === 'server';
}

export function isUsageQuotaOwnershipUnproven(state: UsageQuerySourceState): boolean {
    return usagePageReadFamily(state.source) === 'quota' && state.errorCode === 'ownership_unproven';
}

/** Typed scope denials keep their cause and require a scope or authority change. */
export function usageScopeRefusalCode(state: CoverageStatus) {
    if (!isUsageCoverageFailure(state)) return null;
    return state.errorCode === 'not_found' ? state.errorCode : readUsageAuthorityRefusalCode(state.errorCode);
}

export function canRetryUsageCoverageFailure(state: UsageQuerySourceState): boolean {
    if (needsNewerServer(state)) return false;
    // An explicit reread can reestablish quota ownership using the same credential material.
    if (isUsageQuotaOwnershipUnproven(state)) return true;
    if (state.source === 'work' && (state.status === 'partial' || state.unreadSessions !== undefined)) {
        const settled = state.status === 'partial' || state.status === 'error' || state.status === 'stale';
        return settled && hasRetryableUnreadWork(state);
    }
    return !usageScopeRefusalCode(state) && isUsageCoverageFailure(state);
}

export function createUsageHomeHttpReadError(status: number, body: unknown) {
    const failure = readUsageHomeHttpFailure(status, body);
    if (!failure) return null;
    return Object.assign(new HappyError(failure.error, status === 503, {
        status,
        kind: status === 403 ? 'auth' : 'server',
        code: failure.errorCode,
        details: failure.details,
        failureCause: failure.failureCause,
        requestId: failure.requestId,
    }), failure, { retryable: status === 503 });
}
