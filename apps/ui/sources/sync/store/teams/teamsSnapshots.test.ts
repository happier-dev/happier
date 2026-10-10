import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    NO_TEAM_CAPABILITIES_V1,
    NO_TEAM_GROUP_CAPABILITIES_V1,
    teamDirectoryQueryKeyV1,
    teamGroupsQueryKeyV1,
    TeamCredentialResourceSummaryV1Schema,
    type TeamCredentialResourceCatalogEntryV1,
    type TeamGroupV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';

import {
    applyTeamFailure,
    applyTeamGroupFailure,
    applyTeamGroupProjection,
    applyTeamGroupsFailure,
    applyTeamGroupsPage,
    applyTeamProjection,
    applyTeamCredentialResourceCatalog,
    applyTeamCredentialResource,
    applyTeamCredentialResourcesPage,
    applyTeamsDirectoryFailure,
    applyTeamsDirectoryPage,
    beginTeamsDirectoryLoad,
    clearTeamsSnapshotsForServer,
    getTeamSnapshot,
    getTeamCredentialResourceCatalogSnapshot,
    getTeamCredentialResourceSnapshot,
    getTeamCredentialResourcesSnapshot,
    getTeamGroupSnapshot,
    getTeamGroupsSnapshot,
    getTeamsDirectorySnapshot,
    invalidateTeamGroupsForTeam,
    invalidateTeamCredentialResources,
    invalidateTeamsSnapshotsForServer,
    readTeamGroup,
    readTeamGroups,
    resetTeamsSnapshotsForTests,
    subscribeTeamsSnapshots,
} from './teamsSnapshots';

const scopeA = createServerAccountScope('home_a', 'acc_1')!;
const scopeAOther = createServerAccountScope('home_a', 'acc_2')!;
const scopeB = createServerAccountScope('home_b', 'acc_1')!;

const queryKey = teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' });

// Two Homes that legitimately hold the same Team ID, which is the collision the
// Group readers have to keep apart.
const groupAddressA = createTeamAddress('home_a', 'team_1')!;
const groupAddressB = createTeamAddress('home_b', 'team_1')!;

function groupsQueryKey(teamId: string, archived: 'active' | 'archived'): string {
    return teamGroupsQueryKeyV1({ v: 1, teamId, archived });
}

function groupRow(id: string, overrides: Partial<TeamGroupV1> = {}): TeamGroupV1 {
    return {
        v: 1,
        id,
        teamId: 'team_1',
        name: `Group ${id}`,
        description: null,
        archivedAt: null,
        memberCount: 0,
        management: { kind: 'native' },
        capabilities: NO_TEAM_GROUP_CAPABILITIES_V1,
        ...overrides,
    };
}

function team(id: string, overrides: Partial<TeamSummaryV1> = {}): TeamSummaryV1 {
    return {
        id,
        name: `Team ${id}`,
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'team_admins_only',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: {
            historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' },
        },
        counts: null,
        ...overrides,
    };
}

afterEach(() => {
    resetTeamsSnapshotsForTests();
});

describe('teamsSnapshots', () => {
    it('retains the recipient-safe credential catalog beside administration rows', () => {
        const catalogEntry: TeamCredentialResourceCatalogEntryV1 = {
            id: 'shared-1',
            teamId: 'team_1',
            displayName: 'Shared model',
            resourceRevision: 3,
            readiness: { kind: 'available' },
            recoveryAction: null,
            mayBroker: true,
            mayReceiveDirect: false,
            directMaterialState: 'never_delivered',
            sessionUsePolicy: 'personal_allowed',
            providerModels: [],
            connectedServiceSelections: [],
            sourcePresentation: {
                kind: 'connected_service',
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            },
        };
        const resource = TeamCredentialResourceSummaryV1Schema.parse({
            id: 'resource-1', teamId: 'team_1', custodianAccountId: 'owner',
            displayName: 'Managed credential', enabled: true, revision: 1,
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
            source: {
                v: 1, kind: 'provider_connection', connectionId: 'connection-1',
                connectionSecurityFingerprint: 'connection-security:v1:test', credentialSlotId: 'api-key',
            },
            sourcePresentation: {
                kind: 'provider',
                provider: {
                    identity: { pluginId: 'happier.provider.test', localId: 'provider' },
                    definitionRevision: 1,
                },
            },
            requestPolicy: null, brokerPlacement: null, allMembersDeliveryMode: null,
            groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
            brokerPresentation: {
                selectedTarget: null,
                eligibleTargets: [],
                selectedPool: null,
                eligiblePools: [],
            },
            createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        });

        applyTeamCredentialResourcesPage({
            scope: scopeA,
            address: groupAddressA,
            resources: [resource],
            viewer: { manageCredentials: true, offerOwnCredential: true },
            observedAt: 80,
        });
        applyTeamCredentialResourceCatalog({
            scope: scopeA,
            address: groupAddressA,
            resources: [catalogEntry],
            observedAt: 80,
        });
        applyTeamCredentialResource({
            scope: scopeA,
            address: groupAddressA,
            resource,
            observedAt: 80,
        });

        const snapshot = getTeamCredentialResourcesSnapshot(scopeA, groupAddressA);
        const listData = snapshot?.data;
        const catalogSnapshot = getTeamCredentialResourceCatalogSnapshot(scopeA, groupAddressA);
        expect(snapshot?.data).toEqual([resource]);
        expect(catalogSnapshot?.data).toEqual([catalogEntry]);

        invalidateTeamCredentialResources(scopeA, groupAddressA, resource.id);
        expect(getTeamCredentialResourcesSnapshot(scopeA, groupAddressA)?.data).toBe(listData);
        expect(getTeamCredentialResourcesSnapshot(scopeA, groupAddressA)?.stale).toBe(true);
        expect(getTeamCredentialResourceSnapshot(scopeA, groupAddressA, resource.id)).toMatchObject({
            data: resource,
            stale: true,
        });
    });

    it('publishes a directory page under one exact server-Account scope', () => {
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1')],
            nextCursor: null,
            observedAt: 10,
        });

        expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.data).toEqual([team('t1')]);
        // A second Account on the same Home sees different Teams and roles.
        expect(getTeamsDirectorySnapshot(scopeAOther, queryKey)).toBeNull();
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBeNull();
    });

    it('keeps identical Team IDs on two Homes as separate detail rows', () => {
        const addressA = createTeamAddress('home_a', 'shared_id')!;
        const addressB = createTeamAddress('home_b', 'shared_id')!;

        applyTeamProjection({ scope: scopeA, address: addressA, team: team('shared_id', { name: 'A team' }), observedAt: 1 });
        applyTeamProjection({ scope: scopeB, address: addressB, team: team('shared_id', { name: 'B team' }), observedAt: 2 });

        expect(getTeamSnapshot(scopeA, addressA)?.data?.name).toBe('A team');
        expect(getTeamSnapshot(scopeB, addressB)?.data?.name).toBe('B team');
    });

    it('reuses the object of a Team whose content did not change across a refresh', () => {
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1'), team('t2')],
            nextCursor: null,
            observedAt: 10,
        });
        const first = getTeamsDirectorySnapshot(scopeA, queryKey)?.data ?? [];

        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1'), team('t2', { name: 'Renamed' })],
            nextCursor: null,
            observedAt: 11,
        });
        const second = getTeamsDirectorySnapshot(scopeA, queryKey)?.data ?? [];

        // The untouched Team keeps its identity so its row does not rerender.
        expect(second[0]).toBe(first[0]);
        expect(second[1]).not.toBe(first[1]);
        expect(second[1]?.name).toBe('Renamed');
    });

    it('appends a page while preserving the identity of already rendered Teams', () => {
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1')],
            nextCursor: 'cursor-1',
            observedAt: 10,
        });
        const firstPage = getTeamsDirectorySnapshot(scopeA, queryKey)?.data ?? [];

        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t2')],
            nextCursor: null,
            observedAt: 11,
            append: true,
        });

        const snapshot = getTeamsDirectorySnapshot(scopeA, queryKey);
        expect(snapshot?.data?.map((entry) => entry.id)).toEqual(['t1', 't2']);
        expect(snapshot?.data?.[0]).toBe(firstPage[0]);
        expect(snapshot?.nextCursor).toBeNull();
    });

    it('keeps the last directory visible and stale when a refresh fails', () => {
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1')],
            nextCursor: null,
            observedAt: 20,
        });

        applyTeamsDirectoryFailure({
            scope: scopeA,
            queryKey,
            error: { kind: 'unreachable', retryable: true },
        });

        const snapshot = getTeamsDirectorySnapshot(scopeA, queryKey);
        expect(snapshot?.status).toBe('error');
        // Never flash an empty Teams list over data the user was reading.
        expect(snapshot?.data).toEqual([team('t1')]);
        expect(snapshot?.stale).toBe(true);
        expect(snapshot?.reachability).toBe('unreachable');
    });

    it('withdraws retained Team authority after an authoritative refusal', () => {
        const address = createTeamAddress('home_a', 'team_1')!;
        const groupQueryKey = groupsQueryKey('team_1', 'active');
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('team_1')],
            nextCursor: 'more',
            observedAt: 20,
        });
        applyTeamProjection({ scope: scopeA, address, team: team('team_1'), observedAt: 21 });
        applyTeamGroupsPage({
            scope: scopeA,
            address,
            queryKey: groupQueryKey,
            items: [groupRow('group_1')],
            nextCursor: 'more',
            observedAt: 22,
        });
        applyTeamGroupProjection({
            scope: scopeA,
            address,
            group: groupRow('group_1'),
            observedAt: 23,
        });

        const refusal = { kind: 'forbidden' as const, retryable: false };
        applyTeamsDirectoryFailure({ scope: scopeA, queryKey, error: refusal });
        applyTeamFailure({ scope: scopeA, address, error: refusal });
        applyTeamGroupsFailure({ scope: scopeA, address, queryKey: groupQueryKey, error: refusal });
        applyTeamGroupFailure({ scope: scopeA, address, groupId: 'group_1', error: refusal });

        expect(getTeamsDirectorySnapshot(scopeA, queryKey)).toMatchObject({
            data: null,
            nextCursor: null,
            lastObservedAt: null,
            stale: false,
            error: refusal,
        });
        expect(getTeamSnapshot(scopeA, address)).toMatchObject({
            data: null,
            lastObservedAt: null,
            stale: false,
            error: refusal,
        });
        expect(getTeamGroupsSnapshot(scopeA, address, groupQueryKey)).toMatchObject({
            data: null,
            nextCursor: null,
            lastObservedAt: null,
            stale: false,
            error: refusal,
        });
        expect(getTeamGroupSnapshot(scopeA, address, 'group_1')).toMatchObject({
            data: null,
            lastObservedAt: null,
            stale: false,
            error: refusal,
        });
    });

    it('shows a refresh over existing rows rather than a blank loading state', () => {
        applyTeamsDirectoryPage({
            scope: scopeA,
            queryKey,
            items: [team('t1')],
            nextCursor: null,
            observedAt: 30,
        });

        beginTeamsDirectoryLoad(scopeA, queryKey);

        const snapshot = getTeamsDirectorySnapshot(scopeA, queryKey);
        expect(snapshot?.status).toBe('refreshing');
        expect(snapshot?.data).toEqual([team('t1')]);
    });

    it('invalidates only the wakened Home and leaves other Homes untouched', () => {
        applyTeamsDirectoryPage({ scope: scopeA, queryKey, items: [team('t1')], nextCursor: null, observedAt: 40 });
        applyTeamsDirectoryPage({ scope: scopeB, queryKey, items: [team('t9')], nextCursor: null, observedAt: 41 });
        const untouched = getTeamsDirectorySnapshot(scopeB, queryKey);

        expect(invalidateTeamsSnapshotsForServer('home_a')).toBe(true);

        expect(getTeamsDirectorySnapshot(scopeA, queryKey)?.stale).toBe(true);
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)).toBe(untouched);
    });

    it('drops every Account row for one Home on sign-out', () => {
        const addressA = createTeamAddress('home_a', 't1')!;
        applyTeamsDirectoryPage({ scope: scopeA, queryKey, items: [team('t1')], nextCursor: null, observedAt: 50 });
        applyTeamProjection({ scope: scopeAOther, address: addressA, team: team('t1'), observedAt: 51 });
        applyTeamsDirectoryPage({ scope: scopeB, queryKey, items: [team('t9')], nextCursor: null, observedAt: 52 });

        clearTeamsSnapshotsForServer('home_a');

        expect(getTeamsDirectorySnapshot(scopeA, queryKey)).toBeNull();
        expect(getTeamSnapshot(scopeAOther, addressA)).toBeNull();
        expect(getTeamsDirectorySnapshot(scopeB, queryKey)?.data).toEqual([team('t9')]);
    });

    it('reads a Group label from the sequence a surface already loaded', () => {
        applyTeamGroupsPage({
            scope: scopeA,
            address: groupAddressA,
            queryKey: groupsQueryKey('team_1', 'active'),
            items: [groupRow('g1'), groupRow('g2', { name: 'Designers' })],
            nextCursor: null,
            observedAt: 70,
        });

        // A row that only needs a name must not force a detail read of its own,
        // which is the whole reason this reader exists.
        expect(readTeamGroup(scopeA, groupAddressA, 'g2')?.name).toBe('Designers');
        expect(readTeamGroups(scopeA, groupAddressA, 'active')?.map((row) => row.id))
            .toEqual(['g1', 'g2']);
        // The archived sequence is a different projection, not a filter of this one.
        expect(readTeamGroups(scopeA, groupAddressA, 'archived')).toBeNull();
    });

    it('prefers a Group detail read over the sequence copy of the same Group', () => {
        applyTeamGroupsPage({
            scope: scopeA,
            address: groupAddressA,
            queryKey: groupsQueryKey('team_1', 'active'),
            items: [groupRow('g1', { name: 'Stale name' })],
            nextCursor: null,
            observedAt: 71,
        });
        applyTeamGroupProjection({
            scope: scopeA,
            address: groupAddressA,
            group: groupRow('g1', { name: 'Renamed' }),
            observedAt: 72,
        });

        expect(readTeamGroup(scopeA, groupAddressA, 'g1')?.name).toBe('Renamed');
    });

    it('finds a Group that only the archived sequence holds', () => {
        applyTeamGroupsPage({
            scope: scopeA,
            address: groupAddressA,
            queryKey: groupsQueryKey('team_1', 'archived'),
            items: [groupRow('g9', { name: 'Retired', archivedAt: 5 })],
            nextCursor: null,
            observedAt: 73,
        });

        // An archived Group still names itself on a Session row that referenced
        // it, so a label reader that only looked at active rows would blank it.
        expect(readTeamGroup(scopeA, groupAddressA, 'g9')?.name).toBe('Retired');
    });

    it('keeps returning a stale Group label rather than blanking it during a refresh', () => {
        applyTeamGroupsPage({
            scope: scopeA,
            address: groupAddressA,
            queryKey: groupsQueryKey('team_1', 'active'),
            items: [groupRow('g1', { name: 'Developers' })],
            nextCursor: null,
            observedAt: 74,
        });
        expect(invalidateTeamGroupsForTeam(scopeA, groupAddressA)).toBe(true);

        // A stale name is the last thing the Home actually said; dropping it
        // while a refresh runs would be less truthful than showing it.
        expect(readTeamGroup(scopeA, groupAddressA, 'g1')?.name).toBe('Developers');
        expect(readTeamGroups(scopeA, groupAddressA, 'active')).toHaveLength(1);
    });

    it('never reads another Home or Account rows for the same Team and Group ID', () => {
        applyTeamGroupsPage({
            scope: scopeA,
            address: groupAddressA,
            queryKey: groupsQueryKey('team_1', 'active'),
            items: [groupRow('g1', { name: 'Home A group' })],
            nextCursor: null,
            observedAt: 75,
        });

        expect(readTeamGroup(scopeB, groupAddressB, 'g1')).toBeNull();
        expect(readTeamGroup(scopeAOther, groupAddressA, 'g1')).toBeNull();
        expect(readTeamGroups(scopeB, groupAddressB, 'active')).toBeNull();
        // A scope-qualified reader with nothing to qualify has no rows to answer with.
        expect(readTeamGroups(null, groupAddressA, 'active')).toBeNull();
        expect(readTeamGroup(scopeA, groupAddressA, '')).toBeNull();
    });

    it('notifies subscribers once per published change', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeTeamsSnapshots(listener);

        applyTeamsDirectoryPage({ scope: scopeA, queryKey, items: [team('t1')], nextCursor: null, observedAt: 60 });
        expect(listener).toHaveBeenCalledTimes(1);

        // A wake that changes nothing must not wake every subscriber.
        expect(invalidateTeamsSnapshotsForServer('home_b')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        applyTeamsDirectoryPage({ scope: scopeA, queryKey, items: [team('t1')], nextCursor: null, observedAt: 61 });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
