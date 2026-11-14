import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamGroupFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: routerReplace }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { TeamGroupCreateScreen } = await import('./TeamGroupCreateScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const GROUP_CREATE_PATH = '/v1/teams/groups/create';
const PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account/private-labels/recipient-census';

async function renderCreate(serverId: string) {
    return renderScreen(<TeamGroupCreateScreen serverId={serverId} teamId="team-1" />);
}

async function addHome(granted: Readonly<{ manageGroups: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture(granted) }),
    });
    harness.answer(serverId, PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, {
        body: { contentEncryptionMode: 'plain', recipients: [] },
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderCreate>>,
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
    routerReplace.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamGroupCreateScreen', () => {
    it('UX keeps a new Group draft when navigation is canceled', async () => {
        const serverId = await addHome({ manageGroups: true });
        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Unfinished'));
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockImplementation((_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const leave = vi.fn();
        let departed: boolean | undefined;
        await act(async () => { departed = await runGuardedNavigation(leave); });
        expect(departed).toBe(false);
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-group-create-name')?.props.value).toBe('Unfinished');
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(0);
    });

    it('starts only one create when activated twice before the busy state renders', async () => {
        let releaseCreate = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseCreate = resolve; });
        const serverId = await addHome({ manageGroups: true });
        harness.answer(serverId, GROUP_CREATE_PATH, {
            body: teamGroupFixture({ id: 'group-new', name: 'Design', memberCount: 0 }),
            respondAfter,
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        act(() => {
            screen.pressByTestId('team-group-create-submit');
            screen.pressByTestId('team-group-create-submit');
        });

        await vi.waitFor(() => expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(1));
        await act(async () => releaseCreate());
    });

    it('creates the Group on its own Home and opens the Group it produced', async () => {
        const serverId = await addHome({ manageGroups: true });
        harness.answer(serverId, GROUP_CREATE_PATH, {
            body: teamGroupFixture({ id: 'group-new', name: 'Design', memberCount: 0 }),
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        await screen.pressByTestIdAsync('team-group-create-submit');

        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(1);
        });
        const request = harness.requestsFor(GROUP_CREATE_PATH)[0];
        expect(request?.serverId).toBe(serverId);
        expect(request?.input).toMatchObject({
            teamId: 'team-1',
            groupId: expect.any(String),
            name: { content: { t: 'plain', v: 'Design' }, recipients: [] },
        });
        // The retry identity travels with the submission so a lost response
        // cannot produce two Groups with the same intent.
        expect((request?.input as { requestKey?: string }).requestKey).toBeTruthy();
        expect(routerReplace)
            .toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/groups/group-new`);
    });

    it('says an overlong description is the problem instead of a Create that does nothing', async () => {
        // The canonical Group description rule is 500 characters. A valid name
        // plus an overlong description used to leave Create enabled and produce
        // no request, no notice and no focus change.
        const serverId = await addHome({ manageGroups: true });
        harness.answer(serverId, GROUP_CREATE_PATH, {
            body: teamGroupFixture({ id: 'group-new', name: 'Design', memberCount: 0 }),
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        act(() => screen.changeTextByTestId('team-group-create-description', 'd'.repeat(501)));

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.errors.invalidDescription');
        });
        expect(screen.findByTestId('team-group-create-submit')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-group-create-submit');
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(0);
        // The text is preserved, and correcting it makes the same submission work.
        expect(screen.findByTestId('team-group-create-description')?.props.value)
            .toBe('d'.repeat(501));

        act(() => screen.changeTextByTestId('team-group-create-description', 'd'.repeat(500)));
        await vi.waitFor(() => {
            expect(screen.findByTestId('team-group-create-submit')?.props.disabled).toBe(false);
        });
        await screen.pressByTestIdAsync('team-group-create-submit');
        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(1);
        });
    });

    it('keeps the typed form when the Home refuses a create after sealing', async () => {
        const serverId = await addHome({ manageGroups: true });
        harness.answer(serverId, GROUP_CREATE_PATH, {
            status: 409,
            body: { error: 'team_conflict' },
        });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        await screen.pressByTestIdAsync('team-group-create-submit');

        // A rejected submission is never retyped, and no navigation happened.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-create-name');
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('explains a viewer without Group authority and creates nothing', async () => {
        const serverId = await addHome({ manageGroups: false });

        const screen = await renderCreate(serverId);
        await waitForTestId(screen, 'team-group-create-forbidden');

        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(0);
    });
});
