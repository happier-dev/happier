import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    type ConnectedServiceAuthGroupMemberRuntimeState,
    type ConnectedServiceAuthGroupPolicyV1,
} from '../selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupSwitchState } from './ConnectedServiceAuthGroupSwitchCoordinator';

export function normalizeConnectedServiceAuthGroupPolicy(
    value: ConnectedServiceAuthGroupV1['policy'],
): ConnectedServiceAuthGroupPolicyV1 {
    return {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        ...value,
        switchOn: {
            ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.switchOn,
            ...value.switchOn,
        },
    };
}

function readNumberState(value: unknown): number | null | undefined {
    if (value === null || value === undefined) return value;
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readStringState(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return value;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function mergePersistedMemberRuntimeState(
    runtimeState: ConnectedServiceAuthGroupMemberRuntimeState | null,
    persistedState: ConnectedServiceAuthGroupV1['members'][number]['state'],
): ConnectedServiceAuthGroupMemberRuntimeState {
    const persisted = memberStateFromApiState(persistedState);
    return {
        ...persisted,
        ...(runtimeState ?? {}),
    };
}

function memberStateFromApiState(
    state: ConnectedServiceAuthGroupV1['members'][number]['state'],
): ConnectedServiceAuthGroupMemberRuntimeState {
    return {
        ...(readNumberState(state.cooldownStartedAtMs) === undefined ? {} : { cooldownStartedAtMs: readNumberState(state.cooldownStartedAtMs) }),
        ...(readNumberState(state.cooldownUntilMs) === undefined ? {} : { cooldownUntilMs: readNumberState(state.cooldownUntilMs) }),
        ...(readNumberState(state.exhaustedUntilMs) === undefined ? {} : { exhaustedUntilMs: readNumberState(state.exhaustedUntilMs) }),
        ...(readNumberState(state.quotaExhaustedUntilMs) === undefined ? {} : { quotaExhaustedUntilMs: readNumberState(state.quotaExhaustedUntilMs) }),
        ...(readNumberState(state.rateLimitedUntilMs) === undefined ? {} : { rateLimitedUntilMs: readNumberState(state.rateLimitedUntilMs) }),
        ...(readNumberState(state.capacityLimitedUntilMs) === undefined ? {} : { capacityLimitedUntilMs: readNumberState(state.capacityLimitedUntilMs) }),
        ...(readNumberState(state.authInvalidUntilMs) === undefined ? {} : { authInvalidUntilMs: readNumberState(state.authInvalidUntilMs) }),
        ...(readNumberState(state.planUnavailableUntilMs) === undefined ? {} : { planUnavailableUntilMs: readNumberState(state.planUnavailableUntilMs) }),
        ...(readNumberState(state.validationBlockedUntilMs) === undefined ? {} : { validationBlockedUntilMs: readNumberState(state.validationBlockedUntilMs) }),
        ...(readNumberState(state.providerResetsAtMs) === undefined ? {} : { providerResetsAtMs: readNumberState(state.providerResetsAtMs) }),
        ...(readStringState(state.lastFailureKind) === undefined ? {} : { lastFailureKind: readStringState(state.lastFailureKind) }),
        ...(readNumberState(state.lastObservedAtMs) === undefined ? {} : { lastObservedAtMs: readNumberState(state.lastObservedAtMs) }),
    };
}

export function buildConnectedServiceAuthGroupSwitchState(input: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    nowMs: number;
}>): ConnectedServiceAuthGroupSwitchState {
    return buildConnectedServiceAuthGroupSwitchStateFromMemberRuntimeStates({
        group: input.group,
        runtimeMemberStates: new Map(input.runtimeQuotaSnapshots.buildMemberStates({
            serviceId: input.group.serviceId,
            groupId: input.group.groupId,
            capturedAtMs: input.nowMs,
        })),
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
        generation: input.group.generation,
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
