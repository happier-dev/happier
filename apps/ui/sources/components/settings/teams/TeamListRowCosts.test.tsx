import * as React from 'react';

import { expectHomePageReadCosts } from '@/dev/testkit/harness/expectHomePageReadCosts';
import { TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1, TeamMembersListInputV1Schema } from '@happier-dev/protocol/teams';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialViewerFixture, teamInvitationRowFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const router = createExpoRouterMock();
installSettingsViewCommonModuleMocks({ router: () => router.module, storage: 'real' });
const navigation = vi.hoisted(() => ({ focused: true, listeners: new Set<() => void>() }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock(), useIsFocused: () => React.useSyncExternalStore(
        listener => { navigation.listeners.add(listener); return () => { navigation.listeners.delete(listener); }; },
        () => navigation.focused, () => navigation.focused) };
});
// Only the third-party recycler is replaced: eight visible segments, real rows/Items.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItemLimit: 8 }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { Item } = await import('@/components/ui/lists/Item');
const { TeamMembersScreen } = await import('./members/TeamMembersScreen');
const { TeamMembersCollectionRail } = await import('./members/TeamMembersCollectionRail');
const { TeamCredentialsScreen } = await import('./credentials/TeamCredentialsScreen');
const { TeamInvitationsScreen } = await import('./invitations/TeamInvitationsScreen');
const { resetTeamsSnapshotsForTests, applyTeamProjection, applyTeamMembersPage, applyTeamCredentialResourcesPage, getTeamCredentialResourcesSnapshot, teamMembersQueryKey } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { NavigationContext, useNavigation } = await import('@react-navigation/native');

function NativeRoute({ children }: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
}
beforeEach(async () => { resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests(); navigation.focused = true; await home.reset(); });
afterEach(() => standardCleanup());

async function setup() {
    const serverId = await home.addHome({ name: 'Rows', serverUrl: 'https://row-cost.example.test', accountId: 'viewer',
        teamsEnabled: true, credentialResourcesEnabled: true });
    const scope = { serverId, accountId: 'viewer' };
    const address = { serverId, teamId: 'team-1' };
    const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ viewRoster: true, manageInvitations: true }) });
    home.answer(serverId, '/v1/teams/get', { body: team });
    return { serverId, scope, address, team };
}

function rowProps(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string) {
    return new Map(screen.tree.findAllByType(Item).filter(node => String(node.props.testID).startsWith(prefix))
        .map(node => [String(node.props.testID), node.props] as const));
}
function changedRows(before: ReturnType<typeof rowProps>, after: ReturnType<typeof rowProps>) {
    return [...after].filter(([id, props]) => props !== before.get(id)).length;
}

describe('Team mounted-row costs', () => {
    it('reads one Team and roster on cold Members open and zero on return', async () => {
        const { address } = await setup();
        const items = Array.from({ length: 400 }, (_, index) => teamMembershipFixture({
            id: `member-${index}`, accountId: `account-${index}`,
        }));
        const rosterPath = '/v1/teams/members/list';
        home.answer(address.serverId, rosterPath, { select: input => {
            const { cursor } = TeamMembersListInputV1Schema.parse(input);
            const offset = typeof cursor === 'string' ? Number(cursor) : 0;
            const nextOffset = offset + TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1;
            return { body: { items: items.slice(offset, nextOffset), nextCursor: nextOffset < items.length ? String(nextOffset) : null } };
        } });
        const page = <TeamMembersScreen serverId={address.serverId} teamId={address.teamId} />;
        const reads = { '/v1/teams/get': 1, [rosterPath]: 1 };
        await expectHomePageReadCosts({
            home, mount: () => renderScreen(page, { wrapper: NativeRoute }), leave: <></>, returnTo: page,
            settled: screen => expect(rowProps(screen, 'team-members-row:').size).toBeGreaterThan(3),
            cold: reads, returning: { '/v1/teams/get': 0, [rosterPath]: 0 },
        });
    });

    it.each(['page', 'rail'] as const)('invalidates only one mounted member %s row for one changed row on a 400-member arrival', async surface => {
        const { scope, address } = await setup();
        const items = Array.from({ length: 400 }, (_, i) => teamMembershipFixture({ id: `member-${i}`, accountId: `account-${i}` }));
        home.answer(address.serverId, '/v1/teams/members/list', { body: { items, nextCursor: null } });
        const screen = await renderScreen(surface === 'rail'
            ? <TeamMembersCollectionRail address={address} selectedMembershipId={null} />
            : <TeamMembersScreen serverId={address.serverId} teamId={address.teamId} />, { wrapper: NativeRoute });
        const prefix = surface === 'rail' ? 'team-members-rail-row:' : 'team-members-row:';
        await vi.waitFor(() => expect(rowProps(screen, prefix).size).toBeGreaterThan(3));
        const baseline = rowProps(screen, prefix);
        expect(baseline.size).toBeLessThanOrEqual(96);
        await act(async () => applyTeamMembersPage({ scope, address, queryKey: teamMembersQueryKey('all'),
            items: items.map((row, i) => i === 0 ? { ...row, account: { ...row.account, name: 'Renamed' } } : { ...row }), nextCursor: null }));
        expect(changedRows(baseline, rowProps(screen, prefix))).toBe(1);
        if (surface === 'rail') {
            const beforeSelection = rowProps(screen, prefix);
            await screen.update(<TeamMembersCollectionRail address={{ ...address }} selectedMembershipId="member-1" />);
            expect(changedRows(beforeSelection, rowProps(screen, prefix))).toBe(1);
            const beforeMove = rowProps(screen, prefix);
            await screen.update(<TeamMembersCollectionRail address={{ ...address }} selectedMembershipId="member-2" />);
            expect(changedRows(beforeMove, rowProps(screen, prefix))).toBe(2);
        }
        await screen.pressByTestIdAsync(`${prefix}member-1`);
        expect(surface === 'rail' ? router.spies.replace : router.spies.push).toHaveBeenCalledWith(expect.stringContaining('member-1'));
    });

    it('isolates credential edits and divider changes across 400 mounted rows', async () => {
        const { scope, address, team } = await setup();
        const resources = Array.from({ length: 400 }, (_, i) => teamCredentialResourceFixture({ id: `resource-${i}`, displayName: `Resource ${String(i).padStart(3, '0')}` }));
        const viewer = teamCredentialViewerFixture({ manageCredentials: true });
        home.answer(address.serverId, '/v1/teams/credential-resources/list', { body: { resources, viewer, nextCursor: null } });
        const screen = await renderScreen(<TeamCredentialsScreen serverId={address.serverId} teamId={address.teamId} />, { wrapper: NativeRoute });
        await vi.waitFor(() => {
            const rows = rowProps(screen, 'team-credentials-row:');
            expect(rows.size).toBe(400);
            for (let i = 0; i < 400; i += 1) {
                expect(rows.get(`team-credentials-row:resource-${i}`)?.title).toBe(`Resource ${String(i).padStart(3, '0')}`);
            }
        });
        const baseline = rowProps(screen, 'team-credentials-row:');
        await act(async () => applyTeamProjection({ scope, address, team: { ...team, name: 'Renamed Team' }, observedAt: Date.now() }));
        expect(changedRows(baseline, rowProps(screen, 'team-credentials-row:'))).toBe(0);
        const admitted = getTeamCredentialResourcesSnapshot(scope, address);
        if (!admitted?.data) throw new Error('Expected admitted credential rows');
        const editedKey = 'team-credentials-row:resource-0';
        const applyRows = (rows: NonNullable<typeof admitted.data>) => act(async () => {
            applyTeamCredentialResourcesPage({ scope, address, resources: rows, viewer, nextCursor: null, observedAt: Date.now() });
        });
        const editedAudience = admitted.data.map((row, index) => index === 0
            ? { ...row, allMembersAllowedRoutes: ['brokered' as const] } : { ...row });
        await applyRows(editedAudience);
        const beforeRename = rowProps(screen, 'team-credentials-row:');
        expect(beforeRename.get(editedKey)?.subtitle).not.toBe(baseline.get(editedKey)?.subtitle);
        expect([...beforeRename].filter(([key, props]) => props !== baseline.get(key)).map(([key]) => key))
            .toEqual([editedKey]);

        // A replacement label can sort through its unopened state. Only the
        // edited row and rows whose divider boundary changed may invalidate.
        const previousLast = [...beforeRename.keys()].at(-1);
        const dividerRows = new Set<string>();
        const unsubscribe = screen.tree.subscribe(() => {
            const last = [...rowProps(screen, 'team-credentials-row:').keys()].at(-1);
            if (last !== previousLast) {
                if (previousLast) dividerRows.add(previousLast);
                if (last) dividerRows.add(last);
            }
        });
        try {
            await applyRows(editedAudience.map((row, index) => index === 0
                ? { ...row, displayName: teamCredentialDisplayNameFixture('Edited resource') } : row));
            await vi.waitFor(() => expect(rowProps(screen, 'team-credentials-row:').get(editedKey)?.title).toBe('Edited resource'));
        } finally {
            unsubscribe();
        }
        const updated = rowProps(screen, 'team-credentials-row:');
        const changed = [...updated].filter(([key, props]) => props !== beforeRename.get(key)).map(([key]) => key);
        expect(changed).toContain(editedKey);
        expect(changed.filter(key => key !== editedKey && !dividerRows.has(key))).toEqual([]);
        await screen.pressByTestIdAsync('team-credentials-row:resource-1');
        expect(router.spies.push).toHaveBeenCalledWith(expect.stringContaining('resource-1'));
    });

    it('invalidates only the edited mounted invitation after a 400-invitation network refresh', async () => {
        const { serverId, address } = await setup();
        const items = Array.from({ length: 400 }, (_, i) => teamInvitationRowFixture({ id: `invitation-${i}`, expiresAt: Date.now() + 86_400_000 }));
        home.answer(serverId, '/v1/teams/invitations/list', { body: { items, nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' } });
        const screen = await renderScreen(<TeamInvitationsScreen serverId={serverId} teamId={address.teamId} />, { wrapper: NativeRoute });
        await vi.waitFor(() => expect(rowProps(screen, 'team-invitations-row:').size).toBeGreaterThan(3));
        const baseline = rowProps(screen, 'team-invitations-row:');
        expect(baseline.size).toBeLessThanOrEqual(96);
        home.answer(serverId, '/v1/teams/invitations/list', { body: { items: items.map((row, i) => i === 0 ? { ...row, role: 'admin' } : row), nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' } });
        // Returning from Invite refreshes the invitation sequence without an
        // independent Team-authority wake (which legitimately changes every action).
        await act(async () => { navigation.focused = false; navigation.listeners.forEach(listener => listener()); });
        await act(async () => { navigation.focused = true; navigation.listeners.forEach(listener => listener()); });
        await vi.waitFor(() => expect(home.requestsFor('/v1/teams/invitations/list')).toHaveLength(2));
        await vi.waitFor(() => expect(changedRows(baseline, rowProps(screen, 'team-invitations-row:'))).toBe(1));
    });
});
