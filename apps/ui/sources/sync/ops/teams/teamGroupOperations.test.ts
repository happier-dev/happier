import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    NO_TEAM_GROUP_CAPABILITIES_V1,
    teamGroupsQueryKeyV1,
    type TeamGroupMemberV1,
    type TeamGroupV1,
} from '@happier-dev/protocol/teams';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup, teamGroupFixture } from '@/dev/testkit';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

/**
 * The Group wrappers, through the path they actually take.
 *
 * Each wrapper names a canonical Action id and nothing else: the method, path
 * and result shape come from that id's row by way of the shared Action front
 * door, which also captures the Account context before it dispatches. So this
 * watches the network boundary — only the network and the device credential
 * store are replaced, and the front door itself stays real.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GROUPS_LIST_PATH = '/v1/teams/groups/list';
const MEMBER_ADD_PATH = '/v1/teams/groups/members/add';
const MEMBER_REMOVE_PATH = '/v1/teams/groups/members/remove';

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import {
    applyTeamGroupProjection,
    applyTeamGroupsPage,
    getTeamGroupSnapshot,
    getTeamGroupsSnapshot,
    resetTeamsSnapshotsForTests,
} from '@/sync/store/teams/teamsSnapshots';

/** Imported through the installed boundaries, like every other Team ops suite. */
async function operations() {
    return await import('./teamGroupOperations');
}

function group(overrides?: Partial<TeamGroupV1>): TeamGroupV1 {
    return teamGroupFixture({
        memberCount: 2,
        capabilities: { ...NO_TEAM_GROUP_CAPABILITIES_V1, manageNativeMembers: true },
        ...overrides,
    });
}

function member(overrides?: Partial<TeamGroupMemberV1>): TeamGroupMemberV1 {
    return {
        accountId: 'account-2',
        membershipId: 'membership-2',
        account: { name: 'Ada', firstName: 'Ada', lastName: null, username: null, avatarUrl: null },
        historyAccess: 'from_membership',
        contributions: { native: true, external: [] },
        ...overrides,
    };
}

async function addHome(): Promise<string> {
    return await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account',
    });
}

function scopeFor(serverId: string) {
    return createServerAccountScope(serverId, 'account')!;
}

function addressFor(serverId: string) {
    return createTeamAddress(serverId, 'team-1')!;
}

beforeEach(async () => {
    await harness.reset();
    resetTeamsSnapshotsForTests();
});

afterEach(() => {
    resetTeamsSnapshotsForTests();
    standardCleanup();
});

/**
 * Seeds both Group projections a surface can be holding when a member mutation
 * lands: the Groups sequence a Groups screen paged in, and the one Group a
 * detail read or a row label published.
 */
function seedGroupProjections(serverId: string): Readonly<{
    scope: ReturnType<typeof scopeFor>;
    address: ReturnType<typeof addressFor>;
    queryKey: string;
}> {
    const scope = scopeFor(serverId);
    const address = addressFor(serverId);
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: 'team-1', archived: 'active' });
    applyTeamGroupsPage({
        scope,
        address,
        queryKey,
        items: [group()],
        nextCursor: null,
        observedAt: 1,
    });
    applyTeamGroupProjection({ scope, address, group: group(), observedAt: 1 });
    return { scope, address, queryKey };
}

describe('teamGroupOperations', () => {
    it('reads Groups from the exact Home with the archived sequence it was asked for', async () => {
        const serverId = await addHome();
        harness.answer(serverId, GROUPS_LIST_PATH, { body: { items: [group()], nextCursor: null } });

        const outcome = await (await operations()).listTeamGroups({
            scope: scopeFor(serverId),
            address: addressFor(serverId),
            archived: 'archived',
        });

        expect(outcome.kind).toBe('succeeded');
        expect(harness.requestsFor(GROUPS_LIST_PATH)).toHaveLength(1);
        expect(harness.requestsFor(GROUPS_LIST_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            archived: 'archived',
        });
    });

    it('carries a surviving external contribution through as `contribution_removed`', async () => {
        const serverId = await addHome();
        // The native contribution went away but a directory still supplies this
        // person, so the Home reports that the Group access did not actually end.
        harness.answer(serverId, MEMBER_REMOVE_PATH, {
            body: {
                status: 'contribution_removed',
                member: member({ contributions: { native: false, external: [{
                    bindingId: 'b1',
                    label: 'Okta',
                    owner: { kind: 'directory_source', directorySourceId: 'source-1' },
                }] } }),
            },
        });

        const outcome = await (await operations()).removeTeamGroupMember({
            scope: scopeFor(serverId),
            address: addressFor(serverId),
            groupId: 'group-1',
            accountId: 'account-2',
        });

        expect(outcome.kind).toBe('succeeded');
        if (outcome.kind !== 'succeeded') return;
        // Collapsing this into `removed` would tell a manager access ended when
        // it did not, which is the exact failure the union exists to prevent.
        expect(outcome.value.status).toBe('contribution_removed');
        expect(harness.requestsFor(MEMBER_REMOVE_PATH)).toHaveLength(1);
    });

    it('sends the Group history intent the manager chose, untouched', async () => {
        const serverId = await addHome();
        harness.answer(serverId, MEMBER_ADD_PATH, { body: { status: 'added', member: member() } });

        await (await operations()).addTeamGroupMember({
            scope: scopeFor(serverId),
            address: addressFor(serverId),
            groupId: 'group-1',
            accountId: 'account-2',
            historyAccess: 'all_existing',
        });

        expect(harness.requestsFor(MEMBER_ADD_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            groupId: 'group-1',
            accountId: 'account-2',
            historyAccess: 'all_existing',
        });
    });

    it('marks the Group projections stale after a member mutation changes the count', async () => {
        const serverId = await addHome();
        const { scope, address, queryKey } = seedGroupProjections(serverId);
        expect(getTeamGroupsSnapshot(scope, address, queryKey)?.stale).toBe(false);

        harness.answer(serverId, MEMBER_ADD_PATH, { body: { status: 'added', member: member() } });
        await (await operations()).addTeamGroupMember({
            scope,
            address,
            groupId: 'group-1',
            accountId: 'account-2',
            historyAccess: 'from_membership',
        });

        // `memberCount` lives on the Group row, so a surface still holding the
        // pre-add row — a Groups list, or a Session row reading its label —
        // would keep showing the old count with nothing to wake it.
        expect(getTeamGroupsSnapshot(scope, address, queryKey)?.stale).toBe(true);
        expect(getTeamGroupSnapshot(scope, address, 'group-1')?.stale).toBe(true);
    });

    it('marks them stale when a removal only cleared the native contribution', async () => {
        const serverId = await addHome();
        const { scope, address, queryKey } = seedGroupProjections(serverId);

        // The person keeps Group access through a directory, but the Home is
        // still the authority on what the Group's count now is.
        harness.answer(serverId, MEMBER_REMOVE_PATH, {
            body: {
                status: 'contribution_removed',
                member: member({ contributions: { native: false, external: [{
                    bindingId: 'b1',
                    label: 'Okta',
                    owner: { kind: 'directory_source', directorySourceId: 'source-1' },
                }] } }),
            },
        });
        await (await operations()).removeTeamGroupMember({
            scope,
            address,
            groupId: 'group-1',
            accountId: 'account-2',
        });

        expect(getTeamGroupsSnapshot(scope, address, queryKey)?.stale).toBe(true);
    });

    it('leaves Group projections current when native removal was already absent', async () => {
        const serverId = await addHome();
        const { scope, address, queryKey } = seedGroupProjections(serverId);

        harness.answer(serverId, MEMBER_REMOVE_PATH, { body: { status: 'unchanged' } });
        const outcome = await (await operations()).removeTeamGroupMember({
            scope,
            address,
            groupId: 'group-1',
            accountId: 'account-2',
        });

        expect(outcome).toMatchObject({ kind: 'succeeded', value: { status: 'unchanged' } });
        expect(getTeamGroupsSnapshot(scope, address, queryKey)?.stale).toBe(false);
        expect(getTeamGroupSnapshot(scope, address, 'group-1')?.stale).toBe(false);
    });

    it('leaves the Group projections alone when the member mutation was refused', async () => {
        const serverId = await addHome();
        const { scope, address, queryKey } = seedGroupProjections(serverId);

        harness.answer(serverId, MEMBER_ADD_PATH, { status: 403, body: {} });
        const outcome = await (await operations()).addTeamGroupMember({
            scope,
            address,
            groupId: 'group-1',
            accountId: 'account-2',
            historyAccess: 'from_membership',
        });

        expect(outcome.kind).toBe('failed');
        // Nothing changed on the Home, so discarding freshness here would make
        // every refused attempt re-read the whole sequence for no reason.
        expect(getTeamGroupsSnapshot(scope, address, queryKey)?.stale).toBe(false);
        expect(getTeamGroupSnapshot(scope, address, 'group-1')?.stale).toBe(false);
    });

    it('reports a refusal as a typed failure instead of an empty page', async () => {
        const serverId = await addHome();
        harness.answer(serverId, GROUPS_LIST_PATH, { status: 403, body: {} });

        const outcome = await (await operations()).listTeamGroups({
            scope: scopeFor(serverId),
            address: addressFor(serverId),
            archived: 'active',
        });

        expect(outcome).toMatchObject({ kind: 'failed', failure: { kind: 'forbidden', retryable: false } });
    });
});
