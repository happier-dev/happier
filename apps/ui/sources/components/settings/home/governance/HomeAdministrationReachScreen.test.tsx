import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Imported from their own testkit modules, as `HomeAdministrationEmailScreen.test.tsx` explains. */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeGovernanceProjectionFixture,
    homeReachabilityFixture,
    homeSettingEntryFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// Only the network and the device credential store are replaced; the Action executor, strict
// schemas, the registry codec and the page's decisions are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';
const REACH_GET = '/v1/home/reachability/get';
const IROH_SET = '/v1/home/reachability/iroh/set';
const PUBLIC_ADDRESS = 'HAPPIER_PUBLIC_SERVER_URL';

function reachSettings(revision = 2) {
    return homeSettingsProjectionFixture({
        revision,
        entries: [
            homeSettingEntryFixture(PUBLIC_ADDRESS),
            homeSettingEntryFixture('HAPPIER_WEBAPP_URL'),
        ],
    });
}

async function addHome(projection = homeGovernanceProjectionFixture()): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
    harness.answer(home, GOVERNANCE_PATH, { body: projection });
    return home;
}

async function renderReach(serverId: string) {
    const { HomeAdministrationReachScreen } = await import('./HomeAdministrationReachScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationReachScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-reach-iroh');
    });
    return screen;
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationReachScreen', () => {
    it('shows Retry when the companion read fails after settings succeed, and then renders the recovered reachability', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings() });
        harness.answer(home, REACH_GET, { status: 503, body: { error: 'temporarily_unavailable' } });
        const { HomeAdministrationReachScreen } = await import('./HomeAdministrationReachScreen');
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();
        const screen = await renderScreen(<HomeAdministrationReachScreen serverId={home} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-reach-retry')).not.toBeNull());
        expect(screen.findByTestId('home-reach-loading')).toBeNull();
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        await screen.pressByTestIdAsync('home-reach-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-reach-iroh')).not.toBeNull());
        expect(screen.findByTestId('home-reach-retry')).toBeNull();
    });

    it('asks before retiring direct connections and only then turns them off', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings() });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        harness.answer(home, IROH_SET, {
            body: homeReachabilityFixture({ iroh: { ...homeReachabilityFixture().iroh, mode: 'disabled', state: 'retired', endpointId: null } }),
        });
        const screen = await renderReach(home);
        const { Modal } = await import('@/modal');

        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await act(async () => {
            await screen.findByTestId('home-reach-iroh-switch')?.props.onValueChange(false);
        });
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(harness.requestsFor(IROH_SET)).toHaveLength(0);

        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => {
            await screen.findByTestId('home-reach-iroh-switch')?.props.onValueChange(false);
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(IROH_SET)).toHaveLength(1));
        expect(harness.requestsFor(IROH_SET)[0]?.input).toEqual({ mode: 'disabled' });
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-reach-iroh-switch')?.props.value).toBe(false));
    });

    it('names each deployment-fixed key once, as a code chip, never as caption text', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: homeSettingsProjectionFixture({
                revision: 2,
                entries: [
                    homeSettingEntryFixture(PUBLIC_ADDRESS, { value: 'https://home.deploy.example', source: 'deployment', fixed: true }),
                    homeSettingEntryFixture('HAPPIER_WEBAPP_URL'),
                ],
            }),
        });
        harness.answer(home, REACH_GET, {
            body: homeReachabilityFixture({
                publicAddress: { url: 'https://home.deploy.example', source: 'deployment' },
                iroh: { ...homeReachabilityFixture().iroh, modeFixed: true },
            }),
        });
        const screen = await renderReach(home);

        expect(screen.findByTestId('home-reach-public-address.fixed-key:0')?.children).toEqual([PUBLIC_ADDRESS]);
        expect(screen.findByTestId('home-reach-iroh.fixed-key:0')?.children).toEqual(['HAPPIER_HOME_IROH_MODE']);
        expect(screen.getTextContent()).not.toMatch(/fixedBy(Deployment)?\(/);
    });

    it('keeps the switch locked while no HTTPS address would remain', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings() });
        harness.answer(home, REACH_GET, {
            body: homeReachabilityFixture({ publicAddress: { url: null, source: 'none' }, hostAccess: null }),
        });
        const screen = await renderReach(home);
        expect(screen.findByTestId('home-reach-iroh-switch')?.props.disabled).toBe(true);
    });

    it('warns when the hosting computer publishes the Home to the internet', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings() });
        harness.answer(home, REACH_GET, {
            body: homeReachabilityFixture({
                publicAddress: { url: 'https://home.ts.net', source: 'inferred', inferredFrom: 'relay_access' },
                hostAccess: { method: 'tailscale_funnel', exposure: 'public', shareUrl: 'https://home.ts.net' },
            }),
        });
        const screen = await renderReach(home);
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-reach-exposure:internet');
    });

    it('refuses a plain http public address before asking the Home, and stores an https one', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings(2) });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture({ publicAddress: { url: null, source: 'none' } }) });
        harness.answer(home, SETTINGS_SET, { body: reachSettings(3) });
        const screen = await renderReach(home);

        await act(async () => {
            screen.pressByTestId('home-reach-public-address-change');
        });
        await act(async () => {
            screen.changeTextByTestId('home-reach-public-address-input', 'http://home.example.com');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-reach-public-address-save');
        });
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
        expect(screen.findByTestId('home-reach-public-address-input')).not.toBeNull();

        await act(async () => {
            screen.changeTextByTestId('home-reach-public-address-input', 'https://home.example.com');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('home-reach-public-address-save');
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(1));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({
            expectedRevision: 2,
            values: { [PUBLIC_ADDRESS]: 'https://home.example.com' },
        });
    });
});
