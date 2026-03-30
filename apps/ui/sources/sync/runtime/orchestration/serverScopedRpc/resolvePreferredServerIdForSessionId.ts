import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { resolveServerIdForSessionIdFromLocalCache } from './resolveServerIdForSessionIdFromLocalCache';

function normalizeServerId(value: unknown): string | undefined {
    const serverId = String(value ?? '').trim();
    return serverId || undefined;
}

export function resolvePreferredServerIdForSessionId(sessionId: string): string | undefined {
    return (
        normalizeServerId(resolveServerIdForSessionIdFromLocalCache(sessionId))
        ?? normalizeServerId(getActiveServerSnapshot().serverId)
    );
}
