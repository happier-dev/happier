import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit`
 * barrel. The barrel re-exports `fixtures/agentCatalogFixtures`, whose
 * production projection reaches `@/sync/runtime/orchestration/connectionManager`
 * and, through it, `@/sync/http/client` and the reachability fetch. Evaluating
 * that graph on this file's first import binds the real transports and freezes
 * the applied active Home to the built-in default *before*
 * `installHomeGovernanceBoundaries` can install either boundary, so every Home
 * request leaves the harness and the screen never settles. This is the same
 * rule the harness states for its own late imports.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
/** How the list was reached: `entry: 'settings'` from the Settings navigation, nothing for the list itself. */
const routeParams = vi.hoisted(() => ({ value: { entry: 'settings' } as Record<string, string> }));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: routerPush, replace: routerReplace, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => routeParams.value,
        usePathname: () => '/settings/home',
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Finish the real screen graph at collection, after its network and native boundaries.
const { HomeAdministrationHomesScreen } = await import('./HomeAdministrationHomesScreen');

const GOVERNANCE_PATH = '/v1/home/governance/get';

async function renderHomes() {
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    return renderScreen(<HomeAdministrationHomesScreen />);
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
    routerReplace.mockReset();
    routeParams.value = { entry: 'settings' };
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationHomesScreen', () => {
    it('offers each Home that admits this account and opens it by its own id', async () => {
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example' });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(homeB, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home:${homeB}`);
        });

        // Each Home was asked as the Account this device holds there.
        expect(new Set(harness.requestsFor(GOVERNANCE_PATH).map((request) => request.serverId)))
            .toEqual(new Set([homeA, homeB]));

        screen.pressByTestId(`home-admin-home:${homeB}`);
        expect(routerPush).toHaveBeenCalledWith(`/settings/home/${homeB}`);
        // Two Homes to choose from: the list stays.
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('keeps the list for one Home when the list itself is opened (All Homes, a link to it, back)', async () => {
        routeParams.value = {};
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home:${home}`);
        });
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('waits for a Home still being read before opening the only one answered so far', async () => {
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example' });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeB, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(homeA, GOVERNANCE_PATH, { status: 502, body: { error: 'bad gateway' } });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home-unresolved:${homeA}`);
        });
        // A Home that is not answering may be administrable too: the choice stays with the person.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home:${homeB}`);
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('leaves out a Home this account cannot administer, and opens the one capable Home directly', async () => {
        const homeA = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        const homeB = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example' });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({
                viewer: { accountId: 'account-ada', homeRole: 'member', status: 'active' },
                capabilities: {
                    ...homeGovernanceProjectionFixture().capabilities,
                    viewAdministration: false,
                },
            }),
        });
        harness.answer(homeB, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderHomes();
        // One Home to administer is nothing to choose: its console opens in place of a one-entry list.
        await waitForHomeGovernance(() => {
            expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${homeB}`);
        });
        expect(routerReplace).toHaveBeenCalledTimes(1);
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain(`home-admin-home:${homeA}`);
        expect(ids).not.toContain(`home-admin-home-unresolved:${homeA}`);
    });

    it('offers an ownerless Home so its state can be read, without a claim action', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({
                viewer: { accountId: 'account-ada', homeRole: 'member', status: 'active' },
                capabilities: {
                    ...homeGovernanceProjectionFixture().capabilities,
                    viewAdministration: false,
                },
                setupState: 'setup_required',
                activeOwnerCount: 0,
            }),
        });

        const screen = await renderHomes();
        // Offered, so as the only Home it opens; the list itself carries no claim action.
        await waitForHomeGovernance(() => {
            expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${home}`);
        });
        expect(collectRenderedTestIds(screen.tree.toJSON()).some((id) => id.includes('claim'))).toBe(false);
    });

    it('explains a Home this device is signed out of instead of offering it', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: null,
        });
        await harness.selectHomes([home]);

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .toContain(`home-admin-home-unresolved:${home}`);
        });

        // Listed with its reason, but not offered: there is nothing to open on
        // a Home this device holds no credential for, and nothing is asked of it.
        const row = screen.findByTestId(`home-admin-home-unresolved:${home}`);
        expect(row?.props?.onPress ?? row?.props?.onClick).toBeUndefined();
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('keeps an unreachable Home listed as unresolved rather than dropping it', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { status: 502, body: { error: 'bad gateway' } });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .toContain(`home-admin-home-unresolved:${home}`);
        });
    });

    it('lists an unanswered Home among the Homes, in one state, and retries a Home that is not answering', async () => {
        const admitted = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        const down = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example' });
        await harness.selectHomes([admitted, down]);
        harness.answer(admitted, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(down, GOVERNANCE_PATH, { status: 502, body: { error: 'bad gateway' } });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).toContain(`home-admin-home:${admitted}`);
            expect(ids).toContain(`home-admin-home-unresolved:${down}`);
        });

        // One section: a Home that has not answered is not a second, contradictory heading.
        expect(screen.getTextContent()).not.toContain('homeGovernance.homesUnresolved');
        // One state per row: it says which Home is not answering, with Retry, and is no longer busy.
        expect(screen.getTextContent()).toContain('homeGovernance.homeNotAnswering(home=Home B)');
        expect(screen.findHostByTestId(`home-admin-home-unresolved:${down}`)?.props.accessibilityState?.busy).not.toBe(true);

        const before = harness.requestsFor(GOVERNANCE_PATH).filter((request) => request.serverId === down).length;
        harness.answer(down, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        await screen.pressByTestIdAsync(`home-admin-home-unresolved:${down}-retry`);
        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(GOVERNANCE_PATH).filter((request) => request.serverId === down).length)
                .toBeGreaterThan(before);
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home:${down}`);
        });
    });

    it('stops offering a Home that refuses after it had already answered', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
        });
        const sibling = await harness.addHome({ name: 'Home B', serverUrl: 'https://home-b.example' });
        await harness.selectHomes([home, sibling]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(sibling, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home:${home}`);
        });

        const { applyHomeGovernanceFailure } = await import(
            '@/sync/store/home/governance/homeGovernanceSnapshots'
        );
        const { act } = await import('react-test-renderer');
        act(() => {
            applyHomeGovernanceFailure({
                scope: { serverId: home, accountId: 'account-ada' },
                error: { kind: 'forbidden', retryable: false },
            });
        });

        // Retention keeps an offline Home readable; it must not outlive the Home
        // saying this account may not administer it.
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON()))
                .not.toContain(`home-admin-home:${home}`);
        });
        // What is left is one Home to administer, which opens.
        expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${sibling}`);
    });

    it('says so plainly when no selected Home grants administration', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, {
            body: homeGovernanceProjectionFixture({
                viewer: { accountId: 'account-ada', homeRole: 'member', status: 'active' },
                capabilities: {
                    ...homeGovernanceProjectionFixture().capabilities,
                    viewAdministration: false,
                },
            }),
        });

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-homes-none');
        });
    });

    it('claims nothing about a Home the selection points at but this device never saved', async () => {
        // The Home-view selection can name a Home this device no longer holds a
        // profile for. That is not a Home refusing administration and not an
        // empty device: it is unresolved, and it is asked nothing.
        await harness.selectHomes(['home-that-was-removed']);

        const screen = await renderHomes();
        await waitForHomeGovernance(() => {
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids.some((id) => id.startsWith('home-admin-home'))).toBe(true);
        });
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('home-admin-home:home-that-was-removed');
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });
});
