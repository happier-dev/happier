import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import {
  hasSameUsageLimitRecoveryIdentity,
  mergeUsageLimitRecoveryExplicitRearm,
  mergeUsageLimitRecoveryIntent,
  mergeUsageLimitRecoveryRearm,
} from './mergeUsageLimitRecoveryIntent';
import { deterministicStringify } from '@/utils/deterministicJson';

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

export function mergeUsageLimitRecoveryFieldIntoMetadata(input: Readonly<{
  latestMetadata: Record<string, unknown>;
  /** Actual predecessor used to author the candidate; omit for an unbased projection. */
  baseMetadata?: Record<string, unknown>;
  candidateMetadata: Record<string, unknown>;
  mode?: 'converge' | 'rearm' | 'explicit_rearm' | 'cancel';
}>): Record<string, unknown> {
  const key = SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY;
  const baseMetadata = input.baseMetadata ?? {};
  const candidateHasField = Object.prototype.hasOwnProperty.call(input.candidateMetadata, key);
  const baseHasField = Object.prototype.hasOwnProperty.call(baseMetadata, key);
  const clearRequested = (baseHasField && !candidateHasField)
    || (candidateHasField && input.candidateMetadata[key] === null);
  if (clearRequested) {
    if (Object.prototype.hasOwnProperty.call(input.latestMetadata, key)) {
      const baseIdentity = readAttemptIdentity(baseMetadata[key]);
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
  const latest = SessionUsageLimitRecoveryV1Schema.safeParse(input.latestMetadata[key]);
  const candidate = SessionUsageLimitRecoveryV1Schema.safeParse(input.candidateMetadata[key]);
  const base = SessionUsageLimitRecoveryV1Schema.safeParse(baseMetadata[key]);
  // A sequential owner transition applies as authored. Concurrent or unbased
  // projections converge below, preserving terminal and replacement state.
  if ((input.mode === undefined || input.mode === 'converge')
    && latest.success && candidate.success && base.success
    && deterministicStringify(latest.data) === deterministicStringify(base.data)) {
    return { ...input.latestMetadata, [key]: candidate.data };
  }
  if (input.mode === 'cancel') {
    if (
      !base.success
      || !latest.success
      || !candidate.success
      || !hasSameUsageLimitRecoveryIdentity(latest.data, base.data)
      || !hasSameUsageLimitRecoveryIdentity(candidate.data, base.data)
    ) return input.latestMetadata;
  }
  const merged = candidate.success && (input.mode === 'rearm' || input.mode === 'explicit_rearm')
    ? input.mode === 'explicit_rearm'
      ? mergeUsageLimitRecoveryExplicitRearm(latest.success ? latest.data : null, candidate.data)
      : mergeUsageLimitRecoveryRearm(latest.success ? latest.data : null, candidate.data)
    : mergeUsageLimitRecoveryIntent(input.latestMetadata[key], input.candidateMetadata[key]);
  return merged ? { ...input.latestMetadata, [key]: merged } : input.latestMetadata;
}
