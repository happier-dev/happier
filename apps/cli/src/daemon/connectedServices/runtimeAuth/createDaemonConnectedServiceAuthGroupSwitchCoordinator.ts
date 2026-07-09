import {
    ConnectedServiceIdSchema,
    type ConnectedServiceAuthGroupMemberStateV1,
    type ConnectedServiceAuthGroupV1,
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
import {
    buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
    buildConnectedServiceAuthGroupSwitchStateFromAccountUsage,
    type AccountUsageStoreForAuthGroupSwitchState,
} from '../accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';

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
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function resolveUsageLimitRetryAtMs(input: Readonly<{
    retryAtMs: number | null;
    cooldownMs: number;
    observedAtMs: number;
}>): number | null {
    if (input.retryAtMs !== null) return input.retryAtMs;
    const cooldownMs = readNonNegativeNumber(input.cooldownMs);
    return cooldownMs === null ? null : input.observedAtMs + cooldownMs;
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

function buildObservedFailureMemberState(input: Readonly<{
    existing: ConnectedServiceAuthGroupMemberStateV1;
    reason: string;
    retryAtMs: number | null;
    cooldownMs: number;
    planType: string | null | undefined;
    observedAtMs: number;
}>): ConnectedServiceAuthGroupMemberStateV1 {
    const state: ConnectedServiceAuthGroupMemberStateV1 = {
        ...input.existing,
        lastFailureKind: input.reason,
        lastObservedAtMs: input.observedAtMs,
        ...(input.planType ? { lastObservedPlanType: input.planType } : {}),
    };
    switch (input.reason) {
        case 'usage_limit':
            return { ...state, quotaExhaustedUntilMs: resolveUsageLimitRetryAtMs(input) };
        case 'rate_limit':
            return { ...state, rateLimitedUntilMs: resolveUsageLimitRetryAtMs(input) };
        case 'capacity':
            return { ...state, capacityLimitedUntilMs: resolveUsageLimitRetryAtMs(input) };
        case 'auth_expired':
        case 'refresh_failed':
        case 'account_disabled':
            return { ...state, authInvalidUntilMs: input.retryAtMs };
        case 'plan':
            return { ...state, planUnavailableUntilMs: input.retryAtMs };
        case 'validation':
            return { ...state, validationBlockedUntilMs: input.retryAtMs };
        default:
            return state;
    }
}

function resolveApiAuthGroupGenerationConflict(error: unknown): number | null {
    if (!(error instanceof Error)) return null;
    if (error.message !== 'connected_service_auth_group_generation_conflict') return null;
    return readNonNegativeNumber((error as Readonly<{ generation?: unknown }>).generation);
}

const AUTH_GROUP_LOAD_RETRY_ATTEMPTS = 2;
const AUTH_GROUP_LOAD_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS = 8_000;

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

function resolveGroupQuotaProbeTimeoutMs(value: number | null | undefined): number | null {
    if (value === null) return null;
    if (value === undefined) return DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS;
    if (!Number.isFinite(value)) return DEFAULT_GROUP_QUOTA_PROBE_TIMEOUT_MS;
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function normalizeGroupLabel(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

function authGroupLabelKey(input: Readonly<{ serviceId: string; groupId: string }>): string {
    return `${input.serviceId}\0${input.groupId}`;
}

async function runQuotaSnapshotProbeWithTimeout(input: Readonly<{
    timeoutMs: number | null;
    probe: () => Promise<void>;
}>): Promise<void> {
    if (input.timeoutMs === null) {
        await input.probe();
        return;
    }

    const timeoutMs = input.timeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const probePromise = input.probe().then(
        () => ({ status: 'completed' as const }),
        (error) => ({ status: 'failed' as const, error }),
    );
    const timeoutPromise = new Promise<Readonly<{ status: 'timed_out' }>>((resolve) => {
        timeoutHandle = setTimeout(() => {
            resolve({ status: 'timed_out' });
        }, timeoutMs);
        (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
    });

    const result = await Promise.race([probePromise, timeoutPromise]);
    if (timeoutHandle) {
        clearTimeout(timeoutHandle);
    }
    timeoutHandle = null;
    if (result.status === 'timed_out') return;
    if (result.status === 'failed') throw result.error;
}

export function createDaemonConnectedServiceAuthGroupSwitchCoordinator(params: Readonly<{
    api: AuthGroupApi;
    runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    accountUsageStore?: AccountUsageStoreForAuthGroupSwitchState | null;
    leases?: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry;
    quotaFreshnessMs: number;
    nowMs: () => number;
    sleepMs?: (ms: number) => Promise<void>;
    restartSession: (input: ConnectedServiceAuthGroupGenerationApplyInput) => Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
    preflightConnectedServiceAuthGeneration?: (
        input: ConnectedServiceAuthGroupGenerationApplyInput,
    ) => Promise<ConnectedServiceAuthGroupGenerationApplyResult>;
    hydratePersistedQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
    }>) => Promise<void>;
    probeQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
    }>) => Promise<void>;
    quotaProbeTimeoutMs?: number | null;
    emitEvent?: (event: ConnectedServiceAuthGroupSwitchEvent) => void;
}>): ConnectedServiceAuthGroupSwitchCoordinator {
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
            const state = params.accountUsageStore
                ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
                    group,
                    accountUsageStore: params.accountUsageStore,
                })?.state ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group })
                : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group });
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
            return params.accountUsageStore
                ? buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
                    group,
                    accountUsageStore: params.accountUsageStore,
                })?.state ?? buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group })
                : buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({ group });
        },
        ...(params.preflightConnectedServiceAuthGeneration ? {
            preflightApplyGeneration: async (input) => {
                const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
                const result = await params.preflightConnectedServiceAuthGeneration?.({
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    serviceId,
                    groupId: input.groupId,
                    activeProfileId: input.activeProfileId,
                    generation: input.generation,
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
                ...(input.reason ? { reason: input.reason } : {}),
            });
            return result.ok
                ? { ok: true, mode: mapAuthSwitchResultToMode(result) }
                : result;
        },
        recordObservedFailureState: async (input) => {
            if (!params.api.updateConnectedServiceAuthGroupRuntimeState) return;
            const observedProfileId = typeof input.observedProfileId === 'string' && input.observedProfileId.trim()
                ? input.observedProfileId.trim()
                : input.loaded.activeProfileId;
            if (!observedProfileId) return;
            const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
            await params.api.updateConnectedServiceAuthGroupRuntimeState({
                serviceId,
                groupId: input.groupId,
                expectedGeneration: input.loaded.generation,
                memberStates: [{
                    profileId: observedProfileId,
                    state: buildObservedFailureMemberState({
                        existing: input.loaded.memberStatesByProfileId.get(observedProfileId) ?? {},
                        reason: input.reason,
                        retryAtMs: resolveRetryAtMs({
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
            });
        },
        resolveGenerationConflict: resolveApiAuthGroupGenerationConflict,
        ...(params.probeQuotaSnapshotsForGroup ? {
            probeQuotaSnapshotsForGroup: async (input) => {
                const serviceId = ConnectedServiceIdSchema.parse(input.serviceId);
                await runQuotaSnapshotProbeWithTimeout({
                    timeoutMs: resolveGroupQuotaProbeTimeoutMs(params.quotaProbeTimeoutMs),
                    probe: async () => {
                        await params.probeQuotaSnapshotsForGroup?.({
                            serviceId,
                            groupId: input.groupId,
                            profileIds: input.profileIds,
                            reason: input.reason,
                        });
                    },
                });
            },
        } : {}),
        ...(emitEvent ? { emitEvent } : {}),
    });
}
