import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
    projectUiSessionRuntimeAwareness,
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
        presence: row.presence,
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

type SessionListRuntimePriorityProjection = Readonly<{
    evaluatedAtMs: number;
    nextFreshnessAtMs: number | null;
    isPriority: boolean;
}>;

// Priority selection and its freshness timer read the same immutable store rows.
// Weak keys let retired rows go; clock rewinds and the runtime owner's deadline
// invalidate a projection even when the store preserves its row reference.
const runtimePriorityByRow = new WeakMap<SessionListRuntimePriorityRow, SessionListRuntimePriorityProjection>();

function readSessionListRuntimePriorityProjection(
    row: SessionListRuntimePriorityRow,
    nowMs: number,
): SessionListRuntimePriorityProjection {
    const previous = runtimePriorityByRow.get(row);
    if (
        previous
        && nowMs >= previous.evaluatedAtMs
        && (previous.nextFreshnessAtMs === null || nowMs < previous.nextFreshnessAtMs)
    ) {
        return previous;
    }

    const input = buildSessionListRuntimePriorityPresentationInput(row, nowMs);
    const runtimePresentation = projectUiSessionRuntimeAwareness(input);
    const expirations = readSessionRuntimePresentationFreshnessExpirations(input, nowMs);
    const projection = {
        evaluatedAtMs: nowMs,
        nextFreshnessAtMs: expirations.length === 0 ? null : Math.min(...expirations),
        isPriority: row.active === true
            || runtimePresentation.working
            || runtimePresentation.runtime === 'background_active'
            || runtimePresentation.freshPermissionRequired
            || runtimePresentation.freshActionRequired
            || runtimePresentation.operational.primary === 'failed'
            || row.hasPendingPermissionRequests === true
            || row.hasPendingUserActionRequests === true
            || row.lastRuntimeIssue != null,
    };
    runtimePriorityByRow.set(row, projection);
    return projection;
}

export function resolveSessionListRuntimePriorityRowNextFreshnessAtMs(
    row: SessionListRuntimePriorityRow | undefined,
    nowMs: number = Date.now(),
): number | null {
    return row ? readSessionListRuntimePriorityProjection(row, nowMs).nextFreshnessAtMs : null;
}

export function isSessionListRuntimePriorityRow(
    row: SessionListRuntimePriorityRow | undefined,
    nowMs: number = Date.now(),
): boolean {
    return row ? readSessionListRuntimePriorityProjection(row, nowMs).isPriority : false;
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
