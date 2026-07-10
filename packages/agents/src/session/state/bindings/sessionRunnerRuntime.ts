import {
  SESSION_RUNNER_RUNTIME_METADATA_KEY,
  SessionRunnerRuntimeStateV1Schema,
  type SessionMetadata,
  type SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readSessionRunnerRuntimeSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.sessionRunner'> {
  const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_RUNNER_RUNTIME_METADATA_KEY],
  );
  if (!parsed.success) {
    return { value: null, updatedAt: null };
  }
  return {
    value: parsed.data,
    updatedAt: parsed.data.observedAtMs,
  };
}

export function writeSessionRunnerRuntimeSessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  state: SessionRunnerRuntimeStateV1 | null,
): TMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  if (state === null) {
    delete next[SESSION_RUNNER_RUNTIME_METADATA_KEY];
    return next as TMetadata;
  }
  next[SESSION_RUNNER_RUNTIME_METADATA_KEY] = SessionRunnerRuntimeStateV1Schema.parse(state);
  return next as TMetadata;
}

export const sessionRunnerRuntimeBinding: SessionStateBinding<'runtime.sessionRunner'> = {
  read: readSessionRunnerRuntimeSessionState,
  write: (metadata, update) => writeSessionRunnerRuntimeSessionState(
    metadata,
    update.value,
  ),
};
