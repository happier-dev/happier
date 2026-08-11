import {
  ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  SessionBackgroundTaskRecordV1Schema,
  SessionWorkflowRunSnapshotV1Schema,
  buildBackgroundTaskSystemRecordLocalId as buildBackgroundTaskSystemRecordLocalIdShared,
  buildWorkflowRunSystemRecordLocalId as buildWorkflowRunSystemRecordLocalIdShared,
  type ActivitySessionSystemRecordKind,
  type SessionBackgroundTaskRecordV1,
  type SessionSystemRecordContent,
  type SessionSystemRecordNamespace,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  encryptSessionPayload,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

/**
 * CLI seal/open + local-id helpers for the generic `activity` session-system-record namespace,
 * mirroring `memory/memorySystemRecords.ts`. Workflow run detail is the only `activity` kind in
 * Phase 3 (`workflow_run.v1`). Encryption parity with memory is mandatory: encrypted sessions store
 * encrypted snapshots; the server never decrypts.
 */
export const ACTIVITY_SYSTEM_RECORD_NAMESPACE = SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE satisfies SessionSystemRecordNamespace;

export const ACTIVITY_SYSTEM_RECORD_KINDS = {
  workflowRun: ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0],
  backgroundTask: ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[1],
} as const satisfies Record<string, ActivitySessionSystemRecordKind>;

/**
 * Stable, idempotent local id for one workflow run's durable detail record. `runId` already encodes
 * the strongest available correlation id (workflow tool-use id, provider workflow/task id, or a
 * derived id) so the same run always upserts the same record.
 */
export function buildWorkflowRunSystemRecordLocalId(params: Readonly<{ runId: string }>): string {
  return buildWorkflowRunSystemRecordLocalIdShared(params);
}

function parseWorkflowRunSnapshot(payload: unknown): SessionWorkflowRunSnapshotV1 | null {
  const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function sealWorkflowRunSystemRecordPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  payload: SessionWorkflowRunSnapshotV1;
}>): SessionSystemRecordContent {
  const payload = parseWorkflowRunSnapshot(params.payload);
  if (!payload) {
    throw new Error('Invalid activity workflow_run.v1 system record payload');
  }
  if (params.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  if (!params.ctx) {
    throw new Error('Missing session encryption context for encrypted activity system record');
  }
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx: params.ctx, payload }),
  };
}

export function openWorkflowRunSystemRecordPayload(params: Readonly<{
  namespace?: SessionSystemRecordNamespace;
  content: SessionSystemRecordContent;
  ctx?: SessionEncryptionContext;
}>): SessionWorkflowRunSnapshotV1 | null {
  if (params.namespace && params.namespace !== ACTIVITY_SYSTEM_RECORD_NAMESPACE) return null;
  if (params.content.t === 'plain') {
    return parseWorkflowRunSnapshot(params.content.v);
  }
  if (!params.ctx) return null;
  try {
    const decrypted = decryptSessionPayload({ ctx: params.ctx, ciphertextBase64: params.content.c });
    return parseWorkflowRunSnapshot(decrypted);
  } catch {
    return null;
  }
}

/**
 * Stable, idempotent local id for one background task's durable detail record. Re-exported through
 * this module so CLI callers address `activity` records through one door, exactly as the workflow
 * builder is.
 */
export function buildBackgroundTaskSystemRecordLocalId(params: Readonly<{ taskId: string }>): string {
  return buildBackgroundTaskSystemRecordLocalIdShared(params);
}

function parseBackgroundTaskRecord(payload: unknown): SessionBackgroundTaskRecordV1 | null {
  const parsed = SessionBackgroundTaskRecordV1Schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Seals one `activity/background_task.v1` payload with the same encryption parity as its workflow
 * sibling: an encrypted session stores an encrypted record and the server never decrypts.
 *
 * The schema parse here is load-bearing beyond typing. `SessionBackgroundTaskRecordV1Schema` is
 * `.strip()`ed and bounds the label at the redactor's own truncation length, so a label that never
 * went through `redactBackgroundCommand` fails to seal rather than persisting a raw command.
 */
export function sealBackgroundTaskSystemRecordPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  payload: SessionBackgroundTaskRecordV1;
}>): SessionSystemRecordContent {
  const payload = parseBackgroundTaskRecord(params.payload);
  if (!payload) {
    throw new Error('Invalid activity background_task.v1 system record payload');
  }
  if (params.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  if (!params.ctx) {
    throw new Error('Missing session encryption context for encrypted activity system record');
  }
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx: params.ctx, payload }),
  };
}
