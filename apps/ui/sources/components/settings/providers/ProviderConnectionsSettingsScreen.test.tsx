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
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

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
}));
const run = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    focusEffects: [] as Array<() => void | (() => void)>,
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const administrationTarget = createMachineAdministrationTargetSelectionMock();
installMachineAdministrationTargetSelectionBoundary(administrationTarget);

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

installSettingsViewCommonModuleMocks({
    router: async () => ({ useRouter: () => ({ push: routerPush }) }),
    storage: async () => ({
        useAllMachines: () => [{
            id: 'machine-a', active: true, revokedAt: null,
            metadata: { displayName: 'Mac' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1, activeAt: 1,
        }],
        useMachineListByServerId: () => ({ 'server-a': [{ id: 'machine-a', active: true, revokedAt: null }] }),
    }),
});

vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
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
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'server-a' }) }));
// Host-component doubles intentionally accept arbitrary props at this renderer boundary.
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/components/ui/status/StatusPill', () => ({ StatusPill: (props: any) => React.createElement('StatusPill', props) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: (props: any) => React.createElement('Switch', props) }));
vi.mock('@/components/ui/forms/SearchHeader', () => ({ SearchHeader: (props: any) => React.createElement('SearchHeader', props) }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props) }));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: (props: any) => React.createElement('SafeIonicons', props) }));
vi.mock('@/components/ui/buttons/IconButton', () => ({ IconButton: (props: any) => React.createElement('IconButton', props) }));
vi.mock('@/components/ui/feedback/ShimmerView', () => ({ ShimmerView: (props: any) => React.createElement('ShimmerView', props) }));
vi.mock('@/components/ui/empty/EmptyState', () => ({ EmptyState: (props: any) => React.createElement('EmptyState', props) }));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => ({
    ItemGroupColumns: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroupColumns', props, props.children),
    ItemGroupColumn: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroupColumn', props, props.children),
}));
vi.mock('@/providers/connection/ProviderIcon', () => ({ ProviderIcon: (props: any) => React.createElement('ProviderIcon', props) }));

describe('ProviderConnectionsSettingsScreen', () => {
    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
    });
    beforeEach(() => {
        providerHarness.reset();
        state.enabled = true;
        state.providerDecision = { state: 'enabled', blockedBy: null, blockerCode: 'none' };
        state.localDiscoveryEnabled = true;
        run.mockReset();
        routerPush.mockReset();
        navigationState.focusEffects = [];
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

    function refocusScreen(): void {
        for (const effect of [...navigationState.focusEffects]) effect();
    }

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
        await React.act(async () => {
            refocusScreen();
            await flushHookEffects();
        });

        expect(screen.findAllByType('Item').map((item) => item.props.title)).not.toContain('Acme');

        query.data = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_returned',
                displayName: 'Returned connection',
                providerName: 'Returned connection',
            })],
        });
        await React.act(async () => {
            refocusScreen();
            await flushHookEffects();
        });

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('Returned connection');
    });

    it('returns focus to the exact configured, available, and add-custom row after Back', async () => {
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
            querySelectorAll: () => activeElement ? [activeElement] : [],
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const testIds = [
            'settings-provider-connection:pc_a',
            'settings-provider-available:plugin/other',
            'settings-provider-add-custom',
        ];

        for (const testID of testIds) {
            const focus = vi.fn();
            activeElement = {
                focus,
                isConnected: true,
                getAttribute: (name: string) => name === 'data-testid' ? testID : null,
            };
            const row = screen.findAllByType('Item').find((item) => item.props.testID === testID);

            React.act(() => {
                row?.props.onPress?.();
            });

            expect(focus).not.toHaveBeenCalled();

            await React.act(async () => {
                refocusScreen();
                await flushHookEffects();
            });
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

    it('renders configured and available providers from the daemon projection', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionsSettingsScreen));
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('Acme');
        expect(titles).toContain('Other');
        const acme = screen.findAllByType('Item').find((item) => item.props.title === 'Acme');
        expect(acme?.props.subtitleAccessory.props.label).toBe('settingsProviders.status.available');
        const other = screen.findAllByType('Item').find((item) => item.props.title === 'Other');
        expect(other?.props.subtitleAccessory.props.label).toBe('settingsProviders.compatibility.experimental');
        expect(screen.findAllByType('ItemGroupColumns')).toHaveLength(1);
    });

    it('labels every standalone Provider switch with its owning row', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const switchRows = screen.findAllByType('Item').filter((item) => (
            typeof item.props.rightElement?.props?.onValueChange === 'function'
        ));

        expect(switchRows.length).toBeGreaterThan(0);
        for (const row of switchRows) {
            expect(row.props.rightElement.props.accessibilityLabel).toBe(row.props.title);
        }
    });

    it('uses one atomic connection-scope disable for the configured connection switch', async () => {
        const query = state.query as { data: { connections: Array<Record<string, unknown>> } };
        query.data.connections[0] = {
            ...query.data.connections[0],
            authorized: true,
            grants: { accountEnabled: true, enabledMachineIds: ['machine-a'] },
        };
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const configured = screen.findAllByType('Item')
            .find((item) => item.props.testID === 'settings-provider-connection:pc_a');

        await React.act(async () => { await configured?.props.rightElement.props.onValueChange(false); });

        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'setEnabled', connectionId: 'pc_a', enabled: false, scope: 'connection',
        }), 'pc_a');
    });

    it('retries the exact typed list mutation instead of substituting a catalog read', async () => {
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const configured = screen.findAllByType('Item')
            .find((item) => item.props.testID === 'settings-provider-connection:pc_a');

        await React.act(async () => {
            await configured?.props.rightElement.props.onValueChange(false);
        });
        const retry = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        await React.act(async () => { await retry?.props.onPress?.(); });

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('preserves an unknown list mutation when its reconciliation read also fails', async () => {
        run.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const query = state.query as { error: ReturnType<typeof createProviderErrorV1> | null };
        query.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });
        const configured = screen.findAllByType('Item')
            .find((item) => item.props.testID === 'settings-provider-connection:pc_a');

        await React.act(async () => {
            await configured?.props.rightElement.props.onValueChange(false);
        });

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

    it('renders a truthful cross-group search-empty state and clears hidden filtering below the search threshold', async () => {
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
        await React.act(async () => { screen.findByType('SearchHeader').props.onChangeText('not-a-provider'); });
        expect(screen.findByType('EmptyState').props.title).toBe('settingsProviders.searchEmptyTitle');
        expect(screen.findAllByType('EmptyState').map((emptyState) => emptyState.props.title))
            .not.toContain('settingsProviders.emptyTitle');

        query.data.connections = [exemplar];
        await React.act(async () => { screen.tree.unmount(); });
        const shrunk = await renderScreen(<ProviderConnectionsSettingsScreen />);
        expect(shrunk.findAllByType('SearchHeader')).toHaveLength(0);
        expect(shrunk.findAllByType('Item').map((item) => item.props.title)).toContain('Acme');
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
        expect(empty.findByType('EmptyState').props.title).toBe('settingsProviders.emptyTitle');
    });

    it('retains configured rows and renders an actionable typed error after a transport refresh failure', async () => {
        const { ProviderConnectionsSettingsScreen } = await import('./ProviderConnectionsSettingsScreen');
        const screen = await renderScreen(<ProviderConnectionsSettingsScreen />);
        const query = state.query as { error: ReturnType<typeof createProviderErrorV1> | null };
        query.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });
        const configured = screen.findAllByType('Item')
            .find((item) => item.props.testID === 'settings-provider-connection:pc_a');
        await React.act(async () => {
            await configured?.props.rightElement.props.onValueChange(false);
        });

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

    it('qualifies same-provider discovery switches with their exact endpoint identity', async () => {
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
            'Ollama, http://127.0.0.1:11434/',
            'Ollama, http://127.0.0.1:11435/',
        ]);
    });

    it('disables an account-backed detected match at the owning account scope', async () => {
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
        const detected = screen.findAllByType('Item').find((item) => (
            item.props.title === 'Acme'
            && item.props.rightElement?.props.accessibilityLabel.startsWith('Acme, https://api.acme.example')
        ));
        await React.act(async () => {
            await detected?.props.rightElement.props.onValueChange(false);
        });

        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'setEnabled', connectionId: 'pc_a', enabled: false, scope: 'account',
        }), 'pc_a');
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
        const ollama = screen.findAllByType('Item').find((item) => item.props.title === 'Ollama');
        await React.act(async () => {
            await ollama?.props.rightElement.props.onValueChange(true);
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
        const ollama = screen.findAllByType('Item').find((item) => item.props.title === 'Ollama');

        await React.act(async () => { await ollama?.props.rightElement.props.onValueChange(true); });

        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.accessChangedTitle');
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
        const ollama = screen.findAllByType('Item').find((item) => item.props.title === 'Ollama');

        await React.act(async () => {
            await ollama?.props.rightElement.props.onValueChange(true);
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
