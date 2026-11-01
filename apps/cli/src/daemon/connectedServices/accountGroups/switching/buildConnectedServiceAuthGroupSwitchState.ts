import type { ConnectedServiceAuthGroupV1, ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupMemberStateV1Schema } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  type ConnectedServiceAuthGroupMemberRuntimeState,
  type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupSwitchState } from './ConnectedServiceAuthGroupSwitchCoordinator';

export function normalizeConnectedServiceAuthGroupPolicy(value: ConnectedServiceAuthGroupV1['policy']): ConnectedServiceAuthGroupPolicyV1 {
  return {
    ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    ...value,
    switchOn: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.switchOn,
      ...value.switchOn,
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readCredentialHealthStatus(value: unknown): ConnectedServiceCredentialHealthStatusV1 | null {
  return value === 'connected' || value === 'refreshing' || value === 'needs_reauth' || value === 'refresh_failed_retryable'
    ? value
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergePersistedMemberRuntimeState(
  runtimeState: ConnectedServiceAuthGroupMemberRuntimeState | null,
  persistedState: unknown,
): ConnectedServiceAuthGroupMemberRuntimeState {
  const record = readRecord(persistedState);
  if (!record) return runtimeState ?? {};
  const parsed = ConnectedServiceAuthGroupMemberStateV1Schema.safeParse(record);
  const persistedLastFailureKind = readString(record.lastFailureKind);
  const persistedProviderResetsAtMs = readNonNegativeNumber(record.providerResetsAtMs);
  const runtimeProviderResetsAtMs = readNonNegativeNumber(runtimeState?.providerResetsAtMs);
  const persistedResetDescribesLimiterFailure = persistedProviderResetsAtMs !== null && (
    persistedLastFailureKind === 'usage_limit'
    || persistedLastFailureKind === 'rate_limit'
    || persistedLastFailureKind === 'capacity'
    || readNonNegativeNumber(record.exhaustedUntilMs) !== null
    || readNonNegativeNumber(record.quotaExhaustedUntilMs) !== null
    || readNonNegativeNumber(record.rateLimitedUntilMs) !== null
    || readNonNegativeNumber(record.capacityLimitedUntilMs) !== null
    || readNonNegativeNumber(record.cooldownUntilMs) !== null
  );
  const providerResetsAtMs = persistedResetDescribesLimiterFailure
    ? persistedProviderResetsAtMs
    : persistedProviderResetsAtMs !== null
      && (runtimeProviderResetsAtMs === null || persistedProviderResetsAtMs > runtimeProviderResetsAtMs)
      ? persistedProviderResetsAtMs
      : runtimeProviderResetsAtMs;
  return {
    ...(runtimeState ?? {}),
    ...(readCredentialHealthStatus(record.credentialHealthStatus) ? { credentialHealthStatus: readCredentialHealthStatus(record.credentialHealthStatus) } : {}),
    cooldownUntilMs: readNonNegativeNumber(record.cooldownUntilMs),
    exhaustedUntilMs: readNonNegativeNumber(record.exhaustedUntilMs),
    quotaExhaustedUntilMs: readNonNegativeNumber(record.quotaExhaustedUntilMs),
    rateLimitedUntilMs: readNonNegativeNumber(record.rateLimitedUntilMs),
    capacityLimitedUntilMs: readNonNegativeNumber(record.capacityLimitedUntilMs),
    authInvalidUntilMs: readNonNegativeNumber(record.authInvalidUntilMs),
    planUnavailableUntilMs: readNonNegativeNumber(record.planUnavailableUntilMs),
    ...(parsed.success && parsed.data.modelUnavailableUntilMsByModelId
      ? { modelUnavailableUntilMsByModelId: parsed.data.modelUnavailableUntilMsByModelId } : {}),
    ...(parsed.success && parsed.data.autoDisabledReason
      ? { autoDisabledReason: parsed.data.autoDisabledReason } : {}),
    lastFailureCode: readString(record.lastFailureCode),
    validationBlockedUntilMs: readNonNegativeNumber(record.validationBlockedUntilMs),
    providerResetsAtMs,
    lastFailureKind: persistedLastFailureKind,
    lastObservedAtMs: readNonNegativeNumber(record.lastObservedAtMs),
  };
}

export function buildConnectedServiceAuthGroupSwitchState(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  nowMs: number;
}>): ConnectedServiceAuthGroupSwitchState {
  const runtimeMemberStates = input.runtimeQuotaSnapshots.buildMemberStates({
    serviceId: input.group.serviceId,
    groupId: input.group.groupId,
    capturedAtMs: input.nowMs,
    quotaLimitSelection: input.group.policy.quotaLimitSelection,
  });
  return buildConnectedServiceAuthGroupSwitchStateFromMemberRuntimeStates({
    group: input.group,
    runtimeMemberStates,
  });
}

export function buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
}>): ConnectedServiceAuthGroupSwitchState {
  return buildConnectedServiceAuthGroupSwitchStateFromMemberRuntimeStates({
    group: input.group,
    runtimeMemberStates: new Map(),
  });
}

function buildConnectedServiceAuthGroupSwitchStateFromMemberRuntimeStates(input: Readonly<{
  group: ConnectedServiceAuthGroupV1;
  runtimeMemberStates: ReadonlyMap<string, ConnectedServiceAuthGroupMemberRuntimeState>;
}>): ConnectedServiceAuthGroupSwitchState {
  const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
  for (const member of input.group.members) {
    memberStatesByProfileId.set(
      member.profileId,
      mergePersistedMemberRuntimeState(input.runtimeMemberStates.get(member.profileId) ?? null, member.state),
    );
  }

  return {
    serviceId: input.group.serviceId,
    groupId: input.group.groupId,
    activeProfileId: input.group.activeProfileId,
    lastSwitchReason: input.group.state.lastSwitchReason,
    lastSwitchAt: input.group.state.lastSwitchAt,
    generation: input.group.generation,
    runtimeStateRevision: input.group.runtimeStateRevision,
    policy: normalizeConnectedServiceAuthGroupPolicy(input.group.policy),
    members: input.group.members.map((member) => ({
      profileId: member.profileId,
      priority: member.priority,
      enabled: member.enabled,
      createdAtMs: member.createdAt,
    })),
    memberStatesByProfileId,
  };
}
