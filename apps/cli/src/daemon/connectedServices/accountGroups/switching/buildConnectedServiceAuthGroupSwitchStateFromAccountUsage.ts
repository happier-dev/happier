import type {
    ConnectedAccountServiceKey,
    ConnectedServiceAuthGroupMemberStateV1,
    ConnectedServiceAuthGroupPolicyV1,
    ConnectedServiceUsageSourceV1,
    ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { ProviderAccountUsageStore } from '../../accountUsage/store';
import { projectProviderAccountUsageSnapshotToAuthGroupRuntimeState } from '../quotas/projection';
import type { ConnectedServiceAuthGroupMemberRuntimeState } from '../selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupSwitchState } from './ConnectedServiceAuthGroupSwitchCoordinator';
import {
    mergePersistedMemberRuntimeState,
    normalizeConnectedServiceAuthGroupPolicy,
} from './buildConnectedServiceAuthGroupSwitchState';

export type ConnectedServiceUsageSourceRecordRef = Readonly<{
    source: ConnectedServiceUsageSourceV1;
    recordId: string;
    fetchedAtMs: number;
    observedAtMs: number;
    state: ProviderAccountUsageSnapshotV1['state'];
}>;

export type AccountUsageStoreForAuthGroupSwitchState = Pick<
    ProviderAccountUsageStore,
    'resolveBySource'
>;

/**
 * The account-usage projection needs only this group state, regardless of
 * whether canonical persistence is the historical service-keyed shape or a
 * qualified Connected Account group. `serviceId` stays the canonical
 * `ConnectedAccountServiceKey` ingress identity end to end; consumers that
 * need the legacy scalar id reverse-project at their own legacy seam. This
 * view never selects or mutates a group.
 */
export type ConnectedServiceAuthGroupAccountUsageView = Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    activeProfileId: string | null;
    generation: number;
    policy: ConnectedServiceAuthGroupPolicyV1;
    members: readonly Readonly<{
        profileId: string;
        priority: number;
        enabled: boolean;
        state: ConnectedServiceAuthGroupMemberStateV1;
        createdAt: number;
    }>[];
}>;

function buildGroupMemberSource(input: Readonly<{
    group: ConnectedServiceAuthGroupAccountUsageView;
    profileId: string;
}>): ConnectedServiceUsageSourceV1 {
    return {
        serviceId: input.group.serviceId,
        profileId: input.profileId,
        bindingKind: 'group_member',
        groupId: input.group.groupId,
        groupGeneration: input.group.generation,
    };
}

export function resolveAccountUsageSnapshotsByGroupProfile(input: Readonly<{
    group: ConnectedServiceAuthGroupAccountUsageView;
    accountUsageStore: AccountUsageStoreForAuthGroupSwitchState;
    changedProfileId?: string | null;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    changedGroupGeneration?: number | null;
}>): Map<string, ProviderAccountUsageSnapshotV1> {
    const snapshotsByProfileId = new Map<string, ProviderAccountUsageSnapshotV1>();
    const changedProfileId = input.changedProfileId?.trim() || null;
    for (const member of input.group.members) {
        const profileId = member.profileId.trim();
        if (!profileId) continue;
        const resolved = input.accountUsageStore.resolveBySource(buildGroupMemberSource({
            group: input.group,
            profileId,
        }));
        if (resolved) {
            snapshotsByProfileId.set(profileId, resolved);
            continue;
        }
        if (
            profileId === changedProfileId
            && input.changedSnapshot
            && (
                input.changedGroupGeneration === undefined
                || input.changedGroupGeneration === input.group.generation
            )
        ) {
            snapshotsByProfileId.set(profileId, input.changedSnapshot);
        }
    }
    return snapshotsByProfileId;
}

export function buildConnectedServiceAuthGroupSwitchStateFromAccountUsage(input: Readonly<{
    group: ConnectedServiceAuthGroupAccountUsageView;
    accountUsageStore: AccountUsageStoreForAuthGroupSwitchState;
    changedProfileId?: string | null;
    changedSnapshot?: ProviderAccountUsageSnapshotV1 | null;
    changedGroupGeneration?: number | null;
}>): Readonly<{
    state: ConnectedServiceAuthGroupSwitchState;
    sourceRefsByProfileId: ReadonlyMap<string, ConnectedServiceUsageSourceRecordRef>;
}> | null {
    const snapshotsByProfileId = resolveAccountUsageSnapshotsByGroupProfile(input);
    if (snapshotsByProfileId.size === 0) return null;

    const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();
    const sourceRefsByProfileId = new Map<string, ConnectedServiceUsageSourceRecordRef>();
    for (const member of input.group.members) {
        const profileId = member.profileId.trim();
        if (!profileId) continue;
        const snapshot = snapshotsByProfileId.get(profileId) ?? null;
        const projectedState = snapshot
            ? projectProviderAccountUsageSnapshotToAuthGroupRuntimeState(snapshot)
            : null;
        memberStatesByProfileId.set(
            profileId,
            mergePersistedMemberRuntimeState(projectedState, member.state),
        );
        if (!snapshot) continue;
        sourceRefsByProfileId.set(profileId, {
            source: buildGroupMemberSource({ group: input.group, profileId }),
            recordId: snapshot.recordId,
            fetchedAtMs: snapshot.fetchedAtMs,
            observedAtMs: snapshot.observedAtMs,
            state: snapshot.state,
        });
    }

    return {
        state: {
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
        },
        sourceRefsByProfileId,
    };
}
