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

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

// Native file APIs are a platform boundary, loaded by the Reach host controls.
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock().module;
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
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
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests } = await import('@/sync/store/home/governance/homeSettingsSnapshots');
const { HomeAdministrationReachScreen } = await import('./HomeAdministrationReachScreen');

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';
const REACH_GET = '/v1/home/reachability/get';
const IROH_SET = '/v1/home/reachability/iroh/set';
const PUBLIC_ADDRESS = 'HAPPIER_PUBLIC_SERVER_URL';
const SUBPATH_LINKS = 'HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH';

function reachSettings(revision = 2) {
    return homeSettingsProjectionFixture({
        revision,
        entries: [
            homeSettingEntryFixture(PUBLIC_ADDRESS),
            homeSettingEntryFixture('HAPPIER_WEBAPP_URL'),
            homeSettingEntryFixture(SUBPATH_LINKS, {
                value: false,
                declaration: { type: 'boolean', default: false, section: 'reach', group: 'publicLinks' },
            }),
        ],
    });
}

async function addHome(projection = homeGovernanceProjectionFixture()): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', currentAccount: true });
    harness.answer(home, GOVERNANCE_PATH, { body: projection });
    return home;
}

async function renderReach(serverId: string) {
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationReachScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-reach-iroh');
    });
    return screen;
}

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    // Modal is the host boundary. Reuse this fixture's person-choice controller
    // for both ordinary confirmations and the real Action review dialog.
    vi.mocked(Modal.show).mockReset().mockImplementation(config => {
        if (config.chrome?.kind === 'card' && config.chrome.testID === 'actions.confirmation-review.modal') {
            const props = config.props as { onAnswer(confirmed: boolean): void };
            queueMicrotask(() => { void Modal.confirm('Action review', '').then(props.onAnswer); });
        }
        return 'action-review';
    });
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationReachScreen', () => {
    it.each(['owner', 'admin'] as const)('offers public-link configuration only to the Home %s', async (role) => {
        const projection = homeGovernanceProjectionFixture();
        const home = await addHome({
            ...projection,
            viewer: { ...projection.viewer, homeRole: role },
            capabilities: { ...projection.capabilities, manageHomeSettings: role === 'owner' },
        });
        const { SessionPublicLinkCard } = await import('@/components/sessions/collaboration/SessionPublicLinkSection');
        const { SessionAccessApiError } = await import('@/sync/api/session/sessionAccessApi');
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();
        const screen = await renderScreen(<SessionPublicLinkCard
            testID="public-link-card" configurationScope={{ serverId: home, accountId: `account-${home}` }}
            publicShare={null} serverUrl={null} loading={false} loaded failed={false} readOnly={false}
            pendingApproval={false} onRetry={() => {}} onOpenPendingApproval={() => {}}
            onCreate={async () => { throw new SessionAccessApiError('public_share_isolation_unavailable', 503); }}
            onDelete={async () => {}}
        />);
        await screen.pressByTestIdAsync('session-public-link-create');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        await waitForHomeGovernance(() => expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(1));
        const { getHomeGovernanceSnapshot } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
        await waitForHomeGovernance(() => expect(getHomeGovernanceSnapshot({ serverId: home, accountId: `account-${home}` })?.data)
            .toMatchObject({ capabilities: { manageHomeSettings: role === 'owner' } }));
        if (role === 'owner') {
            expect(screen.findByTestId('session-public-link-configure')).not.toBeNull();
        } else {
            expect(screen.findByTestId('session-public-link-configure')).toBeNull();
        }
    });

    it('lets the owner enable public hostname links through the revision-safe Home writer', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings(2) });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        const saved = reachSettings(3);
        saved.entries = saved.entries.map(entry => entry.key === SUBPATH_LINKS ? { ...entry, value: true, source: 'home' as const } : entry);
        harness.answer(home, SETTINGS_SET, { body: saved });
        const screen = await renderReach(home);
        expect(screen.findByTestId('home-reach-public-subpath.switch')?.props.value).toBe(false);
        await act(async () => {
            screen.findByTestId('home-reach-public-subpath.switch')?.props.onValueChange(true);
        });
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-reach-public-subpath.switch')?.props.value).toBe(true));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({ expectedRevision: 2, values: { [SUBPATH_LINKS]: true } });
    });

    it.each(['admin', 'deployment'] as const)('shows public hostname permission read-only for %s', async (lock) => {
        const projection = homeGovernanceProjectionFixture();
        const home = await addHome(lock === 'admin' ? {
            ...projection,
            viewer: { ...projection.viewer, homeRole: 'admin' },
            capabilities: { ...projection.capabilities, manageHomeSettings: false },
        } : projection);
        const settings = reachSettings();
        if (lock === 'deployment') Object.assign(settings.entries.find(entry => entry.key === SUBPATH_LINKS)!, { fixed: true, source: 'deployment' });
        harness.answer(home, SETTINGS_GET, { body: settings });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        const screen = await renderReach(home);
        expect(screen.findByTestId('home-reach-public-subpath')).not.toBeNull();
        expect(screen.findByTestId('home-reach-public-subpath.switch')).toBeNull();
        if (lock === 'deployment') expect(screen.findByTestId('home-reach-public-subpath.fixed-key:0')?.children).toEqual([SUBPATH_LINKS]);
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
    });

    it('reloads a conflicting public hostname permission and keeps the refusal inline', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: reachSettings(2) });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        harness.answer(home, SETTINGS_SET, { status: 409, body: { error: 'home_settings_revision_conflict' } });
        const screen = await renderReach(home);
        const current = reachSettings(3);
        harness.answer(home, SETTINGS_GET, { body: current });
        await act(async () => { screen.findByTestId('home-reach-public-subpath.switch')?.props.onValueChange(true); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-reach-public-subpath-error')).not.toBeNull());
        expect(screen.findByTestId('home-reach-public-subpath.switch')?.props.value).toBe(false);
        expect(harness.requestsFor(SETTINGS_GET).length).toBeGreaterThan(1);
    });

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

    it('confirms an explicit Ask policy locally before retiring direct connections', async () => {
        const home = await addHome();
        await harness.requireUiApproval(home, 'home.reachability.iroh.set');
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
        expect(harness.artifacts(home).list()).toHaveLength(0);

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

    it('edits custom relay servers entry by entry, naming a refused entry before asking the Home', async () => {
        const RELAY_POLICY = 'HAPPIER_IROH_RELAY_POLICY';
        const RELAY_URLS = 'HAPPIER_IROH_RELAY_URLS';
        const withRelays = (revision: number, urls: string[] | null) => {
            const settings = reachSettings(revision);
            settings.entries = [
                ...settings.entries,
                homeSettingEntryFixture(RELAY_POLICY, {
                    value: 'automatic',
                    apply: 'restart',
                    declaration: { type: 'enum', section: 'reach', group: 'iroh', default: 'automatic', bounds: { values: ['automatic', 'disabled'] } },
                }),
                homeSettingEntryFixture(RELAY_URLS, {
                    value: urls,
                    source: urls ? 'home' : 'default',
                    apply: 'restart',
                    declaration: { type: 'list', section: 'reach', group: 'iroh', bounds: { scheme: 'https' } },
                }),
            ];
            return settings;
        };
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: withRelays(2, null) });
        harness.answer(home, REACH_GET, { body: homeReachabilityFixture() });
        harness.answer(home, SETTINGS_SET, { body: withRelays(3, ['https://relay.northwind.example']) });
        const screen = await renderReach(home);

        await act(async () => { screen.pressByTestId('home-reach-relay-servers.list.add'); });
        await act(async () => { screen.changeTextByTestId('home-reach-relay-servers.list.item.0', 'relay.northwind.example'); });
        await act(async () => { screen.findByTestId('home-reach-relay-servers.list.item.0')?.props.onBlur?.(); });
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
        expect(screen.findByTestId('home-reach-relay-servers.list.item.0.error')).not.toBeNull();

        await act(async () => { screen.changeTextByTestId('home-reach-relay-servers.list.item.0', 'https://relay.northwind.example'); });
        await act(async () => { screen.findByTestId('home-reach-relay-servers.list.item.0')?.props.onBlur?.(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(1));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({
            expectedRevision: 2,
            values: { [RELAY_URLS]: ['https://relay.northwind.example'] },
        });
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
