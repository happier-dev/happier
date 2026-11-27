import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { USAGE_COACH_PREFERENCES_READ_SOURCE, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

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
    switch (state.errorCode) {
        case 'denied':
        case 'permission_denied':
        case 'unauthorized':
        case 'forbidden':
        case RPC_ERROR_CODES.FORBIDDEN:
        case 'not_found':
            return state.errorCode;
        default:
            return null;
    }
}

export function canRetryUsageCoverageFailure(state: UsageQuerySourceState): boolean {
    if (needsNewerServer(state) || isUsageQuotaOwnershipUnproven(state)) return false;
    if (state.source === 'work' && (state.status === 'partial' || state.unreadSessions !== undefined)) {
        const settled = state.status === 'partial' || state.status === 'error' || state.status === 'stale';
        return settled && hasRetryableUnreadWork(state);
    }
    return !usageScopeRefusalCode(state) && isUsageCoverageFailure(state);
}
