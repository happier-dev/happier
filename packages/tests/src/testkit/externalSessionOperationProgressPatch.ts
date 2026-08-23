import {
  ExternalSessionOperationAuthorIntentV1Schema,
  ExternalSessionOperationProgressV1Schema,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  SessionMetadataTuplePatchV1Schema,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionSharedMetadataV1Schema,
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationProgressV1,
  type ExternalSessionOperationReferenceV1,
  type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions';

import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';

const EXTERNAL_SESSION_OPERATION_COMPLETION_RECEIPT_RETENTION_MS =
  24 * 60 * 60 * 1_000;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCompletionReceipt(): never {
  throw new Error('Expected a strict minimal completion receipt.');
}

export function readExternalSessionOperationCompletionReceipt(
  value: unknown,
): Readonly<{
  reference: ExternalSessionOperationReferenceV1;
  presentation: ExternalSessionOperationSharedPresentationV1;
  persistedKeys: readonly string[];
}> {
  if (!isRecord(value)) invalidCompletionReceipt();
  const allowedKeys = new Set([
    'v',
    'recordKind',
    'reference',
    'presentation',
    'durableIdempotencyKey',
    'idempotencyIntentDigest',
    'authorIntent',
    'completedAtMs',
    'expiresAtMs',
  ]);
  const persistedKeys = Object.keys(value).sort();
  if (
    value.v !== 1
    || value.recordKind !== 'completed_receipt'
    || persistedKeys.some((key) => !allowedKeys.has(key))
    || typeof value.durableIdempotencyKey !== 'string'
    || value.durableIdempotencyKey.length < 1
    || value.durableIdempotencyKey.length > 256
    || value.durableIdempotencyKey !== value.durableIdempotencyKey.trim()
    || typeof value.idempotencyIntentDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.idempotencyIntentDigest)
    || typeof value.completedAtMs !== 'number'
    || !Number.isSafeInteger(value.completedAtMs)
    || value.completedAtMs < 0
    || typeof value.expiresAtMs !== 'number'
    || !Number.isSafeInteger(value.expiresAtMs)
    || value.expiresAtMs < 0
    || value.completedAtMs > Number.MAX_SAFE_INTEGER
      - EXTERNAL_SESSION_OPERATION_COMPLETION_RECEIPT_RETENTION_MS
    || value.expiresAtMs !== value.completedAtMs
      + EXTERNAL_SESSION_OPERATION_COMPLETION_RECEIPT_RETENTION_MS
  ) {
    invalidCompletionReceipt();
  }
  const reference = ExternalSessionOperationReferenceV1Schema.safeParse(
    value.reference,
  );
  const presentation =
    ExternalSessionOperationSharedPresentationV1Schema.safeParse(
      value.presentation,
    );
  const authorIntent = value.authorIntent === undefined
    ? null
    : ExternalSessionOperationAuthorIntentV1Schema.safeParse(
        value.authorIntent,
      );
  const authorIntentMismatch = authorIntent?.success === true && (
    authorIntent.data.kind === 'takeover'
      ? presentation.success
        && presentation.data.kind !== `takeover_${authorIntent.data.targetStorageMode.replace('-', '_')}`
      : reference.success
        && presentation.success
        && (
          reference.data.sessionId !== authorIntent.data.sessionId
          || presentation.data.kind !== 'materialize'
        )
  );
  if (
    !reference.success
    || !presentation.success
    || authorIntent !== null && !authorIntent.success
    || authorIntentMismatch
    || reference.data.operationId !== presentation.data.operationId
    || reference.data.revision !== presentation.data.revision
    // Independently restated, not imported: a completion receipt records a
    // settled operation, so its presentation carries the settled status the
    // record ended on.
    || !['completed', 'cancelled', 'discarded'].includes(
      presentation.data.status,
    )
  ) {
    invalidCompletionReceipt();
  }
  return {
    reference: reference.data,
    presentation: presentation.data,
    persistedKeys,
  };
}

export function readPlainSessionOwnerOperationProgress(
  session: unknown,
): ExternalSessionOperationProgressV1 | null {
  if (!isRecord(session) || session.metadataLayoutVersion !== 1) {
    throw new Error('Expected a layout-1 Session metadata tuple.');
  }
  const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.safeParse(
    session.ownerMetadata,
  );
  if (!ownerMetadata.success || ownerMetadata.data.t !== 'plain') {
    throw new Error('Expected a plain Session owner metadata envelope.');
  }
  const operation = ownerMetadata.data.v.runtime?.externalSessionOperationV1;
  if (operation === undefined) return null;
  const progress = ExternalSessionOperationProgressV1Schema.safeParse(
    operation.progress,
  );
  if (!progress.success) {
    throw new Error('Plain Session owner operation progress was malformed.');
  }
  return progress.data;
}

export function readImportingMaterializeProgressPatch(params: Readonly<{
  request: RecordedHttpProxyRequest;
  sessionId: string;
  acceptedThroughServerSeqExclusive: number;
}>): ExternalSessionOperationSharedPresentationV1 | null {
  const contentType = params.request.headers['content-type'];
  const contentTypeValue = Array.isArray(contentType)
    ? contentType[0]
    : contentType;
  if (
    params.request.method !== 'PATCH'
    || params.request.path
      !== `/v2/sessions/${encodeURIComponent(params.sessionId)}`
    || typeof contentTypeValue !== 'string'
    || !/^application\/json(?:\s*;|$)/iu.test(contentTypeValue)
    || params.request.body === null
    || params.request.body.complete !== true
    || params.request.body.truncated
    || Buffer.byteLength(params.request.body.text)
      !== params.request.body.byteLength
    || !Number.isSafeInteger(params.acceptedThroughServerSeqExclusive)
    || params.acceptedThroughServerSeqExclusive <= 1
  ) {
    return null;
  }
  const patch = SessionMetadataTuplePatchV1Schema.safeParse(
    parseJson(params.request.body.text),
  );
  if (!patch.success || patch.data.mode !== 'owner') return null;
  if (
    patch.data.expectedOwnerMetadata.t !== 'plain'
    || patch.data.ownerMetadata.t !== 'plain'
  ) {
    return null;
  }
  const previousProgress = ExternalSessionOperationProgressV1Schema.safeParse(
    patch.data.expectedOwnerMetadata.v.runtime
      ?.externalSessionOperationV1?.progress,
  );
  const nextProgress = ExternalSessionOperationProgressV1Schema.safeParse(
    patch.data.ownerMetadata.v.runtime?.externalSessionOperationV1?.progress,
  );
  if (!previousProgress.success || !nextProgress.success) return null;
  const acceptedThroughServerSeq =
    nextProgress.data.checkpoint.acceptedThroughServerSeq;
  if (
    nextProgress.data.request.plan !== 'materialize'
    || nextProgress.data.request.targetStorageMode !== 'external-linked'
    || nextProgress.data.status !== 'running'
    || nextProgress.data.phase !== 'importing'
    || nextProgress.data.currentStorageState !== 'server_partial'
    || acceptedThroughServerSeq === undefined
    || !Number.isSafeInteger(acceptedThroughServerSeq)
    || acceptedThroughServerSeq <= 0
    || acceptedThroughServerSeq
      >= params.acceptedThroughServerSeqExclusive
    || nextProgress.data.fence.kind !== 'initial_server_partial'
    || nextProgress.data.fence.acceptedThroughServerSeq
      !== acceptedThroughServerSeq
    || (
      previousProgress.data.operationId === nextProgress.data.operationId
      && previousProgress.data.revision >= nextProgress.data.revision
    )
  ) {
    return null;
  }
  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(
    parseJson(patch.data.sharedMetadata.ciphertext),
  );
  if (!sharedMetadata.success) return null;
  const presentation =
    ExternalSessionOperationSharedPresentationV1Schema.safeParse(
      sharedMetadata.data.externalSessionOperationPresentationV1,
    );
  if (
    !presentation.success
    || presentation.data.kind !== 'materialize'
    || presentation.data.status !== 'running'
    || presentation.data.phase !== 'importing'
    || JSON.stringify(presentation.data)
      !== JSON.stringify(
        projectExternalSessionOperationSharedPresentationV1(
          nextProgress.data,
        ),
      )
  ) {
    return null;
  }
  return presentation.data;
}
