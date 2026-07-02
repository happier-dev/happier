import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  type SessionMetadata,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readSessionUsageLimitRecoverySessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.usageLimitRecovery'> {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success) {
    return { value: null, updatedAt: null };
  }
  return {
    value: parsed.data,
    updatedAt: parsed.data.armedAtMs,
  };
}

export function writeSessionUsageLimitRecoverySessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  recovery: SessionUsageLimitRecoveryV1 | null,
): TMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  if (recovery === null) {
    delete next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
    return next as TMetadata;
  }
  next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] = SessionUsageLimitRecoveryV1Schema.parse(recovery);
  return next as TMetadata;
}

export const sessionUsageLimitRecoveryBinding: SessionStateBinding<'runtime.usageLimitRecovery'> = {
  read: readSessionUsageLimitRecoverySessionState,
  write: (metadata, update) => writeSessionUsageLimitRecoverySessionState(
    metadata,
    update.value,
  ),
};
