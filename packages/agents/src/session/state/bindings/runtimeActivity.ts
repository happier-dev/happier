import {
  type SessionMetadata,
  type SessionStateFieldValue,
} from '@happier-dev/protocol';
import { SessionRuntimeActivityProjectionV1Schema } from '@happier-dev/protocol/sessions';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readRuntimeActivitySessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.activity'> {
  const activeCount = (metadata as Record<string, unknown>).runtimeActivityActiveCount;
  const observedAtMs = (metadata as Record<string, unknown>).runtimeActivityObservedAt;
  const expiresAtMs = (metadata as Record<string, unknown>).runtimeActivityExpiresAt;
  const sourceClass = (metadata as Record<string, unknown>).runtimeActivitySourceClass;
  const parsed = SessionRuntimeActivityProjectionV1Schema.safeParse({
    v: 1,
    activeCount,
    observedAtMs: observedAtMs ?? null,
    expiresAtMs: expiresAtMs ?? null,
    sourceClass: sourceClass ?? null,
  });
  if (!parsed.success) {
    return { value: null, updatedAt: null };
  }
  return {
    value: parsed.data,
    updatedAt: parsed.data.observedAtMs,
  };
}

export function writeRuntimeActivitySessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  projection: SessionStateFieldValue<'runtime.activity'> | null,
): TMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  if (projection === null) {
    delete next.runtimeActivityActiveCount;
    delete next.runtimeActivityObservedAt;
    delete next.runtimeActivityExpiresAt;
    delete next.runtimeActivitySourceClass;
    return next as TMetadata;
  }
  const parsed = SessionRuntimeActivityProjectionV1Schema.parse(projection);
  next.runtimeActivityActiveCount = parsed.activeCount;
  next.runtimeActivityObservedAt = parsed.observedAtMs;
  next.runtimeActivityExpiresAt = parsed.expiresAtMs;
  next.runtimeActivitySourceClass = parsed.sourceClass;
  return next as TMetadata;
}

export const runtimeActivityBinding: SessionStateBinding<'runtime.activity'> = {
  read: readRuntimeActivitySessionState,
  write: (metadata, update) => writeRuntimeActivitySessionState(
    metadata,
    update.value,
  ),
};
