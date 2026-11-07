import type { HomeAccountChangeEvent } from './homeAccountChange';
import { accountChangeKindsAffectSessionSnapshots } from './changesPlanner';
import { isMachineProjectionChangeKindV1 } from '@happier-dev/protocol/changes';

const CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES = new Set([
    'new-session',
    'pending-changed',
    'update-session',
]);

const CONCURRENT_MACHINE_CACHE_REFRESH_UPDATE_TYPES = new Set([
    'new-machine',
    'update-machine',
]);

export type ConcurrentSessionCacheUpdateImpact = 'machines' | 'snapshot' | 'rows' | 'message' | 'delete' | 'archive' | null;

function readConcurrentUpdateType(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const body = (raw as { body?: unknown }).body;
    if (!body || typeof body !== 'object') {
        return null;
    }

    const updateType = (body as { t?: unknown }).t;
    return typeof updateType === 'string' ? updateType : null;
}

export function shouldRefreshConcurrentSessionCacheForUpdate(raw: unknown): boolean {
    return classifyConcurrentSessionCacheUpdate(raw) !== null;
}

export function classifyConcurrentSessionCacheUpdate(raw: unknown, accountEvent?: HomeAccountChangeEvent): ConcurrentSessionCacheUpdateImpact {
    const updateType = readConcurrentUpdateType(raw);
    if (updateType === 'account-change') {
        if (accountEvent?.sessionRowRefreshIds?.length) return 'rows';
        const sessionSnapshotsAffect = accountEvent?.sessionListQueryAffects
            ?? accountChangeKindsAffectSessionSnapshots(accountEvent?.changeKinds);
        if (sessionSnapshotsAffect) return 'snapshot';
        return accountEvent?.changeKinds?.some(isMachineProjectionChangeKindV1) ? 'machines' : null;
    }
    if (updateType !== null && CONCURRENT_MACHINE_CACHE_REFRESH_UPDATE_TYPES.has(updateType)) return 'machines';
    if (updateType === 'new-message' || updateType === 'message-updated') return 'message';
    if (updateType === 'delete-session' || updateType === 'session-share-revoked') return 'delete';
    if (updateType === 'update-session'
        && raw && typeof raw === 'object' && 'body' in raw
        && raw.body && typeof raw.body === 'object' && 'archivedAt' in raw.body) return 'archive';
    return updateType !== null && CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES.has(updateType) ? 'snapshot' : null;
}

export function isAccountChangeUpdate(raw: unknown): boolean {
    const type = readConcurrentUpdateType(raw);
    return type === 'update-account' || type === 'account-change' || type === 'account-settings-changed';
}
