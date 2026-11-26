import * as React from 'react';
import { teamErrorHttpStatusV1 } from '@happier-dev/protocol/teams';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, homeAccountPickerRowFixture, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addMemberRouterPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: addMemberRouterPush, replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const ACCOUNT_SEARCH_PATH = '/v1/home/accounts/search';
const MEMBER_ADD_PATH = '/v1/teams/members/add';
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
    addMemberRouterPush.mockClear();
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
        expect(screen.getTextContent()).toContain('errors.permissionDenied');
    });
});

describe('Team roster admission refusal', () => {
    it.each([
        { code: 'invalid_team_input', message: 'homeGovernance.invalidRead', destination: /\/team-1\/members$/u },
        { code: 'teams_unavailable', message: 'teams.unavailable.disabled' },
        { code: 'team_not_found', message: 'teams.errors.notFound', destination: '/settings/teams' },
        { code: 'team_archived', message: 'teams.errors.archived', destination: /\/team-1\/settings$/u },
        { code: 'team_forbidden', message: 'teams.errors.forbidden' },
        { code: 'team_forbidden', details: { reason: 'legacy_home_credential' }, message: 'teams.errors.signInOutdated', destination: '/settings/account' },
        { code: 'team_authentication_required', message: 'teams.errors.authenticationRequired', destination: '/teams/team-1/sign-in' },
        { code: 'team_authentication_unavailable', message: 'teams.credentials.externalApi.authenticationUnavailable' },
        { code: 'account_not_found', message: 'homeGovernance.errorAccountNotFound' },
        { code: 'account_ineligible', message: 'teams.members.accountInactive' },
        { code: 'membership_not_found', message: 'teams.members.memberUnavailable', destination: /\/team-1\/members$/u },
    ] as const)('presents $code and permits only its recovery', async (refusal) => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
        });
        harness.answer(serverId, ACCOUNT_SEARCH_PATH, {
            body: { accounts: [homeAccountPickerRowFixture('account-grace', 'Grace')] },
        });
        harness.answer(serverId, MEMBER_ADD_PATH, {
            status: teamErrorHttpStatusV1(refusal.code),
            body: { error: refusal.code, ...('details' in refusal ? { details: refusal.details } : {}) },
        });

        const screen = await renderAddMember(serverId);
        await act(() => screen.changeTextByTestId('team-member-add-search', 'Grace'));
        await waitForTestId(screen, 'team-member-add-candidate:account-grace');
        await screen.pressByTestIdAsync('team-member-add-candidate:account-grace');
        await screen.pressByTestIdAsync('team-member-add-submit');
        await vi.waitFor(() => expect(screen.getTextContent().split(refusal.message)).toHaveLength(2));
        const submit = screen.findByTestId('team-member-add-submit');
        expect(!submit || submit.props.disabled || submit.props.accessibilityState?.disabled).toBeTruthy();
        if ('destination' in refusal) {
            await screen.pressByTestIdAsync('team-member-add-refusal-action');
            const path = new URL(addMemberRouterPush.mock.lastCall?.[0] ?? '', 'https://app.example').pathname;
            expect(path).toMatch(refusal.destination);
        } else {
            expect(screen.findByTestId('team-member-add-refusal-action')).toBeNull();
        }
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(1);
    });
});
