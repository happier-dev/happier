import { deriveSessionAttentionState } from '@/sync/domains/session/attention/deriveSessionAttentionState';
import type { DeriveSessionAttentionStateInput } from '@/sync/domains/session/attention/types';
import type { StorageState } from '@/sync/store/types';

type FailureRecord = Pick<DeriveSessionAttentionStateInput, 'latestTurnStatus' | 'lastRuntimeIssue'> | undefined;

type ObservedSession = Readonly<{
    session: unknown;
    renderable: unknown;
    failureAt: number | null;
}>;

export type SessionFailureWatcherState = Pick<StorageState, 'sessions' | 'sessionListRenderables'>;

/** When the record's latest turn failed (the red status), the failure's occurrence time; otherwise null. */
function readFailureAt(record: FailureRecord): number | null {
    if (!record) return null;
    const state = deriveSessionAttentionState({
        latestTurnStatus: record.latestTurnStatus,
        lastRuntimeIssue: record.lastRuntimeIssue,
    });
    if (state !== 'failed') return null;
    const occurredAt = record.lastRuntimeIssue?.occurredAt;
    return typeof occurredAt === 'number' && Number.isFinite(occurredAt) ? occurredAt : null;
}

function newest(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}

/**
 * Reports each new session failure once, identified by its runtime issue's occurrence time.
 *
 * A failure reaches either the full session record or, for sessions without a full-content
 * consumer, only the list renderable, so both are read. Unchanged records cost one identity
 * comparison. The first sighting of a session only records its state: failures that already
 * existed when the app started, or when a session was first loaded, are not new.
 */
export function createSessionFailureWatcher(onFailure: (sessionId: string) => void) {
    const observed = new Map<string, ObservedSession>();
    let lastSessions: SessionFailureWatcherState['sessions'] | null = null;
    let lastRenderables: SessionFailureWatcherState['sessionListRenderables'] | null = null;

    const visit = (state: SessionFailureWatcherState, sessionId: string, notify: boolean) => {
        const session = state.sessions[sessionId];
        const renderable = state.sessionListRenderables[sessionId];
        const previous = observed.get(sessionId);
        if (previous && previous.session === session && previous.renderable === renderable) return;

        const failureAt = newest(readFailureAt(session), readFailureAt(renderable));
        observed.set(sessionId, {
            session,
            renderable,
            failureAt: newest(previous?.failureAt ?? null, failureAt),
        });
        const isNewFailure = failureAt !== null
            && previous !== undefined
            && (previous.failureAt === null || failureAt > previous.failureAt);
        if (notify && isNewFailure) onFailure(sessionId);
    };

    return {
        observe(state: SessionFailureWatcherState, notify: boolean): void {
            if (state.sessions === lastSessions && state.sessionListRenderables === lastRenderables) return;
            lastSessions = state.sessions;
            lastRenderables = state.sessionListRenderables;

            const present = new Set<string>();
            for (const sessionId in state.sessions) {
                present.add(sessionId);
                visit(state, sessionId, notify);
            }
            for (const sessionId in state.sessionListRenderables) {
                if (present.has(sessionId)) continue;
                present.add(sessionId);
                visit(state, sessionId, notify);
            }
            if (observed.size > present.size) {
                for (const sessionId of observed.keys()) {
                    if (!present.has(sessionId)) observed.delete(sessionId);
                }
            }
        },
    };
}
