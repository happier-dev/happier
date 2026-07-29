import {
  EXTERNAL_AGENT_OBSERVATION_METADATA_KEY,
  ExternalAgentObservationSnapshotV1Schema,
  type SessionMetadata,
  type SessionStateFieldValue,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readExternalAgentObservationSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.externalAgent'> {
  const parsed = ExternalAgentObservationSnapshotV1Schema.safeParse(
    (metadata as Record<string, unknown>)[EXTERNAL_AGENT_OBSERVATION_METADATA_KEY],
  );
  if (!parsed.success) {
    return { value: null, updatedAt: null };
  }
  return {
    value: parsed.data,
    updatedAt: parsed.data.observedAtMs ?? parsed.data.boundary?.observedAtMs ?? null,
  };
}

export function writeExternalAgentObservationSessionState<
  TMetadata extends Record<string, unknown>,
>(
  metadata: TMetadata,
  snapshot: SessionStateFieldValue<'runtime.externalAgent'> | null,
): TMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  if (snapshot === null) {
    delete next[EXTERNAL_AGENT_OBSERVATION_METADATA_KEY];
    return next as TMetadata;
  }
  next[EXTERNAL_AGENT_OBSERVATION_METADATA_KEY] =
    ExternalAgentObservationSnapshotV1Schema.parse(snapshot);
  return next as TMetadata;
}

export const externalAgentObservationBinding:
SessionStateBinding<'runtime.externalAgent'> = {
  read: readExternalAgentObservationSessionState,
  write: (metadata, update) => writeExternalAgentObservationSessionState(
    metadata,
    update.value,
  ),
};
