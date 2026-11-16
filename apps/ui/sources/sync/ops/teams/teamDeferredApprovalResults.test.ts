import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamGroupsQueryKeyV1 } from '@happier-dev/protocol/teams';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { createDeferred, standardCleanup, teamGroupFixture, teamGroupMemberFixture, teamInvitationRowFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const confirmNative = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmNative } }).module;
});

// Own UI presses answer saved Ask policy in the native confirmation. Keep the
// real Action admission, Team wrappers and projections beneath that boundary.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createTeamGroup, addTeamGroupMember } = await import('./teamGroupOperations');
const { teamGroupNameBinding } = await import('./teamGroupLabels');
const { addTeamMember } = await import('./teamMemberOperations');
const { createTeam } = await import('./teamOperations');
const { createTeamInvitation, reissueTeamInvitation } = await import('./teamInvitationOperations');
const { resetTeamActionClientForTests } = await import('./teamActionClient');
const snapshots = await import('@/sync/store/teams/teamsSnapshots');
// Warm the real lazy front door during collection, as the adjacent client suite
// does, so the confirmation assertions measure interaction rather than imports.
await import('@/sync/ops/actions/defaultActionExecutor');

const confirmations: Array<() => Promise<void>> = [];

let serverId: string;
let scope: Readonly<{ serverId: string; accountId: string }>;
let address: Readonly<{ serverId: string; teamId: string }>;
const team = teamSummaryFixture({ id: 'team-new', name: 'Design' });
const group = teamGroupFixture({ id: 'group-new', name: 'Design' });
const groupName = sealPrivateLabelV1({ mode: 'plain', binding: teamGroupNameBinding(group.id), value: 'Design' });
const membership = teamMembershipFixture({ id: 'membership-grace', accountId: 'account-grace' });

beforeEach(async () => {
    confirmNative.mockReset();
    confirmNative.mockResolvedValue(true);
    await homes.reset();
    resetTeamActionClientForTests();
    serverId = await homes.addHome({ name: 'Team Home', serverUrl: 'https://deferred-team.test', accountId: 'account-ada', teamsEnabled: true });
    scope = { serverId, accountId: 'account-ada' };
    address = { serverId, teamId: 'team-1' };
});
afterEach(async () => {
    await Promise.all(confirmations.splice(0).map(release => release()));
    resetTeamActionClientForTests();
    standardCleanup();
});

async function pendingConfirmation<T>(operation: () => Promise<T>) {
    const decision = createDeferred<boolean>();
    const before = confirmNative.mock.calls.length;
    confirmNative.mockReturnValueOnce(decision.promise);
    const result = operation();
    confirmations.push(async () => { decision.resolve(false); await result; });
    await waitForHomeGovernance(() => expect(confirmNative).toHaveBeenCalledTimes(before + 1));
    expect(homes.artifacts(serverId).list()).toHaveLength(0);
    return { result, decision };
}

function seedGroups() {
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived: 'active' });
    snapshots.applyTeamGroupsPage({ scope, address, queryKey, items: [], nextCursor: null, observedAt: 1 });
    return () => snapshots.getTeamGroupsSnapshot(scope, address, queryKey);
}

describe('natively confirmed Team mutation results', () => {
    it('publishes a confirmed Team creation under the id only its answer carries', async () => {
        const path = '/v1/teams/create';
        homes.answer(serverId, path, { body: team });
        await homes.requireUiApproval(serverId, 'teams.create');
        const pending = await pendingConfirmation(() => createTeam({ scope, name: 'Design', description: null, requestKey: 'key-1' }));
        const createdAddress = { serverId, teamId: team.id };
        expect(snapshots.getTeamSnapshot(scope, createdAddress)).toBeNull();
        expect(homes.requestsFor(path)).toHaveLength(0);
        pending.decision.resolve(true);
        await expect(pending.result).resolves.toEqual({ kind: 'succeeded', team });
        expect(snapshots.getTeamSnapshot(scope, createdAddress)?.data).toEqual(team);
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('publishes a confirmed Group creation and marks the sequences it moved', async () => {
        const path = '/v1/teams/groups/create';
        homes.answer(serverId, path, { body: group });
        await homes.requireUiApproval(serverId, 'teams.groups.create');
        const readGroups = seedGroups();
        const pending = await pendingConfirmation(() => createTeamGroup({ scope, address, groupId: group.id, name: groupName, description: null,
            requestKey: 'key-1' }));
        expect(readGroups()?.stale).toBe(false);
        expect(homes.requestsFor(path)).toHaveLength(0);
        pending.decision.resolve(true);
        await expect(pending.result).resolves.toEqual({ kind: 'succeeded', value: group });
        expect(snapshots.getTeamGroupSnapshot(scope, address, group.id)?.data).toEqual(group);
        expect(readGroups()?.stale).toBe(true);
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('invalidates the exact Team behind a confirmed admission before the caller acts', async () => {
        const path = '/v1/teams/members/add';
        homes.answer(serverId, path, { body: membership });
        await homes.requireUiApproval(serverId, 'teams.members.add');
        snapshots.applyTeamProjection({ scope, address, team: teamSummaryFixture(), observedAt: 1 });
        const revalidation = createDeferred<void>();
        homes.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture(), respondAfter: revalidation.promise });
        const pending = await pendingConfirmation(() => addTeamMember({ scope, address, accountId: 'account-grace', role: 'member',
            historyAccess: 'all_existing' }));
        expect(homes.requestsFor(path)).toHaveLength(0);
        expect(snapshots.getTeamSnapshot(scope, address)?.stale).toBe(false);
        expect(homes.requestsFor('/v1/teams/get')).toHaveLength(0);
        try {
            pending.decision.resolve(true);
            await expect(pending.result).resolves.toEqual({ kind: 'succeeded', value: membership });
            expect(snapshots.getTeamSnapshot(scope, address)?.stale).toBe(true);
            await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/teams/get')).toHaveLength(1));
            expect(homes.requestsFor(path)).toHaveLength(1);
        } finally {
            revalidation.resolve();
            const { refreshTeam } = await import('@/sync/engine/teams/teamsDirectoryEngine');
            await refreshTeam(scope, address);
        }
    });

    it('keeps a confirmed Group contribution truthful about whether it changed anything', async () => {
        const path = '/v1/teams/groups/members/add';
        await homes.requireUiApproval(serverId, 'teams.groups.members.add');
        for (const status of ['added', 'unchanged'] as const) {
            const result = status === 'added'
                ? { status, member: teamGroupMemberFixture({ accountId: 'account-grace', membershipId: 'membership-grace' }) }
                : { status };
            homes.answer(serverId, path, { body: result });
            const readGroups = seedGroups();
            const before = homes.requestsFor(path).length;
            const pending = await pendingConfirmation(() => addTeamGroupMember({ scope, address, groupId: 'group-1', accountId: 'account-grace',
                historyAccess: status === 'added' ? 'all_existing' : 'from_membership' }));
            expect(readGroups()?.stale).toBe(false);
            expect(homes.requestsFor(path)).toHaveLength(before);
            pending.decision.resolve(true);
            await expect(pending.result).resolves.toEqual({ kind: 'succeeded', value: result });
            expect(readGroups()?.stale).toBe(status === 'added');
        }
        expect(homes.requestsFor(path)).toHaveLength(2);
    });

    it('keeps cancelled invitation creation and reissue from issuing an effect or persisting a bearer', async () => {
        await homes.requireUiApproval(serverId, ['teams.invitations.create', 'teams.invitations.reissue']);
        const token = 'a'.repeat(43);
        for (const operation of ['create', 'reissue'] as const) {
            const lifetime = new AbortController();
            const path = `/v1/teams/invitations/${operation}`;
            homes.answer(serverId, path, { body: operation === 'create'
                ? { invitation: teamInvitationRowFixture(), joinUrl: `https://deferred-team.test/join/${token}` }
                : { replacement: teamInvitationRowFixture({ id: 'invitation-2' }), joinUrl: `https://deferred-team.test/join/${token}` } });
            const pending = await pendingConfirmation<Awaited<ReturnType<typeof createTeamInvitation>>
                | Awaited<ReturnType<typeof reissueTeamInvitation>>>(() => operation === 'create'
                ? createTeamInvitation({ scope, address, role: 'member', historyAccess: 'from_membership', recipientEmail: null,
                    requestKey: 'key-create', signal: lifetime.signal })
                : reissueTeamInvitation({ scope, address, invitationId: 'invitation-1', recipientEmail: null,
                    requestKey: 'key-reissue', signal: lifetime.signal }));
            try {
                expect(homes.requestsFor(path)).toHaveLength(0);
                lifetime.abort();
                pending.decision.resolve(true);
                await expect(pending.result).resolves.toMatchObject({ kind: 'failed', failure: { code: 'cancelled', retryable: false } });
                expect(homes.requestsFor(path)).toHaveLength(0);
                expect(homes.artifacts(serverId).list()).toHaveLength(0);
            } finally { lifetime.abort(); pending.decision.resolve(false); await pending.result; }
        }
    });

    it('returns a declined confirmation as a failure without publishing a Team', async () => {
        await homes.requireUiApproval(serverId, 'teams.create');
        const pending = await pendingConfirmation(() => createTeam({ scope, name: 'Design', description: null, requestKey: 'key-1' }));
        pending.decision.resolve(false);
        await expect(pending.result).resolves.toMatchObject({ kind: 'failed',
            failure: { kind: 'forbidden', code: 'approval_canceled', retryable: false } });
        expect(snapshots.getTeamSnapshot(scope, { serverId, teamId: team.id })).toBeNull();
        expect(homes.requestsFor('/v1/teams/create')).toHaveLength(0);
    });

    it('returns a confirmed invitation bearer only to its live caller', async () => {
        const path = '/v1/teams/invitations/create';
        await homes.requireUiApproval(serverId, 'teams.invitations.create');
        const value = { invitation: teamInvitationRowFixture(), joinUrl: `https://deferred-team.test/join/${'a'.repeat(43)}` };
        homes.answer(serverId, path, { body: value });
        const pending = await pendingConfirmation(() => createTeamInvitation({ scope, address, role: 'member',
            historyAccess: 'from_membership', recipientEmail: null, requestKey: 'key-live', signal: new AbortController().signal }));
        expect(homes.requestsFor(path)).toHaveLength(0);
        pending.decision.resolve(true);
        await expect(pending.result).resolves.toEqual({ kind: 'succeeded', value });
        expect(homes.requestsFor(path)).toHaveLength(1);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
    });

    it('returns the Home refusal after confirmation without publishing a Group', async () => {
        await homes.requireUiApproval(serverId, 'teams.groups.create');
        homes.answer(serverId, '/v1/teams/groups/create', { status: 403, body: { error: 'forbidden' } });
        const pending = await pendingConfirmation(() => createTeamGroup({ scope, address, groupId: group.id, name: groupName,
            description: null, requestKey: 'key-1' }));
        pending.decision.resolve(true);
        await expect(pending.result).resolves.toMatchObject({ kind: 'failed', failure: { kind: 'forbidden', retryable: false } });
        expect(snapshots.getTeamGroupSnapshot(scope, address, group.id)).toBeNull();
        expect(homes.requestsFor('/v1/teams/groups/create')).toHaveLength(1);
    });
});
