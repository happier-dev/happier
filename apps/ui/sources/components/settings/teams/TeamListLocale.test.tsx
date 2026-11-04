import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialViewerFixture, teamInvitationRowFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Locale loading, committed language, list owners and rows stay real; only platform boundaries are replaced.
installSettingsViewCommonModuleMocks({ storage: 'real', text: () => vi.importActual('@/text') });
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
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
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { preloadTranslations, getPreferredLanguage } = await import('@/text');
const { commitPreferredLanguage } = await import('@/text/preferredLanguage');
const { NavigationContext, useNavigation } = await import('@react-navigation/native');

function NativeRoute({ children }: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
}

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    await home.reset();
});
afterEach(() => standardCleanup());

describe('retained Team list locale', () => {
    it.each(['members', 'members rail', 'credentials', 'invitations'] as const)('updates %s row copy from the committed locale without fetching or replacing its data', async surface => {
        await preloadTranslations('en');
        await preloadTranslations('fr');
        const previous = getPreferredLanguage();
        await act(async () => { commitPreferredLanguage('en'); });
        try {
            const serverId = await home.addHome({ name: 'Rows', serverUrl: 'https://row-locale.example.test', accountId: 'viewer',
                teamsEnabled: true, credentialResourcesEnabled: true });
            const address = { serverId, teamId: 'team-1' };
            home.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ viewRoster: true, manageInvitations: true }) }) });
            const member = teamMembershipFixture({ role: 'member' });
            const resource = teamCredentialResourceFixture({ allMembersAllowedRoutes: ['brokered'] });
            const invitation = teamInvitationRowFixture({ expiresAt: Date.now() + 86_400_000 });
            const path = surface === 'credentials' ? '/v1/teams/credential-resources/list'
                : surface === 'invitations' ? '/v1/teams/invitations/list' : '/v1/teams/members/list';
            home.answer(serverId, path, { body: surface === 'credentials'
                ? { resources: [resource], viewer: teamCredentialViewerFixture({ manageCredentials: true }), nextCursor: null }
                : surface === 'invitations' ? { items: [invitation], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' }
                    : { items: [member], nextCursor: null } });
            const page = surface === 'members rail' ? <TeamMembersCollectionRail address={address} selectedMembershipId={null} />
                : surface === 'members' ? <TeamMembersScreen serverId={serverId} teamId={address.teamId} />
                    : surface === 'credentials' ? <TeamCredentialsScreen serverId={serverId} teamId={address.teamId} />
                        : <TeamInvitationsScreen serverId={serverId} teamId={address.teamId} />;
            const prefix = surface === 'members rail' ? 'team-members-rail-row:' : `team-${surface}-row:`;
            const screen = await renderScreen(page, { wrapper: NativeRoute });
            const row = () => screen.tree.findAllByType(Item).find(node => String(node.props.testID).startsWith(prefix));
            await vi.waitFor(() => expect(row()).toBeDefined());
            await flushHookEffects();
            const english = row()!;
            const englishProps = english.props;
            const rowOwner = english.parent;
            const data = rowOwner?.props.membership ?? rowOwner?.props.resource ?? rowOwner?.props.row;
            expect(data).toBeDefined();
            const requests = home.requestsFor(path).length;

            await act(async () => { commitPreferredLanguage('fr'); });
            expect(row()?.props.subtitle).not.toBe(englishProps.subtitle);
            expect(row()?.parent).toBe(rowOwner);
            expect(rowOwner?.props.membership ?? rowOwner?.props.resource ?? rowOwner?.props.row).toBe(data);
            expect(home.requestsFor(path)).toHaveLength(requests);

            const frenchProps = row()?.props;
            await act(async () => { commitPreferredLanguage('fr'); });
            expect(row()?.props).toBe(frenchProps);
            expect(home.requestsFor(path)).toHaveLength(requests);

            await act(async () => { commitPreferredLanguage('en'); });
            expect(row()?.props.subtitle).toBe(englishProps.subtitle);
            expect(home.requestsFor(path)).toHaveLength(requests);
        } finally {
            await act(async () => { commitPreferredLanguage(previous); });
        }
    });
});
