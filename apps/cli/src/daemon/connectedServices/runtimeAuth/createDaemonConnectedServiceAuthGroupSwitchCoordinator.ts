import {
  ConnectedServiceIdSchema,
  isConnectedServiceCredentialHealthStatusReconnectRequired,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceAuthGroupMemberStateV1,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  ConnectedServiceAuthGroupSwitchCoordinator,
  InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
  type ConnectedServiceAuthGroupSwitchState,
  type ConnectedServiceAuthGroupSwitchEvent,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { evaluatePredictiveSoftSwitchSessionApplyPolicy } from '../accountGroups/switching/predictiveSoftSwitchPolicy';
import {
  buildConnectedServiceAuthGroupSwitchState,
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
  type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import { buildObservedFailureMemberRuntimeState } from '../accountGroups/memberRuntimeState';
import type { AcceptedConnectedServiceAccountVerificationByServiceId } from '../accountTransitions/acceptedConnectedServiceAccountVerification';
import { createConnectedServiceAuthGenerationApplyFailureError } from './connectedServiceAuthGenerationApplyFailure';
import type { ConnectedServiceSessionAuthSwitchReason } from './connectedServiceSessionAuthSwitchCore';
import { ConnectedServiceAuthGroupRuntimeStateRevisionConflictError } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { ConnectedServiceAuthGroupCandidatePreparationResult } from '../refresh/prepareConnectedServiceAuthGroupCandidateForSwitch';
import type { ConnectedServiceGroupQuotaProbeResult } from '../quotas/ConnectedServiceQuotasCoordinator';

type AuthGroupApi = Readonly<{
  getConnectedServiceAuthGroup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>): Promise<ConnectedServiceAuthGroupV1 | null>;
  updateConnectedServiceAuthGroupActiveProfile(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration: number;
    overrideRuntimeCooldown?: boolean;
  }>): Promise<ConnectedServiceAuthGroupV1>;
  updateConnectedServiceAuthGroupRuntimeState?(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    expectedGeneration: number;
    expectedRuntimeStateRevision: number;
    memberStates: ReadonlyArray<Readonly<{
      profileId: string;
      state: ConnectedServiceAuthGroupMemberStateV1;
    }>>;
  }>): Promise<ConnectedServiceAuthGroupV1>;
  listConnectedServiceProfiles?(input: Readonly<{ serviceId: ConnectedServiceId }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ReadonlyArray<Readonly<{
      profileId: string;
      status: ConnectedServiceCredentialHealthStatusV1;
    }>>;
  }>>;
}>;

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function assertPredictiveSoftSwitchSessionApplyAllowed(input: Readonly<{
  reason: string;
  sessionId?: string;
  applyMode?: 'hot_apply' | 'restart_resume' | 'spawn_next_turn' | null;
}>): void {
  const decision = evaluatePredictiveSoftSwitchSessionApplyPolicy({
    reason: input.reason as Parameters<typeof evaluatePredictiveSoftSwitchSessionApplyPolicy>[0]['reason'],
    sessionId: input.sessionId,
    applyMode: input.applyMode ?? undefined,
  });
  if (decision.status === 'allow') return;
  throw createConnectedServiceAuthGenerationApplyFailureError({
    errorCode: 'hot_apply_restart_required',
    diagnostics: {
      policyReason: decision.reason,
      ...(input.applyMode ? { attemptedMode: input.applyMode } : {}),
    },
  });
}

function assertExactConnectedServiceCredentialRevision(
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null | undefined,
): asserts credentialRevision is ConnectedServiceCredentialRevisionV1 {
  if (credentialRevision != null) return;
  throw createConnectedServiceAuthGenerationApplyFailureError({
    errorCode: 'credential_revision_missing',
  });
}

function mapConnectedServiceAuthGenerationActionToApplyMode(
  action: string | undefined,
): 'hot_apply' | 'restart_resume' | 'spawn_next_turn' | null {
  switch (action) {
    case 'hot_applied':
      return 'hot_apply';
    case 'metadata_updated':
      return 'spawn_next_turn';
    case 'restart_requested':
      return 'restart_resume';
    default:
      return null;
  }
}

function mergeCredentialHealthStatus(input: Readonly<{
  existing?: ConnectedServiceCredentialHealthStatusV1 | null;
  profileListStatus: ConnectedServiceCredentialHealthStatusV1;
}>): ConnectedServiceCredentialHealthStatusV1 {
  void input.existing;
  if (isConnectedServiceCredentialHealthStatusReconnectRequired(input.profileListStatus)) {
    return input.profileListStatus;
  }
  return input.profileListStatus;
}

function resolveRetryAtMs(input: Readonly<{
  retryAtMs?: number | null;
  retryAfterMs?: number | null;
  resetsAtMs?: number | null;
  nowMs: number;
}>): number | null {
  const resetsAtMs = readNonNegativeNumber(input.resetsAtMs);
  if (resetsAtMs !== null) return resetsAtMs;
  const retryAfterMs = readNonNegativeNumber(input.retryAfterMs);
  if (retryAfterMs !== null) return input.nowMs + retryAfterMs;
  return readNonNegativeNumber(input.retryAtMs);
}

function resolveApiAuthGroupGenerationConflict(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  if (error.message !== 'connected_service_auth_group_generation_conflict') return null;
  return readNonNegativeNumber((error as Readonly<{ generation?: unknown }>).generation);
}

// Bounded retry for the idempotent auth-group read that gates every switch. A transient
// local-server blip previously threw at the first step of recovery and was swallowed as
// `recovery_handler_failed` with no follow-up, permanently dropping a correctly-classified
// usage-limit switch (observed across several sessions during a server-timeout window).
const AUTH_GROUP_LOAD_RETRY_ATTEMPTS = 2;
const AUTH_GROUP_LOAD_RETRY_BASE_DELAY_MS = 250;

function defaultSwitchCoordinatorSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConnectedServiceAuthGroupWithRetry(input: Readonly<{
  api: AuthGroupApi;
  serviceId: ConnectedServiceId;
  groupId: string;
  attempts: number;
  baseDelayMs: number;
  sleepMs: (ms: number) => Promise<void>;
}>): Promise<ConnectedServiceAuthGroupV1 | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.api.getConnectedServiceAuthGroup({
        serviceId: input.serviceId,
        groupId: input.groupId,
      });
    } catch (error) {
      // A generation conflict is a real state mismatch the coordinator resolves explicitly, not
      // a transient blip — surface it immediately. Everything else thrown by the idempotent GET
      // (timeout/ECONNABORTED/network/5xx) is treated as transient and retried with backoff.
      if (attempt >= input.attempts || resolveApiAuthGroupGenerationConflict(error) !== null) {
        throw error;
      }
      await input.sleepMs(input.baseDelayMs * (attempt + 1));
    }
  }
}

export function createDaemonConnectedServiceAuthGroupSwitchCoordinator(params: Readonly<{
  api: AuthGroupApi;
  runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
  leases?: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
  quotaFreshnessMs: number;
  nowMs: () => number;
  sleepMs?: (ms: number) => Promise<void>;
  restartSession: (input: Readonly<{
    sessionId?: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    reason?: string;
  }>) => Promise<void>;
  applyConnectedServiceAuthGeneration?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    fromProfileId?: string | null;
  }>) => Promise<Readonly<{
    ok: boolean;
    action?: string;
    errorCode?: string;
    diagnostics?: unknown;
    verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
  }>>;
  preflightConnectedServiceAuthGeneration?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    reason: string;
    switchReason: ConnectedServiceSessionAuthSwitchReason;
    fromProfileId?: string | null;
  }>) => Promise<Readonly<{ ok: boolean; action?: string; errorCode?: string; diagnostics?: unknown }>>;
  switchReasonForApplyGeneration?: ConnectedServiceSessionAuthSwitchReason;
  probeQuotaSnapshotsForGroup?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
    reason: string;
    deadlineAtMs?: number;
  }>) => Promise<ConnectedServiceGroupQuotaProbeResult | void>;
  resolveCredentialRevision?: (
    serviceId: ConnectedServiceId,
    profileId: string | null,
  ) => ConnectedServiceCredentialRevisionV1 | null;
  resolveCurrentCredentialRevision: (
    serviceId: ConnectedServiceId,
    profileId: string | null,
  ) => Promise<ConnectedServiceCredentialRevisionV1 | null>;
  prepareCandidateForSwitch?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    reason: string;
  }>) => Promise<ConnectedServiceAuthGroupCandidatePreparationResult>;
  onCommittedSwitch?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    generation: number;
    expectedGeneration?: number;
  }>) => Promise<void> | void;
  emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
}>): ConnectedServiceAuthGroupSwitchCoordinator {
  return new ConnectedServiceAuthGroupSwitchCoordinator({
    leases: params.leases ?? new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry(),
    nowMs: params.nowMs,
    quotaFreshnessMs: params.quotaFreshnessMs,
    loadState: async (input) => {
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      const group = await loadConnectedServiceAuthGroupWithRetry({
        api: params.api,
        serviceId,
        groupId: input.groupId,
        attempts: AUTH_GROUP_LOAD_RETRY_ATTEMPTS,
        baseDelayMs: AUTH_GROUP_LOAD_RETRY_BASE_DELAY_MS,
        sleepMs: params.sleepMs ?? defaultSwitchCoordinatorSleepMs,
      });
      if (!group) throw new Error(`Connected service auth group not found (${input.serviceId}/${input.groupId})`);
      // CLOSE-11 contract: when the account-usage store exists, only an explicitly SOURCE-BACKED
      // result carries canonical authority; a provisional result (store present but cold) is the
      // persisted-member-state projection and must never masquerade as source-backed evidence.
      // The raw runtimeQuotaSnapshots pre_turn fallback survives ONLY for the legacy store-absent
      // deployment shape.
      const accountUsageSwitchState = params.accountUsageStore
        ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
          group,
          accountUsageStore: params.accountUsageStore,
        })
        : null;
      const unresolvedState = params.accountUsageStore
        ? (accountUsageSwitchState?.kind === 'source_backed'
          ? accountUsageSwitchState.state
          : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group }))
        : input.trigger === 'pre_turn'
          ? buildConnectedServiceAuthGroupSwitchState({
            group,
            runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
            nowMs: params.nowMs(),
          })
          : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group });
      const state: ConnectedServiceAuthGroupSwitchState = {
        ...unresolvedState,
        credentialRevision: params.resolveCredentialRevision?.(
          serviceId,
          unresolvedState.activeProfileId,
        ) ?? null,
      };
      if (typeof params.api.listConnectedServiceProfiles !== 'function') return state;
      const profiles = await params.api.listConnectedServiceProfiles({ serviceId }).catch(() => null);
      if (!profiles) return state;
      const healthByProfileId = new Map(profiles.profiles.map((profile) => [profile.profileId, profile.status]));
      const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
      for (const member of state.members) {
        const healthStatus = healthByProfileId.get(member.profileId);
        if (!healthStatus) continue;
        const existing = memberStatesByProfileId.get(member.profileId) ?? {};
        memberStatesByProfileId.set(member.profileId, {
          ...existing,
          credentialHealthStatus: mergeCredentialHealthStatus({
            existing: existing.credentialHealthStatus,
            profileListStatus: healthStatus,
          }),
        });
      }
      return {
        ...state,
        memberStatesByProfileId,
      };
    },
    commitSwitch: async (input) => {
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      const group = await params.api.updateConnectedServiceAuthGroupActiveProfile({
        serviceId,
        groupId: input.groupId,
        activeProfileId: input.toProfileId,
        expectedGeneration: input.expectedGeneration,
        overrideRuntimeCooldown: true,
      });
      await params.onCommittedSwitch?.({
        serviceId,
        groupId: input.groupId,
        activeProfileId: input.toProfileId,
        generation: group.generation,
        ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
      });
      // CLOSE-11 contract: same rule as the loader above — provisional (cold PAU) results must not
      // masquerade as source-backed; they intentionally degrade to persisted member state.
      const refreshedAccountUsageSwitchState = params.accountUsageStore
        ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
          group,
          accountUsageStore: params.accountUsageStore,
        })
        : null;
      const unresolvedState = refreshedAccountUsageSwitchState?.kind === 'source_backed'
        ? refreshedAccountUsageSwitchState.state
        : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group });
      const credentialRevision = await params.resolveCurrentCredentialRevision(
        serviceId,
        unresolvedState.activeProfileId,
      ).catch(() => null);
      return {
        ...unresolvedState,
        credentialRevision,
      };
    },
    ...(params.prepareCandidateForSwitch ? {
      prepareCandidateForSwitch: async (input) => await params.prepareCandidateForSwitch?.({
        serviceId: ConnectedServiceIdSchema.parse(input.serviceId),
        groupId: input.groupId,
        profileId: input.profileId,
        reason: input.reason,
      }) ?? { status: 'ready' as const },
    } : {}),
    ...(params.probeQuotaSnapshotsForGroup ? {
      probeQuotaSnapshotsForGroup: async (input) => {
        const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
        // The quota coordinator already owns bounded provider fetches, leases, and credential
        // refresh. A shorter outer race detached that still-mutating owner from the selection
        // which depended on it, allowing a stale revision to be committed.
        return await params.probeQuotaSnapshotsForGroup?.({
          serviceId,
          groupId: input.groupId,
          profileIds: input.profileIds,
          reason: input.reason,
          deadlineAtMs: input.deadlineAtMs,
        });
      },
    } : {}),
    resolveGenerationConflict: resolveApiAuthGroupGenerationConflict,
    ...(params.preflightConnectedServiceAuthGeneration ? {
      preflightApplyGeneration: async (input) => {
        if (!input.sessionId) return undefined;
        const applied = await params.preflightConnectedServiceAuthGeneration?.({
          sessionId: input.sessionId,
          serviceId: input.serviceId as ConnectedServiceId,
          groupId: input.groupId,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
          reason: input.reason ?? 'unknown',
          switchReason: params.switchReasonForApplyGeneration ?? 'automatic_runtime_failure',
          fromProfileId: input.fromProfileId ?? null,
        });
        if (applied?.ok) {
          const mode = mapConnectedServiceAuthGenerationActionToApplyMode(applied.action);
          assertPredictiveSoftSwitchSessionApplyAllowed({
            reason: input.reason ?? 'unknown',
            sessionId: input.sessionId,
            applyMode: mode,
          });
          return {
            ...(mode === null ? {} : { mode }),
            ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
          };
        }
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: applied?.errorCode ?? 'unknown',
          ...(applied?.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
        });
      },
    } : {}),
    resolvePostApplyCredentialRevision: async (input) => await params.resolveCurrentCredentialRevision(
      ConnectedServiceIdSchema.parse(input.serviceId),
      input.activeProfileId,
    ).catch(() => null),
    applyGeneration: async (input) => {
      assertExactConnectedServiceCredentialRevision(input.credentialRevision);
      if (input.sessionId && params.applyConnectedServiceAuthGeneration) {
        const applied = await params.applyConnectedServiceAuthGeneration({
          sessionId: input.sessionId,
          serviceId: input.serviceId as ConnectedServiceId,
          groupId: input.groupId,
          activeProfileId: input.activeProfileId,
          generation: input.generation,
          ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
          reason: input.reason ?? 'unknown',
          switchReason: params.switchReasonForApplyGeneration ?? 'automatic_runtime_failure',
          fromProfileId: input.fromProfileId ?? null,
        });
        if (applied.ok) {
          // Map only REAL transitions to an apply mode. An `unchanged` apply performed no restart
          // and no provider application — reporting it as `restart_resume`/`applied` fabricates a
          // transition that never happened (RD-SW-5), so it yields no mode at all.
          const mode = mapConnectedServiceAuthGenerationActionToApplyMode(applied.action);
          assertPredictiveSoftSwitchSessionApplyAllowed({
            reason: input.reason ?? 'unknown',
            sessionId: input.sessionId,
            applyMode: mode,
          });
          // INC-6: forward the FSM-proven continuity diagnostics so the coordinator result (and
          // the reactive switch-attempt telemetry that reads it) is not all-null.
          return {
            ...(mode === null ? {} : { mode }),
            ...(applied.verificationByServiceId
              ? { verificationByServiceId: applied.verificationByServiceId }
              : {}),
            ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
          };
        }
        throw createConnectedServiceAuthGenerationApplyFailureError({
          errorCode: applied.errorCode ?? 'unknown',
          ...(applied.diagnostics === undefined ? {} : { diagnostics: applied.diagnostics }),
        });
      }
      assertPredictiveSoftSwitchSessionApplyAllowed({
        reason: input.reason ?? 'unknown',
        sessionId: input.sessionId,
        applyMode: 'restart_resume',
      });
      await params.restartSession({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        serviceId: input.serviceId as ConnectedServiceId,
        groupId: input.groupId,
        activeProfileId: input.activeProfileId,
        generation: input.generation,
        ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { mode: 'restart_resume' as const };
    },
    recordObservedFailureState: async (input) => {
      if (!params.api.updateConnectedServiceAuthGroupRuntimeState) return;
      const observedProfileId = typeof input.observedProfileId === 'string' && input.observedProfileId.trim().length > 0
        ? input.observedProfileId.trim()
        : input.loaded.activeProfileId;
      if (!observedProfileId) return;
      const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
      let generation = input.loaded.generation;
      let runtimeStateRevision = input.loaded.runtimeStateRevision;
      let existingState = input.loaded.memberStatesByProfileId.get(observedProfileId) ?? null;
      let policy = input.loaded.policy;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await params.api.updateConnectedServiceAuthGroupRuntimeState({
            serviceId,
            groupId: input.groupId,
            expectedGeneration: generation,
            expectedRuntimeStateRevision: runtimeStateRevision,
            memberStates: [{
              profileId: observedProfileId,
              state: buildObservedFailureMemberRuntimeState({
                existing: existingState,
                policy,
                reason: input.reason,
                retryAtMs: resolveRetryAtMs({
                  retryAtMs: input.retryAtMs,
                  retryAfterMs: input.retryAfterMs,
                  resetsAtMs: input.resetsAtMs,
                  nowMs: params.nowMs(),
                }),
                planType: input.planType,
                observedAtMs: params.nowMs(),
              }),
            }],
          });
          return;
        } catch (error) {
          if (!(error instanceof ConnectedServiceAuthGroupRuntimeStateRevisionConflictError) || attempt === 1) throw error;
          const group = await params.api.getConnectedServiceAuthGroup({
            serviceId,
            groupId: input.groupId,
          });
          if (!group || group.generation !== input.loaded.generation) return;
          const member = group.members.find((candidate) => candidate.profileId === observedProfileId);
          if (!member) return;
          generation = group.generation;
          runtimeStateRevision = group.runtimeStateRevision;
          existingState = member.state;
          policy = buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group }).policy;
        }
      }
    },
    ...(params.emitEvent ? { emitEvent: params.emitEvent } : {}),
  });
}
