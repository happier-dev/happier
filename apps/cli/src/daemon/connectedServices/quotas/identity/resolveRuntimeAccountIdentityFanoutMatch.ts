import type { ConnectedServiceSameAccountFanoutStrategy } from './providerFanoutStrategy';
import type {
  RuntimeAccountIdentityFanoutProbeResult,
  RuntimeAccountIdentityRecordInput,
} from './runtimeAccountIdentityTypes';

type ExactRuntimeAccountIdentityFanoutProbeResult = Extract<
  RuntimeAccountIdentityFanoutProbeResult,
  Readonly<{ status: 'exact' }>
>;

export type RuntimeIdentityFanoutSuppressionReason =
  | 'same_account_fanout_runtime_identity_probe_inexact'
  | 'same_account_fanout_runtime_identity_strategy_unsupported'
  | 'same_account_fanout_group_mismatch'
  | 'runtime_identity_probe_account_mismatch';

export type RuntimeIdentityFanoutSuppressionDiagnostic = Readonly<{
  sessionId: string;
  expectedProviderAccountId?: string | null;
  actualProviderAccountId?: string | null;
  expectedProfileId: string;
  actualProfileId?: string | null;
  expectedGroupId: string;
  actualGroupId?: string | null;
  expectedGroupGeneration: number | null;
  actualGroupGeneration?: number | null;
}>;

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function readObservedAtMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function buildSuppressionDiagnostic(input: Readonly<{
  providerAccountId?: string | null;
  candidate: Readonly<{
    sessionId: string;
    groupId: string;
    profileId: string;
    groupGeneration: number | null;
  }>;
  result: ExactRuntimeAccountIdentityFanoutProbeResult;
}>): RuntimeIdentityFanoutSuppressionDiagnostic {
  const actualGroupGeneration = input.result.groupGeneration === undefined
    ? input.candidate.groupGeneration
    : normalizeNullableGeneration(input.result.groupGeneration);
  return {
    sessionId: input.candidate.sessionId,
    expectedProviderAccountId: readNonEmptyString(input.providerAccountId) || null,
    actualProviderAccountId: readNonEmptyString(input.result.providerAccountId) || null,
    expectedProfileId: input.candidate.profileId,
    actualProfileId: readNonEmptyString(input.result.profileId) || input.candidate.profileId,
    expectedGroupId: input.candidate.groupId,
    actualGroupId: readNonEmptyString(input.result.groupId) || input.candidate.groupId,
    expectedGroupGeneration: normalizeNullableGeneration(input.candidate.groupGeneration),
    actualGroupGeneration,
  };
}

export function resolveRuntimeAccountIdentityFanoutMatch(input: Readonly<{
  strategy: ConnectedServiceSameAccountFanoutStrategy;
  providerAccountId?: string | null;
  candidate: Readonly<{
    sessionId: string;
    serviceId: RuntimeAccountIdentityRecordInput['serviceId'];
    groupId: string;
    profileId: string;
    groupGeneration: number | null;
  }>;
  result: ExactRuntimeAccountIdentityFanoutProbeResult;
  observedAtMs: number;
}>): Readonly<{
  status: 'matched';
  entry: RuntimeAccountIdentityRecordInput;
  accountLabel: string | null;
  observedProfileId: string;
}> | Readonly<{
  status: 'suppressed';
  reason: RuntimeIdentityFanoutSuppressionReason;
  diagnostic: RuntimeIdentityFanoutSuppressionDiagnostic;
}> {
  const strategy = input.result.strategy ?? 'provider_account_id';
  if (strategy !== input.strategy) {
    return {
      status: 'suppressed',
      reason: 'same_account_fanout_runtime_identity_strategy_unsupported',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const providerAccountId = readNonEmptyString(input.result.providerAccountId);
  const sharedAuthSurfaceId = readNonEmptyString(input.result.sharedAuthSurfaceId);
  if (input.strategy === 'provider_account_id') {
    const expectedProviderAccountId = readNonEmptyString(input.providerAccountId);
    if (!providerAccountId || !expectedProviderAccountId) {
      return {
        status: 'suppressed',
        reason: 'same_account_fanout_runtime_identity_probe_inexact',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
    if (providerAccountId !== expectedProviderAccountId) {
      return {
        status: 'suppressed',
        reason: 'runtime_identity_probe_account_mismatch',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
  } else if (input.strategy === 'shared_group_auth_surface') {
    if (!sharedAuthSurfaceId) {
      return {
        status: 'suppressed',
        reason: 'same_account_fanout_runtime_identity_probe_inexact',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
    if (sharedAuthSurfaceId !== input.candidate.groupId) {
      return {
        status: 'suppressed',
        reason: 'same_account_fanout_group_mismatch',
        diagnostic: buildSuppressionDiagnostic(input),
      };
    }
  } else {
    return {
      status: 'suppressed',
      reason: 'same_account_fanout_runtime_identity_strategy_unsupported',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const profileId = readNonEmptyString(input.result.profileId) || input.candidate.profileId;
  const groupId = readNonEmptyString(input.result.groupId) || input.candidate.groupId;
  const groupGeneration = input.result.groupGeneration === undefined
    ? input.candidate.groupGeneration
    : normalizeNullableGeneration(input.result.groupGeneration);
  if (groupId !== input.candidate.groupId) {
    return {
      status: 'suppressed',
      reason: 'same_account_fanout_group_mismatch',
      diagnostic: buildSuppressionDiagnostic(input),
    };
  }

  const accountLabel = readNonEmptyString(input.result.accountLabel) || null;
  const entry: RuntimeAccountIdentityRecordInput = {
    sessionId: input.candidate.sessionId,
    serviceId: input.candidate.serviceId,
    groupId: input.candidate.groupId,
    profileId,
    providerAccountId,
    accountLabel,
    observedAtMs: readObservedAtMs(input.result.observedAtMs, input.observedAtMs),
    source: 'runtime_identity_probe',
    proofStrength: 'exact',
    groupGeneration,
  };

  return {
    status: 'matched',
    entry,
    accountLabel,
    observedProfileId: profileId,
  };
}
