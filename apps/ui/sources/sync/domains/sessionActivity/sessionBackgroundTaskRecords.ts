import {
    SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
    SessionBackgroundTaskRecordV1Schema,
    type SessionBackgroundTaskRecordV1,
    type SessionSystemRecord,
} from '@happier-dev/protocol';

import { listSessionSystemRecords } from '@/sync/ops/sessionSystemRecords';

import { openSessionActivityRecordPayload } from './sessionActivityRecordContent';

/**
 * UI read path for the durable `activity/background_task.v1` records the CLI publishes (R-9).
 *
 * Unlike its `workflow_run.v1` sibling, this family is **listed, not looked up**: there is no
 * headline naming which background tasks exist, so the records themselves are the roster. That is
 * the honest shape — the CLI's in-memory ledger owns liveness and is rebuildable, and only the
 * outcome is durable (PLAN §4.9) — and it is why the count and the roster come from different
 * places: the count is the live projection on the session, the rows are these records.
 *
 * Everything fails soft. A record this build cannot parse, decrypt or reach is skipped rather than
 * rendered as a half-known task: a background command that shows the wrong status is worse than one
 * that has not appeared yet.
 */

/**
 * How many background-task records one session may render.
 *
 * The server orders by `updatedAt` desc, so this keeps the newest. A bound is not a preference: the
 * record family is unbounded over a long session (one per backgrounded command, no TTL exists), and
 * an unbounded list would be paid for on every refresh of a pane that shows a roster, not a log.
 */
export const SESSION_BACKGROUND_TASK_RECORD_LIMIT = 32;

/** Open one record's envelope and validate it, or `null` when it is not a well-formed task record. */
export async function openBackgroundTaskSystemRecord(params: Readonly<{
    sessionId: string;
    record: SessionSystemRecord | null;
}>): Promise<SessionBackgroundTaskRecordV1 | null> {
    const record = params.record;
    if (!record) return null;
    if (record.namespace !== SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE) return null;
    if (record.kind !== 'background_task.v1') return null;
    const payload = await openSessionActivityRecordPayload({
        sessionId: params.sessionId,
        content: record.content,
    });
    if (payload === null || payload === undefined) return null;
    const parsed = SessionBackgroundTaskRecordV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

/**
 * Every background task this session has a durable record for, newest first.
 *
 * Returns an empty list on any transport failure, which is also what an old CLI that never writes
 * these records produces — so the degrade path and the empty path are the same code path rather
 * than two behaviours that could diverge.
 */
export async function listSessionBackgroundTaskRecords(params: Readonly<{
    sessionId: string;
    limit?: number;
    serverId?: string | null;
}>): Promise<readonly SessionBackgroundTaskRecordV1[]> {
    const page = await listSessionSystemRecords({
        sessionId: params.sessionId,
        namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
        kind: 'background_task.v1',
        limit: params.limit ?? SESSION_BACKGROUND_TASK_RECORD_LIMIT,
        ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
    });
    if (page.records.length === 0) return [];

    const opened = await Promise.all(page.records.map(
        (record) => openBackgroundTaskSystemRecord({ sessionId: params.sessionId, record })
            .catch(() => null),
    ));
    return opened.filter((record): record is SessionBackgroundTaskRecordV1 => record !== null);
}
