import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    Pressable: (props: Readonly<Record<string, unknown>>) => React.createElement('Pressable', props,
        typeof props.children === 'function' ? (props.children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : props.children as React.ReactNode),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const routerPush = vi.hoisted(() => vi.fn());
const routerDismissTo = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn(), dismissTo: routerDismissTo }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/settings/plugins/listing',
    Stack: Object.assign(() => null, { Screen: () => null }),
}));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', async () => ({
    MachineAdministrationTargetSelector: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('MachineAdministrationTargetSelector'),
}));

const listing: PluginMarketplaceCatalogEntry = {
    id: 'acme.tools', sourceId: 'marketplace:curated', sourceKind: 'curated', sourceTitle: 'Curated Marketplace',
    reviewStatus: 'approved', updatePolicy: 'allowed', publisher: { id: 'acme', displayName: 'Acme' },
    categories: ['agents'], contributions: ['actions'], links: { homepage: 'https://acme.test' }, executableRealms: ['daemon'],
    platforms: ['linux'], title: 'Acme tools', description: 'Inspect before installing.', version: '0.1.0',
    packageName: '@acme/tools', installable: true, registrySelectionOrigin: null,
};

/**
 * Legacy view-only coverage. Account/source acquisition and native locator/pin
 * contracts run through real owners in PluginRegistryDiscovery.composed.test.tsx.
 */
const state = vi.hoisted(() => ({
    value: null as null | Record<string, unknown>,
}));
vi.mock('../model/usePluginSettingsScreenState', () => ({ usePluginSettingsScreenState: () => state.value }));

function screenState(overrides: Record<string, unknown> = {}) {
    return {
        administrationTargetSelection: { state: { kind: 'selected' }, candidates: [] },
        administrationTargetLabel: { machine: 'Build Mac', server: 'Personal' },
        executionServerId: 'server-a', executionServerIdentityId: 'id-a', executionMachineId: 'machine-1',
        daemonOperationsAvailable: true,
        canRunDiscoverActions: true,
        loadingDiscover: false,
        unresolvedListing: false,
        discoverEntries: [listing],
        installedPluginById: new Map(),
        pluginProjectionById: {},
        isPluginActionInFlight: () => false,
        // No Install has created an approval yet; the listing presents none.
        pluginActionApproval: { approvalId: null, approvalPending: false, serverId: null, approvalSummary: null },
        routineOperationSettlement: null,
        refreshDiscover: vi.fn(),
        runCatalogAction: vi.fn(),
        ...overrides,
    };
}

// The screen's module graph (setup rows, Project scope, Connect sheet) is imported once, outside each case's budget.
let PluginListingScreen: typeof import('./PluginListingScreen').PluginListingScreen;
beforeAll(async () => {
    ({ PluginListingScreen } = await import('./PluginListingScreen'));
}, 600_000);

async function renderListing() {
    return renderSettingsView(<PluginListingScreen sourceId="marketplace:curated" pluginId="acme.tools" />);
}

describe('PluginListingScreen', () => {
    beforeEach(() => { routerPush.mockReset(); });
    afterEach(standardCleanup);

    it('shows the selected listing and installs it on the machine named in the header', async () => {
        state.value = screenState();
        const screen = await renderListing();
        const text = screen.getTextContent();
        expect(text).toContain('Acme tools');
        expect(text).toContain('Inspect before installing.');
        expect(text).toContain('Curated Marketplace');
        expect(text).toContain('Build Mac');
        await act(async () => { screen.pressByTestId('settings.plugins.listing.install'); });
        expect(state.value.runCatalogAction).toHaveBeenCalledWith({ method: 'install', pluginId: 'acme.tools', sourceId: 'marketplace:curated' });
    });

    it('offers Manage instead of Install once the plugin is installed', async () => {
        state.value = screenState({ installedPluginById: new Map([['acme.tools', {}]]) });
        const screen = await renderListing();
        expect(screen.findByTestId('settings.plugins.listing.install')).toBeNull();
        await act(async () => { screen.pressByTestId('settings.plugins.listing.manage'); });
        expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ params: { pluginId: 'acme.tools' } }));
        expect(state.value.runCatalogAction).not.toHaveBeenCalled();
    });

    it('says the listing is gone, with a retry, once the source answered without it', async () => {
        state.value = screenState({ discoverEntries: [] });
        const screen = await renderListing();
        expect(screen.findByTestId('settings.plugins.listing.missing')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.listing.install')).toBeNull();
    });

    it('keeps missing Account listings distinct from missing install machines', async () => {
        state.value = screenState({ discoverEntries: [], daemonOperationsAvailable: false, administrationTargetSelection: { state: { kind: 'unselected' }, candidates: [] } });
        const screen = await renderListing();
        expect(screen.findByTestId('settings.plugins.listing.missing')).not.toBeNull();
    });
    it('explains an offline machine with a retry instead of loading forever', async () => {
        const refreshPluginTruth = vi.fn();
        state.value = screenState({
            discoverEntries: [],
            daemonOperationsAvailable: false,
            administrationTargetSelection: { state: { kind: 'offline' }, candidates: [] },
            readOnlySnapshotNotice: { reason: 'disconnected' },
            refreshPluginTruth,
        });
        const screen = await renderListing();
        expect(screen.findByTestId('settings.plugins.listing.loading')).toBeNull();
        expect(screen.findByTestId('settings.plugins.listing.readOnlySnapshot')).not.toBeNull();
    });
    it('leads back along the history from its breadcrumb instead of stacking another Plugins page', async () => {
        state.value = screenState();
        const screen = await renderListing();
        await act(async () => { screen.pressByTestId('settings.plugins.listing.crumb.browse'); });
        expect(routerDismissTo).toHaveBeenCalledWith('/settings/plugins?view=browse');
        expect(routerPush).not.toHaveBeenCalled();
    });
});
