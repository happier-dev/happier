import { SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION, SessionWorkflowRunSnapshotV1Schema, type SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
import { buildWorkflowRunSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import {
    openSessionSystemRecord,
    type OpenSessionSystemRecordResult,
    type SessionSystemRecordOpenInput,
    type SessionSystemRecordPayloadResult,
} from '@/sync/domains/sessionSystemRecords/codec';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';

function decodeWorkflowSnapshot(runId: string, value: unknown): SessionSystemRecordPayloadResult<SessionWorkflowRunSnapshotV1> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('v' in value && typeof value.v === 'number' && Number.isInteger(value.v) && value.v !== 1) return { status: 'unsupported_version', version: value.v };
        if ('projectionVersion' in value && typeof value.projectionVersion === 'number' && Number.isInteger(value.projectionVersion) && value.projectionVersion !== SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION) return { status: 'unsupported_version', version: value.projectionVersion };
    }
    const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(value);
    return parsed.success && parsed.data.runId === runId ? { status: 'ready', value: parsed.data } : { status: 'malformed' };
}

export async function openWorkflowRunSystemRecord(params: Readonly<{
    runId: string;
    record: SessionSystemRecordOpenInput;
    context: SessionStoredContentContext | null;
}>): Promise<OpenSessionSystemRecordResult<SessionWorkflowRunSnapshotV1>> {
    const localId = buildWorkflowRunSystemRecordLocalId({ runId: params.runId });
    return await openSessionSystemRecord({
        record: params.record,
        address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId },
        context: params.context,
        decode: (value) => decodeWorkflowSnapshot(params.runId, value),
    });
}
