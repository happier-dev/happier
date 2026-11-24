/** @vitest-environment jsdom */
import * as React from 'react';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let directoryWidth = 390;
let browserLocks: ReturnType<typeof installWebLockManagerMock>;
const sdkRedirect = vi.hoisted(() => vi.fn());

// Native recycling is the boundary; keep the app's list normalization and adapters real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock();
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        Redirect: ({ href }: { href: string }) => { sdkRedirect(href); return null; },
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Import the real screen at collection, after the boundaries: a cold import inside a test body can outlast it.
const { TeamsDirectoryScreen } = await import('./TeamsDirectoryScreen');
const { HappierListDetailLayout } = await import('@happier-dev/plugin-ui/presentation');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const TEAMS_LIST_PATH = '/v1/teams/list';

async function renderDirectory() {
    const screen = await renderScreen(<HappierListDetailLayout list={null} detail={<TeamsDirectoryScreen />}
        minListWidth={320} minDetailWidth={360} preferredListRatio={0.3} testID="teams-directory-layout" />);
    // Supply the platform measurement to the real collection geometry owner.
    await act(async () => screen.findByTestId('teams-directory-layout')!.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: directoryWidth, height: 900 } },
    }));
    return screen;
}

async function memberHome(teamCount: number) {
    const home = await harness.addHome({
        name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
    });
    await harness.selectHomes([home]);
    harness.answer(home, ELIGIBILITY_PATH, {
        body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false, teamCreationPolicy: 'managed_only', administratorNames: [], showTeams: true },
    });
    harness.answer(home, TEAMS_LIST_PATH, {
        body: {
            items: Array.from({ length: teamCount }, (_, i) => teamSummaryFixture({ id: `team-${i}`, name: `Team ${i}` })),
            nextCursor: null,
        },
    });
    return home;
}

beforeEach(async () => {
    browserLocks = installWebLockManagerMock();
    sdkRedirect.mockClear();
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots'
    );
    const { resetHomeGovernanceEligibilityEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEligibilityEngine'
    );
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    directoryWidth = 390;
});

afterEach(async () => {
    await standardCleanup();
    browserLocks.restore();
});

describe('TeamsDirectoryScreen craft', () => {
    it('keeps a cold directory covered until its first list draws', async () => {
        const launch = startTestLaunchCurtain();
        const answer = createDeferred<void>();
        const home = await memberHome(1);
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-0' })], nextCursor: null },
            respondAfter: answer.promise,
        });
        const screen = await renderDirectory();
        const probe = await renderScreen(<CurtainProbe />);
        const curtain = () => probe.root.findByType('CurtainProbe').props.state;
        try {
            await vi.waitFor(() => expect(screen.findByTestId('teams-directory-loading')).not.toBeNull());
            launch.releaseShell();
            await launch.paint();
            expect(curtain()).toBe('up');
            answer.resolve();
            await vi.waitFor(() => expect(screen.findByTestId(`teams-row:${home}:team-0`)).not.toBeNull());
            await launch.paint();
            expect(curtain()).toBe('leaving');
        } finally {
            await screen.unmount();
            await probe.unmount();
            answer.resolve();
            launch.dispose();
        }
    });

    it('offers no search over an empty Teams list', async () => {
        await memberHome(0);
        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-empty'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-search');
    });

    it('offers the search once the list no longer fits at a glance, as the rail does', async () => {
        const home = await memberHome(9);
        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-row:${home}:team-8`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-directory-search');
    });

    it('beside the rail, keeps the detail loading frame mounted while landing on the first Team', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        const pending: { answer: () => void } = { answer: () => undefined };
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-0' })], nextCursor: null },
            respondAfter: new Promise<void>((resolve) => { pending.answer = resolve; }),
        });
        directoryWidth = 1440;

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(harness.requestsFor(TEAMS_LIST_PATH).length).toBeGreaterThan(0));
        const ids = () => collectRenderedTestIds(screen.tree.toJSON());
        const firstFrame = screen.findHostByTestId('workspace-destination-body-loading');
        expect(ids()).not.toContain('teams-directory-loading');
        pending.answer();
        await vi.waitFor(() => expect(sdkRedirect).toHaveBeenCalledWith(`/settings/teams/${home}/team-0`));
        expect(firstFrame).not.toBeNull();
        expect(screen.findHostByTestId('workspace-destination-body-loading')).toBe(firstFrame);
    });

    it('beside the rail, never calls a Home that failed to answer "No Teams yet"', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, TEAMS_LIST_PATH, { status: 503 });
        directoryWidth = 1440;

        const screen = await renderDirectory();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-home-unavailable:${home}`));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-directory-empty');
    });
});
