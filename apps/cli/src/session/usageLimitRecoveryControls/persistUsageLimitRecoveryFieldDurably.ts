import { isDeepStrictEqual } from 'node:util';

import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  hasSameUsageLimitRecoveryIdentity,
  mergeUsageLimitRecoveryIntent,
  mergeUsageLimitRecoveryExplicitRearm,
  mergeUsageLimitRecoveryRearm,
} from './mergeUsageLimitRecoveryIntent';

type UsageLimitRecoveryFieldMergeMode = 'converge' | 'rearm' | 'explicit_rearm' | 'cancel' | 'observed_timing';

function hasOwn(metadata: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, key);
}

function readAttemptIdentity(value: unknown): Readonly<{
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}> | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(value);
  return parsed.success
    ? {
        issueFingerprint: parsed.data.issueFingerprint,
        armedAtMs: parsed.data.armedAtMs,
        ...(parsed.data.runtimeAuthRecoveryAttemptId
          ? { runtimeAuthRecoveryAttemptId: parsed.data.runtimeAuthRecoveryAttemptId }
          : {}),
      }
    : null;
}

export function cancelLatestUsageLimitRecoveryInMetadataAfterExplicitStop(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success) return metadata;
  if (
    parsed.data.status !== 'waiting'
    && parsed.data.status !== 'armed'
    && parsed.data.status !== 'checking'
  ) return metadata;
  return {
    ...metadata,
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
      ...parsed.data,
      status: 'cancelled',
      nextCheckAtMs: null,
    },
  };
}

export function mergeUsageLimitRecoveryFieldIntoMetadata(input: Readonly<{
  latestMetadata: Record<string, unknown>;
  baseMetadata: Record<string, unknown>;
  candidateMetadata: Record<string, unknown>;
  mode?: UsageLimitRecoveryFieldMergeMode;
}>): Record<string, unknown> {
  const key = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;
  const candidateHasField = hasOwn(input.candidateMetadata, key);
  const baseHasField = hasOwn(input.baseMetadata, key);
  const clearRequested = (baseHasField && !candidateHasField)
    || (candidateHasField && input.candidateMetadata[key] === null);
  if (clearRequested) {
    if (hasOwn(input.latestMetadata, key)) {
      const baseIdentity = readAttemptIdentity(input.baseMetadata[key]);
      const latestIdentity = readAttemptIdentity(input.latestMetadata[key]);
      if (
        !baseIdentity
        || !latestIdentity
        || !hasSameUsageLimitRecoveryIdentity(latestIdentity, baseIdentity)
      ) return input.latestMetadata;
    }
    const next = { ...input.latestMetadata };
    delete next[key];
    return next;
  }
  if (!candidateHasField) return input.latestMetadata;

  const parsedLatest = SessionUsageLimitRecoveryV1Schema.safeParse(input.latestMetadata[key]);
  const parsedCandidate = SessionUsageLimitRecoveryV1Schema.safeParse(input.candidateMetadata[key]);
  if (input.mode === 'cancel') {
    const parsedBase = SessionUsageLimitRecoveryV1Schema.safeParse(input.baseMetadata[key]);
    if (
      !parsedBase.success
      || !parsedLatest.success
      || !parsedCandidate.success
      || !hasSameUsageLimitRecoveryIdentity(parsedLatest.data, parsedBase.data)
      || !hasSameUsageLimitRecoveryIdentity(parsedCandidate.data, parsedBase.data)
    ) return input.latestMetadata;
  }
  // A current probe can replace its own earlier timing, including with an unknown
  // reset. Preserve concurrent changes to the attempt before applying the reading.
  if (input.mode === 'observed_timing' && parsedLatest.success && parsedCandidate.success) {
    const parsedBase = SessionUsageLimitRecoveryV1Schema.safeParse(input.baseMetadata[key]);
    if (parsedBase.success && hasSameUsageLimitRecoveryIdentity(parsedBase.data, parsedCandidate.data)) {
      if (!isDeepStrictEqual(parsedLatest.data, parsedBase.data)) return input.latestMetadata;
      const merged = mergeUsageLimitRecoveryIntent(parsedLatest.data, parsedCandidate.data);
      if (merged) {
        return {
          ...input.latestMetadata,
          [key]: {
            ...merged,
            resetAtMs: parsedCandidate.data.resetAtMs,
            nextCheckAtMs: parsedCandidate.data.nextCheckAtMs,
          },
        };
      }
    }
  }
  const merged = parsedCandidate.success && (input.mode === 'rearm' || input.mode === 'explicit_rearm')
    ? input.mode === 'explicit_rearm'
      ? mergeUsageLimitRecoveryExplicitRearm(parsedLatest.success ? parsedLatest.data : null, parsedCandidate.data)
      : mergeUsageLimitRecoveryRearm(parsedLatest.success ? parsedLatest.data : null, parsedCandidate.data)
    : mergeUsageLimitRecoveryIntent(input.latestMetadata[key], input.candidateMetadata[key]);
  return merged
    ? { ...input.latestMetadata, [key]: merged }
    : input.latestMetadata;
}

export async function persistUsageLimitRecoveryFieldDurably(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  currentMetadata: Record<string, unknown>;
  nextMetadata: Record<string, unknown>;
  mode?: UsageLimitRecoveryFieldMergeMode;
}>): Promise<Record<string, unknown>> {
  const persisted = await updateSessionMetadataWithRetry({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    updater: (latestMetadata) => mergeUsageLimitRecoveryFieldIntoMetadata({
      latestMetadata,
      baseMetadata: params.currentMetadata,
      candidateMetadata: params.nextMetadata,
      ...(params.mode ? { mode: params.mode } : {}),
    }),
  });
  return persisted.metadata;
}

export async function persistExplicitSessionStopUsageLimitRecoveryCancellation(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
}>): Promise<Record<string, unknown>> {
  const persisted = await updateSessionMetadataWithRetry({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    updater: cancelLatestUsageLimitRecoveryInMetadataAfterExplicitStop,
  });
  return persisted.metadata;
}
