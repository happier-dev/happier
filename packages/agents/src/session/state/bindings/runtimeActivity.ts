import {
  type SessionMetadata,
  type SessionStateFieldValue,
} from '@happier-dev/protocol';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol/sessions';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readRuntimeActivitySessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.activity'> {
  const state = (metadata as Record<string, unknown>).runtimeActivityState;
  const activeCount = (metadata as Record<string, unknown>).runtimeActivityActiveCount;
  const parsed = SessionRuntimeActivitySnapshotSchema.safeParse({
    state,
    activeCount,
  });
  if (!parsed.success) {
    return { value: null, updatedAt: null };
  }
  return {
    value: parsed.data,
    updatedAt: null,
  };
}

export function writeRuntimeActivitySessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  projection: SessionStateFieldValue<'runtime.activity'> | null,
): TMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  if (projection === null) {
    delete next.runtimeActivityState;
    delete next.runtimeActivityActiveCount;
    delete next.runtimeActivitySourceClass;
    return next as TMetadata;
  }
  const parsed = SessionRuntimeActivitySnapshotSchema.parse(projection);
  next.runtimeActivityState = parsed.state;
  next.runtimeActivityActiveCount = parsed.activeCount;
  delete next.runtimeActivitySourceClass;
  return next as TMetadata;
}

export const runtimeActivityBinding: SessionStateBinding<'runtime.activity'> = {
  read: readRuntimeActivitySessionState,
  write: (metadata, update) => writeRuntimeActivitySessionState(
    metadata,
    update.value,
  ),
};
