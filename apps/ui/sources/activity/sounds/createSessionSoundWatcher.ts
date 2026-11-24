import { deriveSessionAttentionState } from '@/sync/domains/session/attention/deriveSessionAttentionState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { StorageState } from '@/sync/store/types';

type SessionStatusRecord = Pick<Session | SessionListRenderableSession, 'latestTurnStatus' | 'lastRuntimeIssue' | 'thinking'>;

type ObservedSession = Readonly<{
    record: SessionStatusRecord | undefined;
    /** Occurrence time of the newest failure reported (or present at first sighting). */
    failureAt: number | null;
    /** Occurrence time of the usage-limit failure blocking the session, while it is blocked. */
    usageLimitAt: number | null;
    running: boolean;
    /** The usage-limit failure whose resume was already reported. */
    resumedFromUsageLimitAt: number | null;
}>;

export type SessionSoundWatcherState = Pick<StorageState, 'sessions' | 'sessionListRenderables'>;
export type SessionSoundEvent = 'failed' | 'resumedAfterUsageLimit';

/** The record the session status presentation reads: the full session when loaded, else its list row. */
function readStatusRecord(state: SessionSoundWatcherState, sessionId: string): SessionStatusRecord | undefined {
    return state.sessions[sessionId] ?? state.sessionListRenderables[sessionId];
}

/** When the record's latest turn failed (the red status), the failure's occurrence time; otherwise null. */
function readFailureAt(record: SessionStatusRecord | undefined): number | null {
    if (!record) return null;
    const state = deriveSessionAttentionState({
        latestTurnStatus: record.latestTurnStatus,
        lastRuntimeIssue: record.lastRuntimeIssue,
    });
    if (state !== 'failed') return null;
    const occurredAt = record.lastRuntimeIssue?.occurredAt;
    return typeof occurredAt === 'number' && Number.isFinite(occurredAt) ? occurredAt : null;
}

function readUsageLimitAt(record: SessionStatusRecord | undefined): number | null {
    return record?.lastRuntimeIssue?.source === 'usage_limit' ? readFailureAt(record) : null;
}

function isRunning(record: SessionStatusRecord | undefined): boolean {
    return record?.thinking === true || record?.latestTurnStatus === 'in_progress';
}

/** Whether the session's latest turn ended in failure, as its status presentation shows it. */
export function isLatestTurnFailed(state: SessionSoundWatcherState, sessionId: string): boolean {
    return readFailureAt(readStatusRecord(state, sessionId)) !== null;
}

/**
 * Reports session changes that play a sound, each once:
 * - `failed`: a new failure, identified by its runtime issue's occurrence time;
 * - `resumedAfterUsageLimit`: a session blocked by a usage-limit failure starts working again.
 *
 * Unchanged records cost one identity comparison. The first sighting of a session only records its
 * state, so failures that existed when the app started, or when a session was first loaded, are not
 * new; a usage limit seen that way still reports its resume, because limits often outlast an app run.
 */
export function createSessionSoundWatcher(onEvent: (sessionId: string, event: SessionSoundEvent) => void) {
    const observed = new Map<string, ObservedSession>();
    let lastSessions: SessionSoundWatcherState['sessions'] | null = null;
    let lastRenderables: SessionSoundWatcherState['sessionListRenderables'] | null = null;

    const visit = (state: SessionSoundWatcherState, sessionId: string, notify: boolean) => {
        const record = readStatusRecord(state, sessionId);
        const previous = observed.get(sessionId);
        if (previous && previous.record === record) return;

        const failureAt = readFailureAt(record);
        const usageLimitAt = readUsageLimitAt(record);
        const running = isRunning(record);
        const isNewFailure = previous !== undefined
            && failureAt !== null
            && (previous.failureAt === null || failureAt > previous.failureAt);
        // The failed status can linger until the new turn's status arrives, so the block being
        // resumed is the one seen before this record, or still on it.
        const blockedAt = previous?.usageLimitAt ?? null;
        const isUsageLimitResume = previous !== undefined
            && blockedAt !== null
            && !previous.running
            && running
            && previous.resumedFromUsageLimitAt !== blockedAt;

        observed.set(sessionId, {
            record,
            failureAt: failureAt === null ? previous?.failureAt ?? null : Math.max(failureAt, previous?.failureAt ?? failureAt),
            usageLimitAt,
            running,
            resumedFromUsageLimitAt: isUsageLimitResume ? blockedAt : previous?.resumedFromUsageLimitAt ?? null,
        });
        if (!notify) return;
        if (isNewFailure) onEvent(sessionId, 'failed');
        if (isUsageLimitResume) onEvent(sessionId, 'resumedAfterUsageLimit');
    };

    return {
        observe(state: SessionSoundWatcherState, notify: boolean): void {
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
