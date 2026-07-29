import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol';
import {
    deriveSessionRuntimePresentationState,
    readSessionRuntimePresentationFreshnessExpirations,
    type SessionRuntimePresentationInput,
} from '@/sync/domains/session/attention/runtimePresentation';

import { buildSessionListRowScopeKey } from './sessionListKeyNormalization';

export type SessionListRuntimePriorityRow = Readonly<{
    id?: string | null;
    active?: boolean | null;
    archivedAt?: number | null;
    thinking?: boolean | null;
    latestTurnStatus?: string | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    hasUnreadMessages?: boolean | null;
    hasPendingPermissionRequests?: boolean | null;
    hasPendingUserActionRequests?: boolean | null;
    lastRuntimeIssue?: unknown | null;
    activeAt?: number | null;
    presence?: unknown;
    thinkingAt?: number | null;
    latestTurnStatusObservedAt?: number | null;
    runtimeActivityState?: 'active' | 'idle' | 'unknown' | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
    pendingRequestObservedAt?: number | null;
}>;

export type SessionListRuntimePriorityRowStateByServerId = Readonly<
    Record<string, Readonly<Record<string, SessionListRuntimePriorityRow | undefined>> | undefined>
>;

function buildSessionListRuntimePriorityPresentationInput(
    row: SessionListRuntimePriorityRow,
    nowMs: number,
): SessionRuntimePresentationInput {
    return {
        active: row.active,
        activeAt: row.activeAt,
        archivedAt: row.archivedAt,
        presence: row.presence ?? (row.active === true ? 'online' : undefined),
        thinking: row.thinking,
        thinkingAt: row.thinkingAt,
        latestTurnStatus: row.latestTurnStatus === 'in_progress'
            || row.latestTurnStatus === 'completed'
            || row.latestTurnStatus === 'cancelled'
            || row.latestTurnStatus === 'failed'
            ? row.latestTurnStatus
            : null,
        latestTurnStatusObservedAt: row.latestTurnStatusObservedAt,
        runtimeActivityState: row.runtimeActivityState,
        runtimeActivityActiveCount: row.runtimeActivityActiveCount,
        runtimeActivityObservedAt: row.runtimeActivityObservedAt,
        runtimeActivityRevision: row.runtimeActivityRevision,
        hasPendingPermissionRequests: row.hasPendingPermissionRequests,
        hasPendingUserActionRequests: row.hasPendingUserActionRequests,
        pendingRequestObservedAt: row.pendingRequestObservedAt,
        lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().catch(null).parse(row.lastRuntimeIssue ?? null),
        nowMs,
    };
}

export function resolveSessionListRuntimePriorityRowNextFreshnessAtMs(
    row: SessionListRuntimePriorityRow | undefined,
    nowMs: number = Date.now(),
): number | null {
    if (!row) return null;
    const expirations = readSessionRuntimePresentationFreshnessExpirations(
        buildSessionListRuntimePriorityPresentationInput(row, nowMs),
        nowMs,
    );
    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}

export function isSessionListRuntimePriorityRow(
    row: SessionListRuntimePriorityRow | undefined,
    nowMs: number = Date.now(),
): boolean {
    if (!row) return false;
    const runtimePresentation = deriveSessionRuntimePresentationState(
        buildSessionListRuntimePriorityPresentationInput(row, nowMs),
    );
    return row.active === true
        || runtimePresentation.working
        || (row.presence === 'online' && runtimePresentation.backgroundActive)
        || runtimePresentation.freshPermissionRequired
        || runtimePresentation.freshActionRequired
        || runtimePresentation.attention === 'failed'
        || row?.hasPendingPermissionRequests === true
        || row?.hasPendingUserActionRequests === true
        || row?.lastRuntimeIssue != null;
}

export function buildSessionListRuntimePriorityRowKeys(
    items: ReadonlyArray<SessionListIndexItem> | null | undefined,
    rowStateByServerId: SessionListRuntimePriorityRowStateByServerId | null | undefined,
    nowMs: number = Date.now(),
): ReadonlySet<string> {
    if (!items || items.length === 0 || !rowStateByServerId) return new Set();
    const keys = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
        if (!serverId || !sessionId) continue;
        if (!isSessionListRuntimePriorityRow(rowStateByServerId[serverId]?.[sessionId], nowMs)) continue;
        const key = buildSessionListRowScopeKey(serverId, sessionId);
        if (key) keys.add(key);
    }
    return keys;
}
