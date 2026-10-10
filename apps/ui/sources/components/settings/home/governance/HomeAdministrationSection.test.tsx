import * as React from 'react';
import { Text } from 'react-native';
import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';
import { act } from 'react-test-renderer';
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
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    // A phone: the one place Overview lists the console's pages (elsewhere its sidebar or menu does).
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = () => ({ width: 390, height: 844, scale: 1, fontScale: 1 });
        return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPush } }).module;
    },
});

// Only the network and the device credential store are replaced. The credential
// binding, scoped request authority, strict schemas, status classification,
// engine, store and view state below them are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';

function projection(overrides?: Partial<HomeGovernanceProjectionV1>): HomeGovernanceProjectionV1 {
    return homeGovernanceProjectionFixture(overrides);
}

async function renderOverview(serverId: string) {
    const { HomeConsoleShell } = await import('./HomeConsoleNavigation');
    const { HomeAdministrationOverviewScreen } = await import('./HomeAdministrationOverviewScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    return renderScreen(
        <HomeConsoleShell serverId={serverId} rail="console"><HomeAdministrationOverviewScreen serverId={serverId} /></HomeConsoleShell>,
    );
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    resetHomeGovernanceSnapshotsForTests();
    const { resetServerFeaturesClientForTests } = await import(
        '@/sync/api/capabilities/serverFeaturesClient'
    );
    resetServerFeaturesClientForTests();
    await harness.reset();
    routerPush.mockReset();
});

afterEach(() => {
    standardCleanup();
});

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

/** Every string rendered under the node carrying `testID`: what the person actually reads. */
function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

describe('HomeAdministrationSection', () => {
    it('keeps a pending Home Action reachable through its shared approval artifact', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.getCredentialsForServerUrl('https://home-a.example')).not.toBeNull();
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });
        const { HomeAdministrationSection } = await import('./HomeAdministrationSection');
        // Imported here, not at the top of the file: `Item` reaches the shared
        // scoped-request transport through `@/modal`, and a static import would
        // evaluate that module before `installHomeGovernanceBoundaries` replaces
        // its network leaf — leaving every Home read on the real network.
        const { Item } = await import('@/components/ui/lists/Item');

        const screen = await renderScreen(
            <HomeAdministrationSection serverId={home} title="Home">
                {(context) => (
                    <Item
                        testID="request-home-approval"
                        title="Request approval"
                        disabled={!context.mutationsAvailable}
                        onPress={context.mutationsAvailable
                            ? () => context.requestApproval?.('approval-home-1')
                            : undefined}
                    />
                )}
            </HomeAdministrationSection>,
        );
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('request-home-approval'));

        screen.pressByTestId('request-home-approval');
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-approval'));
        expect(screen.findByTestId('request-home-approval')?.props.accessibilityState?.disabled).toBe(true);
        screen.pressByTestId('home-admin-approval.action');

        expect(routerPush).toHaveBeenCalledWith(
            `/inbox/approvals/approval-home-1?serverId=${encodeURIComponent(home)}`,
        );
    });

    it('says the device is signed out of a Home rather than claiming the Home refused', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: null });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-signed-out');
        });
        // Nothing is asked of a Home this device holds no credential for.
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });

    it('reports a Home this device has never saved as unknown', async () => {
        const screen = await renderOverview('home-never-added');
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-unknown-home');
        });
    });

    it('reads the exact Home as the Account that Home is signed in as', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
        });
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });

        const [request] = harness.requestsFor(GOVERNANCE_PATH);
        expect(request?.serverId).toBe(home);
        expect(request?.serverUrl).toBe('https://home-a.example');
        // The bearer the scoped authority attached is that Home's own credential.
        expect(request?.token).toContain('.');
    });

    it('offers a retry when the Home could not be reached and nothing was retained', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, { status: 500, body: { error: 'boom' } });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-unavailable');
        });
        expect(screen.findByTestId('home-admin-unavailable')?.props.accessibilityLiveRegion).toBe('assertive');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-unavailable-action');

        harness.answer(home, GOVERNANCE_PATH, { body: projection() });
        const before = harness.requestsFor(GOVERNANCE_PATH).length;
        await screen.pressByTestIdAsync('home-admin-unavailable-action');

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(before);
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });
    });

    it('does not offer a retry for a settled refusal by the Home', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            status: 403,
            body: { error: 'home_governance_forbidden' },
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-unavailable');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-unavailable-action');
    });

    it('offers the code claim for the typed ownerless-Home response without rendering administration data', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            status: 409,
            body: { error: 'home_governance_setup_required' },
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-claim-empty');
        });
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('home-claim-code-input');
        // Not this device's Personal Home: no hosting-desktop claim is offered.
        expect(ids).not.toContain('home-claim-host');
        expect(ids).not.toContain('home-admin-viewer-role');
        expect(ids).not.toContain('home-admin-people');
        expect(ids).not.toContain('home-admin-policies');
        // The page is about this Home and the one thing to do on it (lab `hcClaim-N`): its name, then the claim.
        const header = textUnder(screen.findByTestId('home-admin-page-header'));
        expect(header).toContain('Home A');
        expect(header).toContain('homeGovernance.claim.pageDescription');
        expect(header).not.toContain('homeGovernance.title');
    });

    it('names the ownerless Home on a phone too, where the navigation header already carries a title', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, { status: 409, body: { error: 'home_governance_setup_required' } });
        const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
        const { HomeAdministrationOverviewScreen } = await import('./HomeAdministrationOverviewScreen');
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();

        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle><HomeAdministrationOverviewScreen serverId={home} /></NavigationTitleChromeProvider>,
        );
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-claim-empty');
        });
        // Lab `hcClaim-P`: the phone header is the way back; the page is titled with the Home.
        expect(textUnder(screen.findByTestId('home-admin-page-header'))).toContain('Home A');
    });

    it('reports a Home whose answer does not satisfy the contract as unavailable', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        // A 200 whose body is not a governance projection is not a projection.
        harness.answer(home, GOVERNANCE_PATH, { body: { viewer: { accountId: '' } } });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-unavailable');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-viewer-role');
    });

    it('keeps the last known Home on screen and explains it once the Home stops answering', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
        });
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });

        const { applyHomeGovernanceFailure } = await import(
            '@/sync/store/home/governance/homeGovernanceSnapshots'
        );
        act(() => {
            applyHomeGovernanceFailure({
                scope: { serverId: home, accountId: 'account-ada' },
                error: { kind: 'unreachable', retryable: true },
            });
        });

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-stale');
        });
        expect(screen.findByTestId('home-admin-stale')?.props.accessibilityLiveRegion).toBe('polite');
        // Retained content must say how old it is, not only that it is old.
        expect(screen.getTextContent()).toContain('homeGovernance.lastUpdated');
        // The administrator keeps reading the Home they were looking at.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
    });

    it('shows no warning while a Home that answered is refreshing, only a quiet updating note', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
        });
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });

        // A page with the plain console header (the Overview renders its own entity header).
        const { HomeAdministrationSection } = await import('./HomeAdministrationSection');
        const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        resetHomeGovernanceEngineForTests();
        const screen = await renderScreen(
            <HomeAdministrationSection serverId={home} title="Data">
                {() => <Text testID="home-admin-test-page">page</Text>}
            </HomeAdministrationSection>,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-test-page');
        }, { timeout: 15_000 });

        // The next answer is held so the refresh stays in flight while the page is inspected.
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        harness.answer(home, GOVERNANCE_PATH, { body: projection(), respondAfter: held });
        const { invalidateHomeGovernanceSnapshot } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
        const { refreshHomeGovernanceSnapshot } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
        // An Account-change wake, then the refetch it causes, over a Home that answered.
        let refresh!: Promise<void>;
        act(() => {
            invalidateHomeGovernanceSnapshot({ serverId: home, accountId: 'account-ada' });
            refresh = refreshHomeGovernanceSnapshot({ serverId: home, accountId: 'account-ada' });
        });

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-updating');
        }, { timeout: 15_000 });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-stale');
        expect(screen.getTextContent()).not.toContain('homeGovernance.staleNotice');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-test-page');
        release();
        await act(async () => { await refresh; });
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-updating');
        }, { timeout: 15_000 });
        // A cold import of the whole console runs close to the default case budget on this runner.
    }, 180_000);

    it('claims the exact ownerless Home it was opened for and becomes its console', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        const otherHome = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            active: false,
        });
        harness.answer(home, GOVERNANCE_PATH, { status: 409, body: { error: 'home_governance_setup_required' } });
        harness.answer(home, '/v1/home/governance/claim', { body: { status: 'claimed' } });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-claim-code-input');
        });

        // Focus moves elsewhere while this Home's administration stays open.
        await act(async () => {
            await setActiveServerId(otherHome, { scope: 'device' });
        });
        expect(getActiveServerSnapshot().serverId).toBe(otherHome);
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });
        await act(async () => {
            screen.changeTextByTestId('home-claim-code-input', 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST');
        });
        await screen.pressByTestIdAsync('home-claim-submit');

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-claim-empty');
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });
        expect(harness.requestsFor('/v1/home/governance/claim').every((request) => request.serverId === home)).toBe(true);
        expect(harness.requestsFor(GOVERNANCE_PATH).every((request) => request.serverId === home)).toBe(true);
    });

    it('opens Team administration for the exact Home it is administering', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, { body: projection() });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-teams-link');
        });

        screen.pressByTestId('home-admin-teams-link');
        // The Home's own id is in the destination, so this never resolves to the
        // focused Home or to the viewer's own membership list.
        expect(routerPush).toHaveBeenCalledWith(`/settings/home/${home}/teams`);
    });

    it('says Teams are off on this Home and still opens Teams, whose page states why', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, { body: projection({ teamsEnabled: false }) });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-teams-link');
        });

        const teamsRow = screen.root.findAll((node) => node.props.testID === 'home-admin-teams-link' && typeof node.props.subtitle === 'string')[0];
        expect(teamsRow?.props.subtitle).toBe('homeGovernance.teamsDisabled');
        screen.pressByTestId('home-admin-teams-link');
        expect(routerPush).toHaveBeenCalledWith(`/settings/home/${home}/teams`);
    });

    it('omits Team administration entirely from a viewer who may not govern Teams', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            body: projection({
                capabilities: { ...projection().capabilities, manageAllTeams: false },
            }),
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-teams-link');
    });

    it('offers Email, Features, Data and Activity to an admin who may read administration but not change Home settings', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            body: projection({
                viewer: { accountId: 'account-ada', homeRole: 'admin', status: 'active' },
                capabilities: { ...projection().capabilities, manageHomeSettings: false },
            }),
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-email-link');
        });

        screen.pressByTestId('home-admin-email-link');
        screen.pressByTestId('home-admin-features-link');
        screen.pressByTestId('home-admin-data-link');
        screen.pressByTestId('home-admin-activity-link');
        expect(routerPush.mock.calls).toEqual([
            [`/settings/home/${home}/email`],
            [`/settings/home/${home}/features`],
            [`/settings/home/${home}/data`],
            [`/settings/home/${home}/activity`],
        ]);
    });

    it('omits Email and Activity from a viewer who may not read administration', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
        harness.answer(home, GOVERNANCE_PATH, {
            body: projection({
                capabilities: { ...projection().capabilities, viewAdministration: false, manageHomeSettings: false },
            }),
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-admin-viewer-role');
        });
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('home-admin-email-link');
        expect(ids).not.toContain('home-admin-features-link');
        expect(ids).not.toContain('home-admin-data-link');
        expect(ids).not.toContain('home-admin-activity-link');
    });
});
