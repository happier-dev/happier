import {
    SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
    SessionWorkflowRunSnapshotV1Schema,
    buildWorkflowRunSystemRecordLocalId,
    type SessionSystemRecord,
    type SessionSystemRecordContent,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { fetchSessionSystemRecord } from '@/sync/ops/sessionSystemRecords';

import { openSessionActivityRecordPayload } from './sessionActivityRecordContent';

/**
 * UI open/read helpers for the durable `activity/workflow_run.v1` session system records (UIW1).
 *
 * Detail comes ONLY from these records; compact display comes from the metadata headline. The UI
 * never parses Claude-native events — it opens the provider-agnostic content envelope (plain `v` or
 * encrypted `c` decrypted with the session key) and validates `SessionWorkflowRunSnapshotV1`. All
 * paths fail soft (return `null`) on a missing, wrong-kind, wrong-namespace, malformed, or
 * undecryptable record so callers render a loading/minimal shell instead of inventing detail.
 */

type WorkflowActivityRecordContent = SessionSystemRecordContent;

/**
 * Open one `activity/workflow_run.v1` record's content envelope into a validated snapshot. Encrypted
 * content is decrypted through the session encryption context; plain content is read directly.
 * Returns `null` when the record cannot be opened/validated.
 */
export async function openWorkflowRunSystemRecordContent(params: Readonly<{
    sessionId: string;
    content: WorkflowActivityRecordContent;
}>): Promise<SessionWorkflowRunSnapshotV1 | null> {
    const rawPayload = await openSessionActivityRecordPayload(params);
    if (rawPayload === null || rawPayload === undefined) return null;
    const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(rawPayload);
    return parsed.success ? parsed.data : null;
}

/**
 * Validate a fetched system record is a well-formed `activity/workflow_run.v1` record and open its
 * snapshot. Rejects wrong namespace/kind/localId before opening content.
 */
export async function openWorkflowRunSystemRecord(params: Readonly<{
    sessionId: string;
    record: SessionSystemRecord | null;
    expectedLocalId?: string;
}>): Promise<SessionWorkflowRunSnapshotV1 | null> {
    const record = params.record;
    if (!record) return null;
    if (record.namespace !== SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE) return null;
    if (record.kind !== 'workflow_run.v1') return null;
    if (params.expectedLocalId && record.localId !== params.expectedLocalId) return null;
    return openWorkflowRunSystemRecordContent({ sessionId: params.sessionId, content: record.content });
}

/**
 * Fetch and open the durable workflow run detail for one run id. Builds the stable join local id
 * shared with the CLI publisher so the read and write paths address the same record.
 */
export async function fetchWorkflowRunSnapshot(params: Readonly<{
    sessionId: string;
    runId: string;
    serverId?: string | null;
}>): Promise<SessionWorkflowRunSnapshotV1 | null> {
    const localId = buildWorkflowRunSystemRecordLocalId({ runId: params.runId });
    const record = await fetchSessionSystemRecord({
        sessionId: params.sessionId,
        namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
        localId,
        ...(params.serverId !== undefined ? { serverId: params.serverId } : {}),
    });
    return openWorkflowRunSystemRecord({ sessionId: params.sessionId, record, expectedLocalId: localId });
}
