import {
    ConnectedServiceIdSchema,
    type ConnectedServiceAuthGroupMemberStateV1,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceCredentialHealthStatusV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
    ConnectedServiceAuthGroupSwitchCoordinator,
    InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
    type ConnectedServiceAuthGroupGenerationApplyResult,
    type ConnectedServiceAuthGroupSwitchEvent,
} from '../accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceAuthGroupQuotaProbeResult } from '../accountGroups/quotas/preTurnQuotaProbe';
import {
    buildConnectedServiceAuthGroupSwitchState,
    buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
    buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
    type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import { updateConnectedServiceAuthGroupRuntimeStateWithRetry } from '../accountGroups/runtimeState/updateConnectedServiceAuthGroupRuntimeStateWithRetry';
import {
    buildConnectedServiceAuthGroupObservedFailureMemberState,
    resolveConnectedServiceAuthGroupFailureRetryAtMs,
} from '../accountGroups/runtimeState/buildConnectedServiceAuthGroupObservedFailureMemberState';
import type { ConnectedServiceAuthGroupCandidatePreparationResult } from '../refresh/ConnectedServiceRefreshCoordinator';

type AuthGroupApi = Readonly<{
    getConnectedServiceAuthGroup(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
    }>): Promise<ConnectedServiceAuthGroupV1 | null>;
    updateConnectedServiceAuthGroupActiveProfile(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string;
        expectedGeneration?: number;
        overrideRuntimeCooldown?: boolean;
    }>): Promise<ConnectedServiceAuthGroupV1>;
    updateConnectedServiceAuthGroupRuntimeState?(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        expectedGeneration?: number;
        expectedRuntimeStateRevision?: number;
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

type ConnectedServiceAccountSwitchMode = 'hot_apply' | 'restart_resume' | 'spawn_next_turn';

type ConnectedServiceAuthGroupGenerationApplyInput = Readonly<{
    sessionId?: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    reason?: string;
}>;

function mapAuthSwitchResultToMode(result: Readonly<Record<string, unknown>>): ConnectedServiceAccountSwitchMode {
    const mode = result.mode;
    if (mode === 'hot_apply' || mode === 'restart_resume' || mode === 'spawn_next_turn') return mode;
    switch (result.action) {
        case 'hot_applied':
            return 'hot_apply';
        case 'metadata_updated':
            return 'spawn_next_turn';
        default:
            return 'restart_resume';
    }
}

function readNonNegativeNumber(value: unknown): number | null {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < 0
    ) {
        return null;
    }
    return Math.trunc(value);
}

function resolveApiAuthGroupGenerationConflict(error: unknown): number | null {
    if (!(error instanceof Error)) return null;
    if (error.message !== 'connected_service_auth_group_generation_conflict') return null;
    return readNonNegativeNumber((error as Readonly<{ generation?: unknown }>).generation);
}

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
            if (attempt >= input.attempts || resolveApiAuthGroupGenerationConflict(error) !== null) {
                throw error;
            }
            await input.sleepMs(input.baseDelayMs * (attempt + 1));
        }
    }
}

function normalizeGroupLabel(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

function authGroupLabelKey(input: Readonly<{ serviceId: string; groupId: string }>): string {
    return `${input.serviceId}\0${input.groupId}`;
}

export function createDaemonConnectedServiceAuthGroupSwitchCoordinator(params: Readonly<{
    api: AuthGroupApi;
    runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
    leases?: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
    quotaFreshnessMs: number;
    nowMs: () => number;
    sleepMs?: (ms: number) => Promise<void>;
    resolveCredentialRevision?: (
        serviceId: ConnectedServiceId,
        profileId: string,
    ) => ConnectedServiceCredentialRevisionV1 | null;
    restartSession: (input: ConnectedServiceAuthGroupGenerationApplyInput) => Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
    preflightConnectedServiceAuthGeneration?: (
        input: ConnectedServiceAuthGroupGenerationApplyInput,
    ) => Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
    probeQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
    }>) => Promise<ConnectedServiceAuthGroupQuotaProbeResult | void>;
    prepareCandidateForSwitch?: (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        reason: string;
    }>) => Promise<ConnectedServiceAuthGroupCandidatePreparationResult>;
    emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
}>): ConnectedServiceAuthGroupSwitchCoordinator {
    const buildSwitchState = (group: ConnectedServiceAuthGroupV1) => {
        const withCredentialRevision = <T extends Readonly<{
            activeProfileId: string | null;
        }>>(state: T): T & Readonly<{ credentialRevision: ConnectedServiceCredentialRevisionV1 | null }> => ({
            ...state,
            credentialRevision: state.activeProfileId
                ? params.resolveCredentialRevision?.(group.serviceId, state.activeProfileId) ?? null
                : null,
        });
        if (params.accountUsageStore) {
            return withCredentialRevision(buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
                group,
                accountUsageStore: params.accountUsageStore,
            })?.state ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group }));
        }
        return withCredentialRevision(buildConnectedServiceAuthGroupSwitchState({
            group,
            runtimeQuotaSnapshots: params.runtimeQuotaSnapshots,
            nowMs: params.nowMs(),
        }));
    };
    const groupLabelByKey = new Map<string, string>();
    const rememberGroupLabel = (group: ConnectedServiceAuthGroupV1) => {
        groupLabelByKey.set(authGroupLabelKey(group), normalizeGroupLabel(group.displayName) ?? group.groupId);
    };
    const emitEvent = params.emitEvent
        ? (event: ConnectedServiceAuthGroupSwitchEvent) => {
            const groupLabel = groupLabelByKey.get(authGroupLabelKey(event))
                ?? normalizeGroupLabel(event.groupLabel)
                ?? event.groupId;
            params.emitEvent?.({ ...event, groupLabel });
        }
        : undefined;

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
            rememberGroupLabel(group);
            const state = buildSwitchState(group);
            if (typeof params.api.listConnectedServiceProfiles !== 'function') return state;
            const profiles = await params.api.listConnectedServiceProfiles({ serviceId }).catch(() => null);
            if (!profiles) return state;
            const healthByProfileId = new Map(profiles.profiles.map((profile) => [profile.profileId, profile.status]));
            const memberStatesByProfileId = new Map(state.memberStatesByProfileId);
            for (const member of state.members) {
                const healthStatus = healthByProfileId.get(member.profileId);
                if (!healthStatus) continue;
                memberStatesByProfileId.set(member.profileId, {
                    ...(memberStatesByProfileId.get(member.profileId) ?? {}),
                    credentialHealthStatus: healthStatus,
                });
            }
            return { ...state, memberStatesByProfileId };
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
            rememberGroupLabel(group);
            return buildSwitchState(group);
        },
        ...(params.prepareCandidateForSwitch
            ? {
                prepareCandidateForSwitch: async (input) => (
                    await params.prepareCandidateForSwitch?.({
                        serviceId: ConnectedServiceIdSchema.parse(
                            input.serviceId,
                        ),
                        groupId: input.groupId,
                        profileId: input.profileId,
                        reason: input.reason,
                    }) ?? { status: 'ready' as const }
                ),
            }
            : {}),
        ...(params.preflightConnectedServiceAuthGeneration ? {
            preflightApplyGeneration: async (input) => {
                const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
                const result = await params.preflightConnectedServiceAuthGeneration?.({
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    serviceId,
                    groupId: input.groupId,
                    activeProfileId: input.activeProfileId,
                    generation: input.generation,
                    ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
                    ...(input.reason ? { reason: input.reason } : {}),
                });
                return result?.ok
                    ? { ok: true, mode: mapAuthSwitchResultToMode(result) }
                    : result ?? {
                        ok: false,
                        errorCode: 'generation_apply_not_confirmed',
                        serviceId,
                    };
            },
        } : {}),
        applyGeneration: async (input) => {
            const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
            const result = await params.restartSession({
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                serviceId,
                groupId: input.groupId,
                activeProfileId: input.activeProfileId,
                generation: input.generation,
                ...(input.credentialRevision === undefined ? {} : { credentialRevision: input.credentialRevision }),
                ...(input.reason ? { reason: input.reason } : {}),
            });
            return result.ok
                ? {
                    ok: true,
                    mode: mapAuthSwitchResultToMode(result),
                    ...('providerApplication' in result && typeof result.providerApplication === 'string'
                        ? { providerApplication: result.providerApplication }
                        : {}),
                    ...('verificationByServiceId' in result && result.verificationByServiceId
                        ? { verificationByServiceId: result.verificationByServiceId }
                        : {}),
                }
                : result;
        },
        recordObservedFailureState: async (input) => {
            if (!params.api.updateConnectedServiceAuthGroupRuntimeState) return;
            const observedProfileId = typeof input.observedProfileId === 'string' && input.observedProfileId.trim()
                ? input.observedProfileId.trim()
                : input.loaded.activeProfileId;
            if (!observedProfileId) return;
            const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
            await updateConnectedServiceAuthGroupRuntimeStateWithRetry({
                serviceId,
                groupId: input.groupId,
                expectedGeneration: input.loaded.generation,
                loadGroup: async () => await params.api.getConnectedServiceAuthGroup({
                    serviceId,
                    groupId: input.groupId,
                }),
                buildPatch: (group) => {
                    const member = group.members.find((candidate) => candidate.profileId === observedProfileId);
                    if (!member) return null;
                    return {
                        memberStates: [{
                            profileId: observedProfileId,
                            state: buildConnectedServiceAuthGroupObservedFailureMemberState({
                                existing: member.state,
                                reason: input.reason,
                                retryAtMs: resolveConnectedServiceAuthGroupFailureRetryAtMs({
                                    retryAtMs: input.retryAtMs,
                                    retryAfterMs: input.retryAfterMs,
                                    resetsAtMs: input.resetsAtMs,
                                    nowMs: params.nowMs(),
                                }),
                                cooldownMs: input.loaded.policy.cooldownMs,
                                planType: input.planType,
                                observedAtMs: params.nowMs(),
                            }),
                        }],
                    };
                },
                update: params.api.updateConnectedServiceAuthGroupRuntimeState,
            });
        },
        resolveGenerationConflict: resolveApiAuthGroupGenerationConflict,
        ...(params.probeQuotaSnapshotsForGroup ? {
            probeQuotaSnapshotsForGroup: async (input) => {
                const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
                // The quota coordinator already owns bounded provider fetches, leases, and
                // credential refresh. Returning from a shorter outer race detached a still-
                // mutating probe from the selection which depended on it.
                return await params.probeQuotaSnapshotsForGroup?.({
                    serviceId,
                    groupId: input.groupId,
                    profileIds: input.profileIds,
                    reason: input.reason,
                });
            },
        } : {}),
        ...(emitEvent ? { emitEvent } : {}),
    });
}
