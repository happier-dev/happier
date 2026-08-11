import type {
  SessionBackgroundTaskRecordV1,
  SessionSystemRecordUpsertRequest,
  SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

import {
  ACTIVITY_SYSTEM_RECORD_KINDS,
  ACTIVITY_SYSTEM_RECORD_NAMESPACE,
  buildBackgroundTaskSystemRecordLocalId,
  buildWorkflowRunSystemRecordLocalId,
  sealBackgroundTaskSystemRecordPayload,
  sealWorkflowRunSystemRecordPayload,
} from './activitySystemRecords';

/**
 * Idempotent durable commit for ONE workflow run's `activity/workflow_run.v1` system record (CWF3).
 *
 * Mirrors `commitMemorySystemRecords` but per run: the publisher calls this for each run whose
 * normalized snapshot changed materially. The stable local id (`activity:workflow_run:v1:${runId}`)
 * makes the upsert idempotent, so re-commits replace in place. Encryption parity with memory is
 * mandatory — encrypted sessions store encrypted snapshots; the server never decrypts.
 */

export async function commitWorkflowActivitySystemRecord(params: Readonly<{
  sessionId: string;
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  snapshot: SessionWorkflowRunSnapshotV1;
  upsertSystemRecord: (request: SessionSystemRecordUpsertRequest) => Promise<void>;
}>): Promise<void> {
  const localId = buildWorkflowRunSystemRecordLocalId({ runId: params.snapshot.runId });
  const request: SessionSystemRecordUpsertRequest = {
    namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
    kind: ACTIVITY_SYSTEM_RECORD_KINDS.workflowRun,
    localId,
    content: sealWorkflowRunSystemRecordPayload({
      mode: params.mode,
      ...(params.ctx ? { ctx: params.ctx } : {}),
      payload: params.snapshot,
    }),
  };

  await params.upsertSystemRecord(request);
}

/**
 * Idempotent durable commit for ONE background task's `activity/background_task.v1` system record
 * (PLAN 4.9, R-9).
 *
 * Same shape, same namespace and the same encryption parity as its workflow sibling above — one
 * commit owner for the `activity` namespace rather than a second write path per kind. The stable
 * local id (`activity:background_task:v1:${taskId}`) makes the upsert idempotent, so a retry
 * replaces the record in place instead of accumulating duplicates.
 */
export async function commitBackgroundTaskActivitySystemRecord(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  record: SessionBackgroundTaskRecordV1;
  upsertSystemRecord: (request: SessionSystemRecordUpsertRequest) => Promise<void>;
}>): Promise<void> {
  const request: SessionSystemRecordUpsertRequest = {
    namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
    kind: ACTIVITY_SYSTEM_RECORD_KINDS.backgroundTask,
    localId: buildBackgroundTaskSystemRecordLocalId({ taskId: params.record.taskId }),
    content: sealBackgroundTaskSystemRecordPayload({
      mode: params.mode,
      ...(params.ctx ? { ctx: params.ctx } : {}),
      payload: params.record,
    }),
  };

  await params.upsertSystemRecord(request);
}
