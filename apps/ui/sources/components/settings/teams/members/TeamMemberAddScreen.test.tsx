import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, homeAccountPickerRowFixture, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const ACCOUNT_SEARCH_PATH = '/v1/home/accounts/search';
// Load the real screen before behavior deadlines; the first import traverses the full UI graph.
const { TeamMemberAddScreen } = await import('./TeamMemberAddScreen');

async function renderAddMember(serverId: string) {
    return renderScreen(<TeamMemberAddScreen serverId={serverId} teamId="team-1" />);
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderAddMember>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
});

afterEach(() => {
    standardCleanup();
});

describe('TeamMemberAddScreen search', () => {
    it('distinguishes loading, empty, failure, and a successful retry', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
        });

        let releaseEmpty!: () => void;
        const emptyGate = new Promise<void>((resolve) => { releaseEmpty = resolve; });
        harness.answer(serverId, ACCOUNT_SEARCH_PATH, {
            body: { accounts: [] },
            respondAfter: emptyGate,
        });

        const screen = await renderAddMember(serverId);
        await act(() => screen.changeTextByTestId('team-member-add-search', 'Grace'));
        await waitForTestId(screen, 'team-member-add-search-loading');
        releaseEmpty();
        await waitForTestId(screen, 'team-member-add-search-empty');

        harness.answer(serverId, ACCOUNT_SEARCH_PATH, { status: 503, body: { error: 'unavailable' } });
        await act(() => screen.changeTextByTestId('team-member-add-search', 'Ada'));
        await waitForTestId(screen, 'team-member-add-search-retry');

        harness.answer(serverId, ACCOUNT_SEARCH_PATH, {
            body: { accounts: [homeAccountPickerRowFixture('account-grace', 'Grace')] },
        });
        await screen.pressByTestIdAsync('team-member-add-search-retry');
        await waitForTestId(screen, 'team-member-add-candidate:account-grace');
    });

    it('names the audience whose history the admission choice grants', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
        });

        const screen = await renderAddMember(serverId);
        await waitForTestId(screen, 'team-member-add-history:from_membership');

        // An irreversible-at-mint horizon must say which audience it opens history
        // to. The row's title is rendered text, not a prop of the node the testID
        // resolves to, so it is asserted where a reader would actually see it.
        // The same choice and words Team Settings uses for this fact: two short segments and
        // what the chosen one means beneath them.
        const selected = screen.findByTestId('team-member-add-history:from_membership');
        expect(selected?.props.accessibilityState).toMatchObject({ checked: true });
        expect(screen.getTextContent()).toContain('teams.settings.option.fromJoining');
        expect(screen.getTextContent()).toContain('teams.settings.option.earlierToo');
        expect(screen.getTextContent()).toContain('teams.settings.consequence.historyFromJoining');
    });

    it('says why a found Account cannot be chosen instead of silently disabling it', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
        });
        harness.answer(serverId, ACCOUNT_SEARCH_PATH, {
            body: { accounts: [{ ...homeAccountPickerRowFixture('account-grace', 'Grace'), eligible: false }] },
        });

        const screen = await renderAddMember(serverId);
        await act(() => screen.changeTextByTestId('team-member-add-search', 'Grace'));
        await waitForTestId(screen, 'team-member-add-candidate:account-grace');

        expect(screen.getTextContent()).toContain('teams.members.ineligible');
    });

    it('does not offer retry for an authoritative search refusal', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
        });
        harness.answer(serverId, ACCOUNT_SEARCH_PATH, { status: 403, body: { error: 'forbidden' } });

        const screen = await renderAddMember(serverId);
        await act(() => screen.changeTextByTestId('team-member-add-search', 'Ada'));
        await waitForTestId(screen, 'team-member-add-search-unavailable');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-member-add-search-retry');
        expect(screen.getTextContent()).toContain('teams.errors.forbidden');
    });
});
