import * as React from 'react';

import type { SessionBackgroundTaskRecordV1 } from '@happier-dev/protocol';

import {
    readBackgroundTaskEntryTaskId,
    readBackgroundTaskLaunches,
    type BackgroundTaskLaunch,
} from '@/sync/domains/session/agentActivity';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { listSessionBackgroundTaskRecords } from '@/sync/domains/sessionActivity/sessionBackgroundTaskRecords';

/**
 * The durable background-task records for one session, refreshed on the session's own live pointer.
 *
 * **Why a fetch and not a subscription.** Background tasks have no headline: the CLI's ledger owns
 * liveness in memory and only the outcome is durable (PLAN §4.9), so the records themselves are the
 * roster. What the session DOES carry live is the runtime-activity projection — `state`, `count`
 * and a monotonic `revision` — which advances exactly when a task starts or ends. That revision is
 * the invalidation pointer, so this costs one request per transition rather than a poll, and a
 * session with no background work never fetches at all.
 *
 * **Last-known-good is preserved.** A refresh keeps the previous records on screen until the newer
 * page resolves, so a roster never flashes empty while a task transitions.
 */

export type SessionBackgroundTaskActivity = Readonly<{
    records: readonly SessionBackgroundTaskRecordV1[];
    recordByTaskId: ReadonlyMap<string, SessionBackgroundTaskRecordV1>;
}>;

const NO_RECORDS: readonly SessionBackgroundTaskRecordV1[] = Object.freeze([]);
const NO_RECORDS_BY_TASK_ID: ReadonlyMap<string, SessionBackgroundTaskRecordV1> = new Map();

export const EMPTY_SESSION_BACKGROUND_TASK_ACTIVITY: SessionBackgroundTaskActivity = Object.freeze({
    records: NO_RECORDS,
    recordByTaskId: NO_RECORDS_BY_TASK_ID,
});

export function useSessionBackgroundTaskActivity(params: Readonly<{
    sessionId: string;
    /**
     * The session's runtime-activity projection revision. Advancing it is the only thing that makes
     * this refetch, so a surface that does not have it gets one load and no churn.
     */
    activityRevision?: number | null;
    /**
     * Whether any runtime activity has EVER been projected for this session.
     *
     * A session whose projection has never left the zero baseline has no background work and no
     * record to read, so it must not spend a request discovering that.
     */
    hasEverBeenActive?: boolean;
    enabled?: boolean;
}>): SessionBackgroundTaskActivity {
    const { activityRevision, sessionId } = params;
    const enabled = params.enabled !== false
        && sessionId.trim().length > 0
        && params.hasEverBeenActive !== false;

    const [records, setRecords] = React.useState<readonly SessionBackgroundTaskRecordV1[]>(NO_RECORDS);

    React.useEffect(() => {
        if (!enabled) {
            setRecords(NO_RECORDS);
            return undefined;
        }
        let cancelled = false;
        void listSessionBackgroundTaskRecords({ sessionId })
            .then((next) => {
                if (cancelled) return;
                // Referential stability: an unchanged page must hand back the previous array so the
                // merge below it, and every memoized row under that, sees no change at all.
                setRecords((previous) => (areBackgroundTaskRecordsEquivalent(previous, next)
                    ? previous
                    : next));
            })
            .catch(() => {
                // The list helper already fails soft to an empty page; this only catches a rejected
                // decrypt. Keep the last known records rather than claiming the tasks vanished.
            });
        return () => {
            cancelled = true;
        };
    }, [activityRevision, enabled, sessionId]);

    return React.useMemo(() => {
        if (records.length === 0) return EMPTY_SESSION_BACKGROUND_TASK_ACTIVITY;
        const recordByTaskId = new Map<string, SessionBackgroundTaskRecordV1>();
        for (const record of records) recordByTaskId.set(record.taskId, record);
        return { records, recordByTaskId };
    }, [records]);
}

/** Everything a background-task detail may state: the attested record, plus where its output is. */
export type SessionBackgroundTaskRow = Readonly<{
    record: SessionBackgroundTaskRecordV1;
    /** The transcript card that launched it, when this client holds the message. */
    launch: BackgroundTaskLaunch | null;
}>;

const EMPTY_BACKGROUND_TASK_LAUNCHES: ReadonlyMap<string, BackgroundTaskLaunch> = new Map();

/**
 * Resolve a roster entry id to the background task behind it, joined to its launching `Bash` card.
 *
 * One stable identity for the life of the host, read through a ref: a resolver that changed with
 * the records would re-render every memoized roster row whenever any one task moved.
 */
export function useSessionBackgroundTaskRowResolver(params: Readonly<{
    activity: SessionBackgroundTaskActivity;
    messages: readonly Message[];
}>): (entryId: string) => SessionBackgroundTaskRow | null {
    const { activity, messages } = params;
    // Only scanned when there is a background task to link; a session without one pays nothing.
    const launchByTaskId = React.useMemo(
        () => (activity.records.length > 0
            ? readBackgroundTaskLaunches(messages)
            : EMPTY_BACKGROUND_TASK_LAUNCHES),
        [activity.records.length, messages],
    );

    const lookupRef = React.useRef({ recordByTaskId: activity.recordByTaskId, launchByTaskId });
    lookupRef.current = { recordByTaskId: activity.recordByTaskId, launchByTaskId };

    return React.useCallback((entryId: string): SessionBackgroundTaskRow | null => {
        const taskId = readBackgroundTaskEntryTaskId(entryId);
        if (taskId === null) return null;
        const lookup = lookupRef.current;
        const record = lookup.recordByTaskId.get(taskId);
        if (!record) return null;
        return { record, launch: lookup.launchByTaskId.get(taskId) ?? null };
    }, []);
}

/**
 * Whether two fetched pages describe the same tasks in the same state.
 *
 * Compares the fields a surface can actually see. A deep structural compare would also be correct,
 * but it would treat a re-serialised identical record as a change, and every roster row is memoized
 * on identity.
 */
function areBackgroundTaskRecordsEquivalent(
    left: readonly SessionBackgroundTaskRecordV1[],
    right: readonly SessionBackgroundTaskRecordV1[],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index]!;
        const b = right[index]!;
        if (
            a.taskId !== b.taskId
            || a.status !== b.status
            || a.kind !== b.kind
            || a.label !== b.label
            || a.summary !== b.summary
            || a.startedAt !== b.startedAt
            || a.endedAt !== b.endedAt
            || a.updatedAt !== b.updatedAt
        ) return false;
    }
    return true;
}
