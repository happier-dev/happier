import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createMachineAdministrationTargetSelectionMock,
    createProviderSettingsHarness,
    flushHookEffects,
    installMachineAdministrationTargetSelectionBoundary,
    installProviderSettingsRpcBoundary,
    renderInCollectionLayout,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const initialStorage = storage.getState();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    enabled: true,
    providerDecision: {
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
    } as null | {
        state: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
        blockedBy: 'client' | 'build_policy' | 'local_policy' | 'server' | 'daemon' | 'scope' | 'dependency' | null;
        blockerCode: string;
    },
    localDiscoveryEnabled: true,
    query: null as null | Record<string, unknown>,
    teamCredentialCatalog: {
        resources: [] as Array<Record<string, unknown>>,
        teamNameById: {} as Record<string, string>,
        homeNameByTeamId: {} as Record<string, string>,
        currentResourceKeys: new Set<string>(),
        current: true,
    },
}));
const run = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    focusEffects: [] as Array<() => void | (() => void)>,
    pathname: '/settings/providers',
    params: {} as Record<string, string>,
    navigatorMounts: 0,
    focused: true,
    focusListeners: new Set<() => void>(),
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const administrationTarget = createMachineAdministrationTargetSelectionMock();
installMachineAdministrationTargetSelectionBoundary(administrationTarget);
// The composed layout must exercise the real target control, including unavailable states.
vi.doUnmock('@/components/settings/machines/MachineAdministrationTargetSelector');

/** The Connect action of a found local server's row. */
function findConnectAction(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType('Item').find((item) => item.props.title === title)?.props.rightElement as
        | { props: { onPress?: () => unknown; accessibilityLabel?: string } }
        | undefined;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const router = createExpoRouterMock({
            pathname: () => navigationState.pathname,
            params: () => navigationState.params,
            router: { push: routerPush, replace: routerReplace },
        });
        // Expo owns route mounting. A stateful boundary exposes unwanted navigator remounts.
        const Stack = Object.assign(function Stack() {
            const [draft, setDraft] = React.useState('');
            React.useEffect(() => { navigationState.navigatorMounts += 1; }, []);
            return React.createElement('ProviderDraft', { testID: 'provider-draft', value: draft, onChangeText: setDraft });
        }, { Screen: router.module.Stack.Screen });
        return { ...router.module, Stack };
    },
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});

vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => ReactModule.useSyncExternalStore(
            (listener) => {
                navigationState.focusListeners.add(listener);
                return () => navigationState.focusListeners.delete(listener);
            },
            () => navigationState.focused,
        ),
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(() => {
                navigationState.focusEffects.push(effect);
                const cleanup = effect();
                return () => {
                    navigationState.focusEffects = navigationState.focusEffects.filter(
                        (registered) => registered !== effect,
                    );
                    if (typeof cleanup === 'function') cleanup();
                };
            }, [effect]);
        },
    };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'providers.localDiscovery'
        ? state.localDiscoveryEnabled
        : state.enabled,
}));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => state.providerDecision,
}));
vi.mock('@/hooks/teams/useHomeTeamCredentialModelCatalog', () => ({
    useHomeTeamCredentialModelCatalog: () => state.teamCredentialCatalog,
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'server-a' }) }));
// Host-component doubles intentionally accept arbitrary props at this renderer boundary.
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/components/ui/status/StatusPill', () => ({ StatusPill: (props: any) => React.createElement('StatusPill', props) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: (props: any) => React.createElement('Switch', props) }));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: (props: any) => React.createElement('SafeIonicons', props) }));
vi.mock('@/components/ui/buttons/IconButton', () => ({ IconButton: (props: any) => React.createElement('IconButton', props) }));
vi.mock('@/components/ui/feedback/ShimmerView', () => ({ ShimmerView: (props: any) => React.createElement('ShimmerView', props) }));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => ({
    ItemGroupColumns: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroupColumns', props, props.children),
    ItemGroupColumn: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroupColumn', props, props.children),
}));
vi.mock('@/providers/connection/ProviderIcon', () => ({ ProviderIcon: (props: any) => React.createElement('ProviderIcon', props) }));


/** The rendered component that carries `prop` for a test id (the host view under it carries none). */
function findComposite(screen: { findAllByTestId: (testID: string) => Array<{ props: Record<string, any> }> }, testID: string, prop: string) {
    return screen.findAllByTestId(testID).find((node) => node.props[prop] !== undefined) ?? null;
}

describe('ProviderConnectionsSettingsScreen', () => {
    afterEach(() => {
        clearActiveUnsavedChangesGuard();
        standardCleanup();
        storage.setState(initialStorage, true);
        vi.unstubAllGlobals();
    });
    beforeEach(() => {
        const machine = createMachineFixture({ id: 'machine-a', revokedAt: null });
        if (!machine.metadata) throw new Error('canonical machine fixture metadata is unavailable');
        machine.metadata.displayName = 'Mac';
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { 'server-a': [machine] } });
        providerHarness.reset();
        administrationTarget.controller.reset();
        state.enabled = true;
        state.providerDecision = { state: 'enabled', blockedBy: null, blockerCode: 'none' };
        state.localDiscoveryEnabled = true;
        run.mockReset();
        routerPush.mockReset();
        routerReplace.mockReset();
        navigationState.focusEffects = [];
        navigationState.pathname = '/settings/providers';
        navigationState.params = {};
        navigationState.navigatorMounts = 0;
        navigationState.focused = true;
        navigationState.focusListeners.clear();
        state.teamCredentialCatalog = {
            resources: [], teamNameById: {}, homeNameByTeamId: {}, currentResourceKeys: new Set(), current: true,
        };
        state.query = {
            loading: false, error: null, refresh: vi.fn(async () => undefined),
            data: createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    contributionKey: 'plugin/acme',
                    displayName: 'Acme',
                    providerName: 'Acme',
                    runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [] },
                })],
                available: [{
                    contributionKey: 'plugin/other', name: 'Other', kind: 'cloud', provenance: 'external',
                    icon: null, credential: null, endpointTemplates: [],
                }],
            }),
        };
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            const query = state.query as {
                loading?: boolean;
                error?: ReturnType<typeof createProviderErrorV1> | null;
                data?: ReturnType<typeof createProviderConnectionsDescribeFixture> | null;
            } | null;
            if (query?.loading && !query.data) return await new Promise<never>(() => undefined);
            if (query?.error) return { status: 'error', error: query.error };
            return query?.data ?? createProviderConnectionsDescribeFixture({ connections: [] });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (request, next) => {
            const payload = request.payload as { action?: string; connectionId?: string; contributionKey?: string; candidateId?: string };
            const query = state.query as { data?: { discoveryCandidates?: Array<{ candidateId?: string; contributionKey?: string; normalizedEndpointUrl?: string }> } } | null;
            const candidate = query?.data?.discoveryCandidates?.find((entry) => entry.candidateId === payload.candidateId);
            const key = payload.action === 'enableDetected'
                ? `detected:${candidate?.contributionKey}:${candidate?.normalizedEndpointUrl}`
                : payload.action === 'startLocal'
                    ? `start:${payload.contributionKey}`
                    : payload.connectionId;
            const observed = await run(payload, key);
            return observed ?? await next();
        });
    });

    it('opens a Team-provided Provider resource on its exact Home route', async () => {
        state.teamCredentialCatalog = {
            resources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Shared OpenRouter', resourceRevision: 3,
                readiness: { kind: 'available' }, recoveryAction: null, deliveryMode: 'brokered',
                mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed', providerModels: [],
                sourcePresentation: {
                    kind: 'provider',
                    provider: { identity: { pluginId: 'openrouter', localId: 'openrouter' }, definitionRevision: 1 },
                },
            }],
            teamNameById: { 'team-1': 'Acme' }, homeNameByTeamId: { 'team-1': 'Home A' },
            currentResourceKeys: new Set(['team-1:resource-1']), current: true,
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        await screen.pressByTestIdAsync('team-credential-catalog-resource:team-1:resource-1');
        expect(routerPush).toHaveBeenCalledWith('/settings/teams/server-a/team-1/credentials/resource-1');
    });

    it('renders the configured connection supplied by the shared Provider RPC boundary', async () => {
        state.query = {
            loading: false,
            error: null,
            data: createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    displayName: 'Boundary connection',
                    providerName: 'Boundary connection',
                })],
            }),
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        expect(providerHarness.state.requests).not.toHaveLength(0);
        expect(providerHarness.state.requests.map((request) => request.method)).toEqual([
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ]);
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('Boundary connection');
    });

    it('replaces the retained daemon projection each time the index regains focus', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('Acme');

        const query = state.query as {
            data: ReturnType<typeof createProviderConnectionsDescribeFixture>;
        };
        query.data = createProviderConnectionsDescribeFixture({ connections: [] });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        expect(screen.findAllByType('Item').map((item) => item.props.title)).not.toContain('Acme');

        query.data = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_returned',
                displayName: 'Returned connection',
                providerName: 'Returned connection',
            })],
        });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('Returned connection');
    });

    it('pauses the collection focus return until Back reaches the collection route', async () => {
        let activeElement: {
            focus: ReturnType<typeof vi.fn>;
            isConnected: boolean;
            getAttribute: (name: string) => string | null;
        } | null = null;
        vi.stubGlobal('document', {
            get activeElement() {
                return activeElement;
            },
            body: {},
            documentElement: {},
            getElementById: () => null,
            querySelectorAll: () => activeElement ? [activeElement] : [],
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        // A connection row, then the "+" menu's catalog provider and custom endpoint.
        const entries = [
            { testID: 'settings-provider-connection:pc_a', open: () => screen.findByTestId('settings-provider-connection:pc_a')?.props.onPress?.() },
            { testID: 'settings-providers-add', open: () => findComposite(screen, 'settings-providers-add-menu', 'onSelect')?.props.onSelect?.('catalog:plugin/other') },
            { testID: 'settings-providers-add', open: () => findComposite(screen, 'settings-providers-add-menu', 'onSelect')?.props.onSelect?.('custom') },
        ];

        for (const { testID, open } of entries) {
            const focus = vi.fn();
            activeElement = {
                focus,
                isConnected: true,
                getAttribute: (name: string) => name === 'data-testid' ? testID : null,
            };

            React.act(() => {
                open();
            });

            expect(focus).not.toHaveBeenCalled();

            navigationState.pathname = testID === 'settings-provider-connection:pc_a'
                ? '/settings/providers/pc_a' : '/settings/providers/new';
            await screen.update(<ProviderConnectionsSettingsScreen active />);
            expect(focus).not.toHaveBeenCalled();

            navigationState.pathname = '/settings/providers';
            await screen.update(<ProviderConnectionsSettingsScreen />);
            expect(focus).toHaveBeenCalledOnce();
        }

        expect(routerPush).toHaveBeenNthCalledWith(1, '/(app)/settings/providers/pc_a');
        expect(routerPush).toHaveBeenNthCalledWith(
            2,
            '/(app)/settings/providers/new?contributionKey=plugin%2Fother',
        );
        expect(routerPush).toHaveBeenNthCalledWith(3, '/(app)/settings/providers/new');
    });

    it('fails closed into the unavailable state when the root provider feature is off', async () => {
        state.enabled = false;
        state.providerDecision = { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.unavailable');
    });

    it('does not present a transient feature probe failure as a server-disabled Provider feature', async () => {
        state.enabled = false;
        state.providerDecision = { state: 'unknown', blockedBy: 'server', blockerCode: 'probe_failed' };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const items = screen.findAllByType('Item');
        expect(items.map((item) => item.props.title)).toContain('settingsProviders.availabilityProblem');
        expect(items.map((item) => item.props.subtitle)).not.toContain('settingsProviders.unavailableDescription');
    });

    it.each([
        {
            name: 'a loading feature snapshot',
            decision: null,
            title: 'settingsProviders.availabilityChecking',
            subtitle: 'settingsProviders.availabilityCheckingDescription',
        },
        {
            name: 'an unsupported server endpoint',
            decision: { state: 'unsupported' as const, blockedBy: 'server' as const, blockerCode: 'endpoint_missing' },
            title: 'settingsProviders.availabilityUnsupported',
            subtitle: 'settingsProviders.availabilityUnsupportedDescription',
        },
        {
            name: 'a misconfigured or mixed server scope',
            decision: { state: 'unsupported' as const, blockedBy: 'scope' as const, blockerCode: 'mixed_scope_support' },
            title: 'settingsProviders.availabilityContextUnsupported',
            subtitle: 'settingsProviders.availabilityContextUnsupportedDescription',
        },
        {
            name: 'another policy blocker',
            decision: { state: 'disabled' as const, blockedBy: 'local_policy' as const, blockerCode: 'flag_disabled' },
            title: 'settingsProviders.availabilityPolicyDisabled',
            subtitle: 'settingsProviders.availabilityPolicyDisabledDescription',
        },
    ])('presents $name truthfully', async ({ decision, title, subtitle }) => {
        state.providerDecision = decision;
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const items = screen.findAllByType('Item');
        expect(items.map((item) => item.props.title)).toContain(title);
        expect(items.map((item) => item.props.subtitle)).toContain(subtitle);
    });

    it('lists configured connections and offers available providers from the add menu', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('Acme');
        // Available providers are what you can add, not rows of the collection.
        expect(titles).not.toContain('Other');
        const acme = screen.findAllByType('Item').find((item) => item.props.title === 'Acme');
        // A healthy connection is quiet: its models, no status word and no trouble dot.
        expect(acme?.props.subtitle).toContain('settingsProviders.detail.modelCount');
        expect(acme?.props.subtitleLeading).toBeUndefined();
        const menuItems = findComposite(screen, 'settings-providers-add-menu', 'items')?.props.items as Array<{ id: string; title: string; subtitle?: string }>;
        expect(menuItems.map((item) => item.id)).toEqual(['custom', 'catalog:plugin/other']);
        expect(menuItems[1]?.subtitle).toContain('settingsProviders.compatibility.experimental');
    });

    it('marks a connection that needs the user with a status line and a trouble dot', async () => {
        const query = state.query as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections[0] = {
            ...query.data.connections[0],
            runtime: { health: 'unreachable', modelCount: 3, checkedAt: 1, endpoints: [] },
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        const acme = screen.findByTestId('settings-provider-connection:pc_a');
        expect(acme?.props.subtitle).toBe('settingsProviders.status.unreachable');
        expect(acme?.props.subtitleLeading).toBeTruthy();
    });

    it('selects the route connection in the rail and searches only a collection too long to scan', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const small = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_a" />);
        expect(small.findByTestId('settings-provider-connection:pc_a')?.props.selected).toBe(true);
        expect(small.findByTestId('settings-providers-search')).toBeNull();

        const query = state.query as { data: { connections: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = Array.from({ length: 10 }, (_, index) => ({
            ...exemplar,
            connectionId: index === 0 ? 'pc_a' : `pc_${index}`,
            displayName: index === 0 ? 'Acme' : `Provider ${index}`,
            providerName: index === 0 ? 'Acme' : `Provider ${index}`,
        }));
        const large = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" selectedConnectionId="pc_a" />);
        await React.act(async () => { large.changeTextByTestId('settings-providers-search', 'provider 3'); });
        expect(large.findByTestId('settings-provider-connection:pc_a')).toBeNull();
        expect(large.findAllByType('Item').map((item) => item.props.title)).toContain('Provider 3');
        await React.act(async () => { large.changeTextByTestId('settings-providers-search', ''); });
        expect(large.findByTestId('settings-provider-connection:pc_a')?.props.selected).toBe(true);
    });

    it('does not leave a dirty editor when another connection is selected until its guard permits navigation', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const decision = vi.fn<() => Promise<'keepEditing' | 'discard'>>(async () => 'keepEditing');
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision: decision,
            tag: 'provider-collection-test',
        });
        await screen.pressByTestIdAsync('settings-provider-connection:pc_a');
        expect(decision).toHaveBeenCalledOnce();
        expect(routerPush).not.toHaveBeenCalled();
        decision.mockResolvedValueOnce('discard');
        await screen.pressByTestIdAsync('settings-provider-connection:pc_a');
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
    });

    it('pauses the collection RPC while a narrow detail hides it and reloads when the collection becomes visible', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen active={false} />);
        expect(providerHarness.state.requests).toHaveLength(0);
        await React.act(async () => {
            screen.tree.update(<ProviderConnectionsSettingsScreen active />);
            await flushHookEffects();
        });
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('Acme');
        expect(providerHarness.state.requests.map((request) => request.method)).toEqual([
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ]);
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);
        expect(providerHarness.state.requests).toHaveLength(2);
    });

    it('preserves the route editor and collection selection when its measured panes resize', async () => {
        navigationState.pathname = '/settings/providers/pc_a';
        navigationState.params = { connectionId: 'pc_a' };
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        const screen = await renderScreen(<ProviderSettingsLayout />);
        const resize = async (width: number) => {
            await React.act(async () => {
                screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width } } });
                await flushHookEffects();
            });
        };
        expect(providerHarness.state.requests).toHaveLength(0);
        await resize(1200);
        expect(screen.findByTestId('settings-provider-connection:pc_a')?.props.selected).toBe(true);
        await React.act(async () => {
            screen.findByTestId('provider-draft')?.props.onChangeText('Unsubmitted endpoint');
        });
        await resize(480);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(true);
        await resize(1200);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('provider-draft')?.props.value).toBe('Unsubmitted endpoint');
        expect(navigationState.navigatorMounts).toBe(1);
        expect(screen.findByTestId('settings-provider-connection:pc_a')?.props.selected).toBe(true);
    });

    it('shows the provider rail beside the detail on desktop and only the detail stack on a narrow screen', async () => {
        navigationState.pathname = '/settings/providers';
        navigationState.params = {};
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        const screen = await renderScreen(<ProviderSettingsLayout />);
        const resize = async (width: number) => {
            await React.act(async () => {
                screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width } } });
                await flushHookEffects();
            });
        };

        await resize(1200);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('settings-providers-detail-pane')?.props.accessibilityElementsHidden).toBe(false);

        // Narrow: the detail stack alone, whose index page is the provider list.
        await resize(480);
        expect(screen.findByTestId('settings-providers-list-pane')?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findByTestId('settings-providers-detail-pane')?.props.accessibilityElementsHidden).toBe(false);
    });

    it('pauses the collection when the Providers navigator loses focus', async () => {
        administrationTarget.controller.setMachines([{ machineId: 'machine-a' }, { machineId: 'machine-b' }]);
        const { ProviderSettingsLayout } = await import('./ProviderSettingsLayout');
        // The navigation boundary is mocked with the canonical context factory;
        // the real optional-focus adapter requires a mounted screen context.
        const { NavigationContext } = await import('@react-navigation/native') as unknown as {
            NavigationContext: React.Context<Readonly<Record<string, unknown>> | undefined>;
        };
        const screen = await renderScreen(
            <NavigationContext.Provider value={{ isFocused: () => navigationState.focused }}>
                <ProviderSettingsLayout />
            </NavigationContext.Provider>,
        );
        await React.act(async () => {
            screen.findByTestId('settings-providers-layout')?.props.onLayout({ nativeEvent: { layout: { width: 1200 } } });
            await flushHookEffects();
        });
        expect(screen.findByTestId('settings-provider-connection:pc_a')).not.toBeNull();
        await React.act(async () => {
            navigationState.focused = false;
            for (const listener of navigationState.focusListeners) listener();
        });
        expect(screen.findByTestId('settings-provider-connection:pc_a')).not.toBeNull();
        const readsBeforeTargetChange = providerHarness.state.requests.length;
        await React.act(async () => { administrationTarget.controller.select('machine-b'); });
        expect(providerHarness.state.requests).toHaveLength(readsBeforeTargetChange);
        await React.act(async () => {
            navigationState.focused = true;
            for (const listener of navigationState.focusListeners) listener();
        });
        expect(screen.findByTestId('settings-provider-connection:pc_a')).not.toBeNull();
        expect(providerHarness.state.requests).toHaveLength(readsBeforeTargetChange + 1);
        expect(providerHarness.state.requests.at(-1)?.machineId).toBe('machine-b');
        expect(navigationState.navigatorMounts).toBe(1);
    });

    it('keeps the machine chip beside the unavailable notice when Providers is unavailable', async () => {
        state.enabled = false;
        state.providerDecision = { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' };
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings.providers.administration.target.chip')).not.toBeNull();
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('settingsProviders.unavailable');
        expect(providerHarness.state.requests).toHaveLength(0);
    });

    it('lands a wide collection on the last visited connection, else the first', async () => {
        const query = state.query as { data: { connections: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = [
            exemplar,
            { ...exemplar, connectionId: 'pc_b', displayName: 'Beta', providerName: 'Beta' },
        ];
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const { recordProviderCollectionVisit } = await import('./collection/providerCollectionModel');
        const landing = async () => {
            const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
            return screen.findAllByType('Redirect')[0]?.props.href;
        };
        expect(await landing()).toBe('/(app)/settings/providers/pc_a');
        recordProviderCollectionVisit('pc_b');
        expect(await landing()).toBe('/(app)/settings/providers/pc_b');
    });

    it('invites a wide collection with nothing to select to add its first provider', async () => {
        const query = state.query as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections = [];
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByTestId('settings-providers-invitation')).not.toBeNull();
        await screen.pressByTestIdAsync('settings-providers-invitation-custom');
        expect(routerReplace).toHaveBeenCalledWith('/(app)/settings/providers/new');
    });

    it('says what failed and offers its recovery when a wide collection cannot read the machine', async () => {
        state.query = {
            loading: false, data: null, refresh: vi.fn(),
            error: createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a' }),
        };
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('settingsProviders.errors.unreachableTitle');
        expect(titles).toContain('settingsProviders.errors.actions.retry');
        expect(screen.findByTestId('settings-providers-invitation')).toBeNull();

        // Retry reads the machine again; once it answers, the collection lands on its connection.
        const describeReads = () => providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        const readsBefore = describeReads();
        state.query = {
            loading: false, error: null, refresh: vi.fn(),
            data: createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] }),
        };
        const retry = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.errors.actions.retry');
        await React.act(async () => { await retry?.props.onPress?.(); });
        await flushHookEffects();
        expect(describeReads()).toBe(readsBefore + 1);
        expect(screen.findAllByType('Redirect')[0]?.props.href).toBe('/(app)/settings/providers/pc_a');
    });

    it('keeps landing on the last-known connection when a later read fails', async () => {
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findAllByType('Redirect')[0]?.props.href).toBe('/(app)/settings/providers/pc_a');

        (state.query as { error: ReturnType<typeof createProviderErrorV1> | null }).error =
            createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a' });
        await React.act(async () => {
            navigationState.focused = false;
            for (const listener of navigationState.focusListeners) listener();
        });
        await React.act(async () => {
            navigationState.focused = true;
            for (const listener of navigationState.focusListeners) listener();
        });
        await flushHookEffects();
        // The error does not replace the collection it already knows: it still lands on the connection.
        expect(screen.findAllByType('Redirect')[0]?.props.href).toBe('/(app)/settings/providers/pc_a');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.unreachableTitle');
    });

    it('shows the new provider as a selected draft row while its editor is open', async () => {
        navigationState.pathname = '/settings/providers/new';
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const { publishProviderDraftTitle } = await import('./collection/providerDraftTitle');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        expect(screen.findAllByType('Item').find((item) => item.props.testID === 'settings-providers-draft')?.props.title).toBe('settingsProvidersCollection.newTitle');
        await React.act(async () => { publishProviderDraftTitle('Company gateway'); });
        expect(screen.findAllByType('Item').find((item) => item.props.testID === 'settings-providers-draft')?.props.title).toBe('Company gateway');
        expect(screen.findAllByType('Item').find((item) => item.props.testID === 'settings-providers-draft')?.props.selected).toBe(true);
        await React.act(async () => { publishProviderDraftTitle(''); });
    });

    it('keeps collection rows to identity and state: no switch beside a connection', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen variant="rail" />);
        expect(screen.findByTestId('settings-provider-connection:pc_a')?.props.rightElement).toBeUndefined();
        expect(screen.findAllByType('Switch')).toHaveLength(0);
    });

    it('retries the exact typed list mutation instead of substituting a catalog read', async () => {
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);

        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });
        const retry = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        await React.act(async () => { await retry?.props.onPress?.(); });

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('preserves an unknown list mutation when its reconciliation read also fails', async () => {
        run.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const erroring = state.query as { error: ReturnType<typeof createProviderErrorV1> | null };
        erroring.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });

        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        const review = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState');
        expect(review).toBeDefined();
        const readsBeforeReview = providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        await React.act(async () => { await review?.props.onPress?.(); });

        expect(run).toHaveBeenCalledOnce();
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toHaveLength(readsBeforeReview + 1);
    });

    it('keeps search and its no-results explanation when a refreshed collection becomes smaller', async () => {
        const query = state.query as { data: { connections: Array<Record<string, unknown>>; available: Array<Record<string, unknown>> } };
        const exemplar = query.data.connections[0]!;
        query.data.connections = Array.from({ length: 10 }, (_, index) => ({
            ...exemplar,
            connectionId: `pc_${index}`,
            displayName: `Provider ${index}`,
            providerName: `Provider ${index}`,
        }));
        query.data.available = [];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const titles = () => screen.findAllByType('Item').map((item) => item.props.title);
        await React.act(async () => { screen.changeTextByTestId('settings-providers-search', 'not-a-provider'); });
        expect(titles()).toContain('settingsProviders.searchEmptyTitle');
        expect(titles()).not.toContain('settingsProviders.emptyTitle');

        query.data.connections = [exemplar];
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);
        expect(screen.findHostByTestId('settings-providers-search')?.props.value).toBe('not-a-provider');
        expect(titles()).toContain('settingsProviders.searchEmptyTitle');
    });

    it('uses three skeleton rows for first load and an honest configured empty state', async () => {
        state.query = { loading: true, data: null, error: null, refresh: vi.fn() };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const loading = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(loading.findAllByType('ShimmerView')).toHaveLength(3);

        state.query = {
            loading: false, error: null, refresh: vi.fn(),
            data: { status: 'success', diagnostics: [], diagnosticsTruncated: false, availableTruncated: false, discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [], connections: [], available: [] },
        };
        const empty = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(empty.findAllByType('Item').map((item) => item.props.title)).toContain('settingsProviders.emptyTitle');
        expect(empty.findAllByType('ShimmerView')).toHaveLength(0);
    });

    it('retains configured rows and renders an actionable typed error after a transport refresh failure', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const query = state.query as { error: ReturnType<typeof createProviderErrorV1> | null };
        query.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });
        await screen.update(<ProviderConnectionsSettingsScreen active={false} />);
        await screen.update(<ProviderConnectionsSettingsScreen active />);

        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('Acme');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.unreachableTitle');
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');
    });

    it('renders an attributed local candidate only when local discovery is enabled', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const shown = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        expect(shown.findAllByType('Item').map((item) => item.props.title)).toContain('Ollama');

        state.localDiscoveryEnabled = false;
        const hidden = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        expect(hidden.findAllByType('Item').filter((item) => item.props.title === 'Ollama')).toHaveLength(0);
    });

    it('qualifies same-provider Connect actions with their exact endpoint identity', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [11434, 11435].map((port) => ({
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: `http://127.0.0.1:${port}`,
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }));
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const labels = screen.findAllByType('Item')
            .filter((item) => item.props.title === 'Ollama')
            .map((item) => item.props.rightElement.props.accessibilityLabel);

        expect(labels).toEqual([
            'settingsProvidersCollection.connect: Ollama, http://127.0.0.1:11434/',
            'settingsProvidersCollection.connect: Ollama, http://127.0.0.1:11435/',
        ]);
    });

    it('lists a detected server already matched to a connection only as that connection', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/acme',
            providerName: 'Acme', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'https://api.acme.example',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'matched', connectionId: 'pc_a' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const acmeRows = screen.findAllByType('Item').filter((item) => item.props.title === 'Acme');

        expect(acmeRows.map((item) => item.props.testID)).toEqual(['settings-provider-connection:pc_a']);
    });

    it('enables an exact detected endpoint through the canonical mutation action', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            candidateId: 'discovery-candidate:v1:exact-listener',
            evidence: { kind: 'default_port_hint' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        await React.act(async () => {
            await findConnectAction(screen, 'Ollama')?.props.onPress?.();
        });

        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'enableDetected', machineId: 'machine-a',
            candidateId: 'discovery-candidate:v1:exact-listener',
            displayName: null, savedSecretId: null,
        }), 'detected:plugin/ollama:http://127.0.0.1:11435');
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('contributionKey');
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('endpointTemplateId');
        expect(run.mock.calls[0]?.[0]).not.toHaveProperty('normalizedEndpointUrl');
    });

    it('fails closed with review-required recovery when an older daemon omits candidate identity', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] }; refresh: ReturnType<typeof vi.fn> };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11435',
            evidence: { kind: 'default_port_hint' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await React.act(async () => { await findConnectAction(screen, 'Ollama')?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.accessChangedTitle');
    });

    it('opens the shared authoring draft before creating a named discovered connection', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:named',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'requires_named_connection' },
        }];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await React.act(async () => {
            await findConnectAction(screen, 'Ollama')?.props.onPress?.();
        });

        expect(run).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining(
            '/settings/providers/new?contributionKey=plugin%2Follama&candidateId=discovery-candidate%3Av1%3Anamed',
        ));
        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('displayName='));
    });

    it('preserves the daemon candidate identity when credential recovery opens authoring', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:22434',
            candidateId: 'discovery-candidate:v1:exact',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        run.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_secret_missing', {
                connectionId: 'pc_new', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        await React.act(async () => {
            await findConnectAction(screen, 'Ollama')?.props.onPress?.();
        });

        expect(routerPush).toHaveBeenCalledWith(expect.stringContaining(
            'candidateId=discovery-candidate%3Av1%3Aexact',
        ));
        expect(routerPush).toHaveBeenCalledWith(expect.not.stringContaining('normalizedEndpointUrl'));
    });

    it('renders verified installed and app-running states without claiming endpoint availability', async () => {
        const query = state.query as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false },
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'app_running_server_off', managedStartAvailable: false },
        ];
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        const rows = screen.findAllByType('Item');
        expect(rows.find((row) => row.props.title === 'Ollama')?.props.subtitle)
            .toBe('settingsProviders.local.installedNotRunning');
        expect(rows.find((row) => row.props.title === 'LM Studio')?.props.subtitle)
            .toBe('settingsProviders.local.appRunningServerOff');
        expect(rows.filter((row) => row.props.title === 'Ollama')[0]?.props.rightElement).toBeUndefined();
    });

    it('deduplicates discovery and installation rows sharing one canonical contribution key', async () => {
        const query = state.query as { data: { discoveryCandidates: unknown[]; localInstallations: unknown[] } };
        query.data.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/ollama',
            providerName: 'Ollama', endpointTemplateId: 'native',
            normalizedEndpointUrl: 'http://127.0.0.1:11434',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'enable_default' },
        }];
        query.data.localInstallations = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/ollama',
            providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: false,
        }];

        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(screen.findAllByType('Item').filter((item) => item.props.title === 'Ollama')).toHaveLength(1);
    });

    it('offers managed Start only when the daemon projects the exact capability', async () => {
        const query = state.query as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama', providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: true },
            { v: 1, machineId: 'machine-a', contributionKey: 'plugin/lmstudio', providerName: 'LM Studio', status: 'installed_not_running', managedStartAvailable: false },
        ];
        run.mockResolvedValueOnce({ status: 'success', action: 'startLocal', contributionKey: 'plugin/ollama', phase: 'detecting' });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        const rows = screen.findAllByType('Item');
        const startButton = rows.find((row) => row.props.title === 'Ollama')?.props.rightElement;

        expect(startButton).toBeTruthy();
        expect(rows.find((row) => row.props.title === 'LM Studio')?.props.rightElement).toBeUndefined();
        await React.act(async () => {
            await startButton.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'startLocal', machineId: 'machine-a', contributionKey: 'plugin/ollama',
            connectionId: expect.stringMatching(/^pc_/u),
        }), 'start:plugin/ollama');
    });

    it('shows the existing pending spinner while managed Start awaits readiness', async () => {
        const query = state.query as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [{
            v: 1, machineId: 'machine-a', contributionKey: 'plugin/ollama',
            providerName: 'Ollama', status: 'installed_not_running', managedStartAvailable: true,
        }];
        const deferred = createDeferred<Readonly<{
            status: 'success'; action: 'startLocal'; contributionKey: string; phase: 'running';
        }>>();
        run.mockReturnValueOnce(deferred.promise);
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const startButton = screen.findAllByType('Item')
            .find((row) => row.props.title === 'Ollama')?.props.rightElement;
        let startPromise!: Promise<void>;

        await React.act(async () => {
            startPromise = startButton.props.onPress();
            await Promise.resolve();
        });
        expect(screen.findAllByType('Item')
            .find((row) => row.props.title === 'Ollama')?.props.rightElement.type.name)
            .toBe('ActivitySpinner');

        deferred.resolve({
            status: 'success', action: 'startLocal',
            contributionKey: 'plugin/ollama', phase: 'running',
        });
        await React.act(async () => { await startPromise; });
    });

    it('retries the exact managed Start after a typed local endpoint failure', async () => {
        const query = state.query as { data: { localInstallations: unknown[] } };
        query.data.localInstallations = [{
            v: 1,
            machineId: 'machine-a',
            contributionKey: 'plugin/ollama',
            providerName: 'Ollama',
            status: 'installed_not_running',
            managedStartAvailable: true,
        }];
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', { machineId: 'machine-a' }),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const startButton = screen.findAllByType('Item')
            .find((row) => row.props.title === 'Ollama')?.props.rightElement;

        await React.act(async () => { await startButton?.props.onPress?.(); });
        const retry = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .not.toContain('settingsProviders.errors.connectionInvalidTitle');
        await React.act(async () => { await retry?.props.onPress?.(); });

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
        expect(routerPush).not.toHaveBeenCalled();
    });
});
