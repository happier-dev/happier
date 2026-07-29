import {
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  ExternalSessionOperationStateV1Schema,
  type ExternalSessionOperationStateV1,
  type SessionMetadata,
  type SessionStateFieldValue,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

function statesEqual(
  left: ExternalSessionOperationStateV1,
  right: ExternalSessionOperationStateV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectExternalSessionOperationState(
  current: ExternalSessionOperationStateV1 | null,
  incoming: ExternalSessionOperationStateV1,
): ExternalSessionOperationStateV1 | null {
  if (!current) return incoming;

  const currentProgress = current.progress;
  const incomingProgress = incoming.progress;
  if (currentProgress.operationId === incomingProgress.operationId) {
    if (incomingProgress.revision > currentProgress.revision) return incoming;
    if (incomingProgress.revision < currentProgress.revision) return null;
    if (statesEqual(current, incoming)) return null;
    throw new Error('external_session_operation_projection_conflict');
  }

  // A timestamp cannot establish which different operation owns the session.
  // The canonical producer must explicitly clear a retained terminal selection
  // before publishing a newly admitted operation.
  throw new Error('external_session_operation_projection_conflict');
}

export function readExternalSessionOperationState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.externalSessionOperation'> {
  const parsed = ExternalSessionOperationStateV1Schema.safeParse(
    (metadata as Record<string, unknown>)[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
  );
  if (!parsed.success) return { value: null, updatedAt: null };
  return {
    value: parsed.data,
    updatedAt: parsed.data.progress.updatedAtMs,
  };
}

export function writeExternalSessionOperationState<
  TMetadata extends Record<string, unknown>,
>(
  metadata: TMetadata,
  state: SessionStateFieldValue<'runtime.externalSessionOperation'> | null,
): TMetadata {
  if (state === null) {
    const next = { ...metadata } as Record<string, unknown>;
    delete next[EXTERNAL_SESSION_OPERATION_METADATA_KEY];
    return next as TMetadata;
  }

  const incoming = ExternalSessionOperationStateV1Schema.parse(state);
  const current = readExternalSessionOperationState(metadata).value;
  const selected = selectExternalSessionOperationState(current, incoming);
  if (!selected) return metadata;
  return {
    ...metadata,
    [EXTERNAL_SESSION_OPERATION_METADATA_KEY]: selected,
  };
}

export const externalSessionOperationBinding:
SessionStateBinding<'runtime.externalSessionOperation'> = {
  read: readExternalSessionOperationState,
  write: (metadata, update) => writeExternalSessionOperationState(
    metadata,
    update.value,
  ),
};
