import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported from their own testkit modules, not the barrel (see HomeAdministrationHomesScreen.test.tsx).
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

const routerReplace = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({ entry: 'settings' }),
        usePathname: () => '/settings/home',
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Finish the real screen graph at collection, after its network and native boundaries.
const { HomeAdministrationHomesScreen } = await import('./HomeAdministrationHomesScreen');

const GOVERNANCE_PATH = '/v1/home/governance/get';

function setEndpointStatus(storage: { getState: () => { setEndpointConnectivity: (snapshot: never) => void } }, status: 'online' | 'offline') {
    storage.getState().setEndpointConnectivity({
        status, reason: null, attempt: 0, nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null,
    } as never);
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
});

afterEach(async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().resetEndpointConnectivity();
    standardCleanup();
});

describe('HomeAdministrationHomesScreen when the Home is unreachable', () => {
    it('says the Home is not answering, with Retry, instead of loading forever, and Retry reads again once it answers', async () => {
        const home = await harness.addHome({ name: 'Studio', serverUrl: 'https://studio.example' });
        await harness.selectHomes([home]);
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        // The connection supervisor has concluded this (active) Home is not answering.
        const { storage } = await import('@/sync/domains/state/storageStore');
        setEndpointStatus(storage as never, 'offline');

        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();
        const screen = await renderScreen(<HomeAdministrationHomesScreen />);

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`home-admin-home-unresolved:${home}-retry`);
        });
        // Nothing was sent to a Home known not to answer.
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);

        setEndpointStatus(storage as never, 'online');
        await screen.pressByTestIdAsync(`home-admin-home-unresolved:${home}-retry`);
        // Once it answers it is the one Home to administer, so its console opens.
        await waitForHomeGovernance(() => {
            expect(routerReplace).toHaveBeenCalledWith(`/settings/home/${home}`);
        });
    });
});
