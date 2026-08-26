import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createMachineAdministrationTargetSelectionMock,
    createProviderSettingsHarness,
    createDeferred,
    flushHookEffects,
    installMachineAdministrationTargetSelectionBoundary,
    installProviderSettingsRpcBoundary,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import { en } from '@/text/translations/en';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    providerDecisionState: 'enabled' as 'enabled' | 'loading',
    connection: null as Record<string, unknown> | null,
    discoveryCandidates: [] as Record<string, unknown>[],
    localInstallations: [] as Record<string, unknown>[],
    error: null as Record<string, unknown> | null,
}));
const run = vi.hoisted(() => vi.fn());
const providerDecisionListeners = vi.hoisted(() => new Set<() => void>());
const prompt = vi.hoisted(
    () => vi.fn(async (): Promise<string | null> => 'Custom copy'),
);
const confirm = vi.hoisted(() => vi.fn(async () => true));
const alert = vi.hoisted(() => vi.fn());
const alertAsync = vi.hoisted(() => vi.fn(async () => undefined));
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
const probeProviderConnection = vi.hoisted(() => vi.fn());
const refreshProfile = vi.hoisted(() => vi.fn(async () => undefined));
const connectedAccountProfileState = vi.hoisted(() => ({
    accounts: [] as Array<Record<string, unknown>>,
    groups: [] as Array<Record<string, unknown>>,
}));
const connectedServiceRegistryState = vi.hoisted(() => ({
    entries: [] as Array<Record<string, unknown>>,
}));
const router = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));
const navigationDispatch = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const administrationTarget = createMachineAdministrationTargetSelectionMock({
    machines: [
        { machineId: 'machine-a', displayName: 'Mac' },
        { machineId: 'machine-b', displayName: 'Linux box' },
    ],
});
installMachineAdministrationTargetSelectionBoundary(administrationTarget);

installSettingsViewCommonModuleMocks({
    router: async () => ({
        usePathname: () => '/settings/providers/cpx-moving',
        useRouter: () => router,
        useNavigation: () => ({ dispatch: navigationDispatch }),
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: { openURL: openUrl },
        });
    },
    storage: async () => ({
        useAllMachines: () => [
            { id: 'machine-a', active: true, revokedAt: null, metadata: { displayName: 'Mac' } },
            { id: 'machine-b', active: true, revokedAt: null, metadata: { displayName: 'Linux' } },
        ],
        useMachineListByServerId: () => ({
            'server-a': [
                { id: 'machine-a', active: true, revokedAt: null },
                { id: 'machine-b', active: true, revokedAt: null },
            ],
        }),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { prompt, confirm, alert, alertAsync },
        }).module;
    },
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => {
        const [, rerender] = React.useReducer((value: number) => value + 1, 0);
        React.useEffect(() => {
            const listener = () => rerender();
            providerDecisionListeners.add(listener);
            return () => {
                providerDecisionListeners.delete(listener);
            };
        }, []);
        return state.providerDecisionState === 'loading'
            ? null
            : { state: 'enabled', blockedBy: null, blockerCode: 'none' };
    },
}));
// The active snapshot reports the profile's SCOPE id
// (`profile.serverIdentityId ?? profile.id`), while an Administration target
// resolves to the profile's device-local `profile.id`. The two are different
// strings for the same server, so the suite drives both forms.
const activeServer = vi.hoisted(() => ({ serverId: 'srv_test' }));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: activeServer.serverId }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    // Stands in for the MMKV-backed profile registry: identifiers resolve to
    // the profile that owns them, so an identity id and a device-local id of
    // the same profile are equivalent and two distinct profiles are not.
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
        const profileIdByIdentifier: Readonly<Record<string, string>> = {
            'server-a': 'server-a',
            srv_test: 'server-a',
            'server-b': 'server-b',
            srv_b: 'server-b',
        };
        const leftId = profileIdByIdentifier[String(left ?? '').trim()];
        const rightId = profileIdByIdentifier[String(right ?? '').trim()];
        return Boolean(leftId && rightId && leftId === rightId);
    },
}));
vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({
        connectedAccountsV4: connectedAccountProfileState.accounts,
        connectedAccountGroupsV4: connectedAccountProfileState.groups,
    }),
    useSettings: () => ({ connectedServicesProfileLabelByKey: {} }),
    useLocalSetting: () => 'comfortable',
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshProfile } }));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesRuntimeSnapshot: () => ({
        status: 'ready',
        features: {
            capabilities: {
                connectedServices: {
                    qualifiedAccounts: { protocolVersion: 4 },
                },
            },
        },
    }),
}));
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-a', status: 'ready', errorReason: null, entries: connectedServiceRegistryState.entries,
    }),
}));
vi.mock('@/sync/domains/connectedServices/connectedServiceRegistry', () => ({
    getConnectedAccountAuthentication: () => ({
        defaultModeId: 'oauth',
        modes: [{
            id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none',
        }],
    }),
    getQualifiedConnectedServiceRegistryEntry: () => null,
    getLegacyConnectedServiceRegistryEntry: () => ({
        serviceId: 'unavailable', connectCommand: '', supportsOauth: false,
    }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { children?: React.ReactNode; rightElement?: React.ReactNode }) => React.createElement(
        'Item',
        props,
        props.children,
        props.rightElement,
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/components/ui/status/StatusPill', () => ({ StatusPill: (props: Record<string, unknown>) => React.createElement('StatusPill', props) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: (props: Record<string, unknown>) => React.createElement('Switch', props) }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: () => null }));
vi.mock('@/components/ui/icons/SafeIonicons', () => ({ SafeIonicons: () => null }));
vi.mock('@/providers/connection/ProviderIcon', () => ({ ProviderIcon: (props: Record<string, unknown>) => React.createElement('ProviderIcon', props) }));

function connection(overrides: Record<string, unknown> = {}) {
    const base = {
        connectionId: 'pc_a', contributionKey: 'acme.plugin/acme',
        provenance: 'first_party',
        displayName: 'Acme', providerName: 'Acme', role: 'default', displayNameMode: 'automatic',
        sourceStatus: 'available', probeCapability: 'none', manualModelPolicy: 'catalog-only', icon: null,
        compatibility: [],
        grants: {
            accountEnabled: false,
            enabledMachineIds: [],
            accountState: 'absent',
            machineState: 'absent',
            effectiveState: 'absent',
        }, credential: null,
        endpoints: [], scope: 'account', authorized: false, authorizationError: null, revision: 0,
        probeObservationIdentity: null,
        runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
        ...overrides,
    };
    return {
        ...base,
        grants: {
            accountEnabled: false,
            enabledMachineIds: [],
            accountState: 'absent',
            machineState: 'absent',
            effectiveState: 'absent',
            ...((overrides.grants as Record<string, unknown> | undefined) ?? {}),
        },
    };
}

async function pressAndFlush(item: { props: { onPress?: () => void } } | undefined): Promise<void> {
    await act(async () => {
        item?.props.onPress?.();
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
}

function findProviderExternalLink(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    label: string,
) {
    return screen.findAllByType(HappierLink).find((node) => (
        node.props.label === label
        && typeof node.props.onPress === 'function'
    ));
}

describe('ProviderConnectionDetailScreen', () => {
    afterEach(standardCleanup);
    beforeEach(() => {
        providerHarness.reset();
        administrationTarget.controller.reset();
        activeServer.serverId = 'srv_test';
        state.providerDecisionState = 'enabled';
        state.connection = connection();
        state.discoveryCandidates = [];
        state.localInstallations = [];
        state.error = null;
        connectedAccountProfileState.accounts = [];
        connectedAccountProfileState.groups = [];
        connectedServiceRegistryState.entries = [];
        run.mockReset();
        refreshProfile.mockReset();
        refreshProfile.mockResolvedValue(undefined);
        alert.mockReset();
        alertAsync.mockReset();
        alertAsync.mockResolvedValue(undefined);
        openUrl.mockReset();
        openUrl.mockResolvedValue(undefined);
        prompt.mockReset();
        prompt.mockResolvedValue('Custom copy');
        confirm.mockReset();
        confirm.mockResolvedValue(true);
        router.push.mockReset();
        router.replace.mockReset();
        router.back.mockReset();
        navigationDispatch.mockReset();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;
        probeProviderConnection.mockReset();
        probeProviderConnection.mockResolvedValue({
            status: 'success', models: [], requestFingerprint: 'probe-request:v1:detail',
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            if (state.error) return { status: 'error', error: state.error };
            return createProviderConnectionsDescribeFixture({
                connections: state.connection ? [state.connection as ReturnType<typeof createProviderConnectionViewFixture>] : [],
                discoveryCandidates: state.discoveryCandidates as NonNullable<Parameters<typeof createProviderConnectionsDescribeFixture>[0]>['discoveryCandidates'],
                localInstallations: state.localInstallations as NonNullable<Parameters<typeof createProviderConnectionsDescribeFixture>[0]>['localInstallations'],
            });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, async (request) => {
            const response = await probeProviderConnection(request.payload);
            return response?.status === 'success'
                ? { models: [], requestFingerprint: 'probe-request:v1:detail', ...response }
                : response;
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (request, next) => {
            const payload = request.payload as {
                action?: string; connectionId?: string; contributionKey?: string; mode?: string;
                scope?: string; machineId?: string; endpointTemplateId?: string;
            };
            const key = payload.action === 'duplicate'
                ? `duplicate:${payload.mode}`
                : payload.action === 'update'
                    && typeof (
                        request.payload as { deployment?: { kind?: string } }
                    ).deployment?.kind === 'string'
                    ? `deployment:${(
                        request.payload as { deployment: { kind: string } }
                    ).deployment.kind}`
                : payload.action === 'startLocal'
                    ? `start:${payload.contributionKey}`
                    : payload.action === 'delete'
                        ? 'delete'
                        : payload.action === 'setEndpointOverride'
                            ? `endpoint:${payload.scope}:${payload.endpointTemplateId}`
                            : payload.action === 'setEnabled' && payload.scope === 'account'
                                ? 'enable:account'
                                : payload.action === 'setEnabled' && payload.scope === 'machine'
                                    ? `machine:${payload.machineId}`
                                    : payload.connectionId;
            return await run(payload, key) ?? await next();
        });
    });

    it('recovers a directly opened detail route when Provider availability finishes loading', async () => {
        state.providerDecisionState = 'loading';
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const element = <ProviderConnectionDetailScreen connectionId="pc_a" />;
        const screen = await renderScreen(element);

        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.availabilityChecking');
        expect(providerHarness.state.requests).toEqual([]);

        state.providerDecisionState = 'enabled';
        await act(async () => {
            providerDecisionListeners.forEach((listener) => listener());
            await Promise.resolve();
        });
        await flushHookEffects();
        expect(providerHarness.state.requests.map((request) => request.method)).toContain(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        );
    });

    it('renders connection identity supplied by the shared Provider RPC boundary', async () => {
        state.connection = createProviderConnectionViewFixture({
            displayName: 'Boundary detail', providerName: 'Boundary detail',
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('Boundary detail');
    });

    it('opens a website-only projected Provider destination without mutating connection state', async () => {
        state.connection = connection({
            websiteUrl: 'https://provider.example.test',
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:link-test',
        });
        const initialConnection = state.connection;
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const websiteRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.links.providerWebsite');
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        const testStatusBefore = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle;

        expect(websiteRow?.props.accessibilityLabel).toBe('settingsProviders.links.providerWebsite');
        expect(websiteRow?.props.onPress).toBeUndefined();
        expect(titles).not.toContain('settingsProviders.links.getApiKey');
        await pressAndFlush(findProviderExternalLink(screen, 'settingsProviders.links.providerWebsite'));

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test');
        expect(run).not.toHaveBeenCalled();
        expect(state.connection).toBe(initialConnection);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe(testStatusBefore);
    });

    it('routes the provider website accessory through HappierLink', async () => {
        state.connection = connection({ websiteUrl: 'https://provider.example.test' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const website = findProviderExternalLink(screen, 'settingsProviders.links.providerWebsite');

        expect(website?.props.label).toBe('settingsProviders.links.providerWebsite');
    });

    it('opens a key-only projected Provider destination without mutating credentials', async () => {
        state.connection = connection({
            credential: {
                required: true,
                accountBound: false,
                boundMachineIds: [],
                keyUrl: 'https://provider.example.test/keys',
            },
        });
        const initialConnection = state.connection;
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        const getKeyRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.links.getApiKey');

        expect(titles).not.toContain('settingsProviders.links.providerWebsite');
        expect(getKeyRow?.props.accessibilityLabel).toBe('settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.onPress).toBeUndefined();
        await pressAndFlush(findProviderExternalLink(screen, 'settingsProviders.links.getApiKey'));

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test/keys');
        expect(run).not.toHaveBeenCalled();
        expect(state.connection).toBe(initialConnection);
    });

    it('preserves the detail screen and reports non-secret feedback when opening fails', async () => {
        state.connection = connection({
            websiteUrl: 'https://provider.example.test',
        });
        openUrl.mockRejectedValueOnce(new Error('platform opener unavailable'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await pressAndFlush(findProviderExternalLink(screen, 'settingsProviders.links.providerWebsite'));

        expect(alert).toHaveBeenCalledWith('common.error', 'settingsProviders.links.failedToOpen');
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain('Acme');
        expect(run).not.toHaveBeenCalled();
    });

    it('omits contribution links for unavailable sources and custom connections without metadata', async () => {
        state.connection = connection({
            sourceStatus: 'unavailable',
            websiteUrl: 'https://stale.example.test',
            credential: {
                required: true,
                accountBound: false,
                boundMachineIds: [],
                keyUrl: 'https://stale.example.test/keys',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const unavailable = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const unavailableTitles = unavailable.findAllByType('Item').map((item) => item.props.title);
        expect(unavailableTitles).not.toContain('settingsProviders.links.providerWebsite');
        expect(unavailableTitles).not.toContain('settingsProviders.links.getApiKey');

        state.connection = connection({
            contributionKey: null,
            provenance: 'custom',
        });
        const custom = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const customTitles = custom.findAllByType('Item').map((item) => item.props.title);
        expect(customTitles).not.toContain('settingsProviders.links.providerWebsite');
        expect(customTitles).not.toContain('settingsProviders.links.getApiKey');
    });

    it('omits Test connection and explains first-session checking when no safe probe exists', async () => {
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).not.toContain('settingsProviders.detail.testConnection');
        expect(titles).toContain('settingsProviders.detail.testNotSupported');
    });

    it('offers Test connection only for a projected safe probe capability', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:machine-a',
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.detail.testConnection');
    });

    it('labels only an externally sourced Provider connection as experimental', async () => {
        state.connection = connection({ provenance: 'external' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const external = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const externalSource = external.findAllByType('Item')
            .find((item) => item.props.subtitle === 'settingsProviders.detail.sourceAvailable');
        expect(externalSource?.props.subtitleAccessory.props.label)
            .toBe('settingsProviders.compatibility.experimental');

        state.connection = connection({ provenance: 'first_party' });
        const bundled = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const bundledSource = bundled.findAllByType('Item')
            .find((item) => item.props.subtitle === 'settingsProviders.detail.sourceAvailable');
        expect(bundledSource?.props.subtitleAccessory).toBeUndefined();
    });

    it('renders an initial typed load failure instead of falsely claiming the connection was deleted', async () => {
        state.connection = null;
        state.error = {
            v: 1, code: 'provider_endpoint_unavailable', retryable: true, action: 'retry', connectionId: 'pc_a',
        };
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('settingsProviders.errors.unreachableTitle');
        expect(titles).toContain('settingsProviders.errors.actions.retry');
        expect(titles).not.toContain('settingsProviders.detail.notFoundTitle');
    });

    it('renders a failed probe actionably inside the Test connection row', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        probeProviderConnection.mockResolvedValue({
            status: 'error',
            error: { v: 1, code: 'provider_endpoint_unreachable', retryable: true, action: 'retry' },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await pressAndFlush(testRow);

        const updatedTestRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(updatedTestRow?.props.subtitle).toBe('settingsProviders.errors.unreachableDescription');
    });

    it('normalizes a thrown probe failure through the shared typed Provider boundary', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        probeProviderConnection.mockRejectedValueOnce(new Error('socket implementation detail'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');

        await pressAndFlush(testRow);

        const updatedTestRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(updatedTestRow?.props.subtitle).toBe('settingsProviders.errors.unreachableDescription');
    });

    it('clears the previous machine probe result when the target machine changes', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:machine-a',
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await pressAndFlush(testRow);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await act(async () => {
            administrationTarget.controller.select('machine-b');
        });
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('ignores a probe response that completes after the target machine changes', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await act(async () => { testRow?.props.onPress?.(); });
        await act(async () => { administrationTarget.controller.select('machine-b'); });
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });
        const updated = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(updated?.props.subtitle).toBe('settingsProviders.detail.testDescription');
        expect(updated?.props.loading).toBe(false);
    });

    it('retains successful Test connection truth across a display-only rename', async () => {
        state.connection = connection({
            displayName: 'Original name', displayNameMode: 'custom', revision: 1,
            probeCapability: 'catalog', authorized: true,
            probeObservationIdentity: 'probe-observation:v1:current-observation',
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await pressAndFlush(testRow);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        state.connection = connection({
            displayName: 'Renamed only', displayNameMode: 'custom', revision: 2,
            probeCapability: 'catalog', authorized: true,
            probeObservationIdentity: 'probe-observation:v1:current-observation',
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
        });
        await act(async () => {
            administrationTarget.controller.select('machine-a');
        });

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');
    });

    it('invalidates successful Test connection truth when the daemon observation identity changes', async () => {
        const facts = {
            revision: 1,
            probeCapability: 'catalog', authorized: true,
            credential: { required: true, accountBound: true, boundMachineIds: [] },
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
        };
        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:secret-record-one',
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:secret-record-two',
        });
        await pressAndFlush(testRow);

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('ignores a probe response that completes after the daemon observation identity changes', async () => {
        const facts = {
            revision: 1,
            probeCapability: 'catalog', authorized: true,
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
        };
        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:request-one',
        });
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await act(async () => { testRow?.props.onPress?.(); });

        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:request-two',
        });
        await act(async () => {
            administrationTarget.controller.select('machine-a');
        });
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });

        const updated = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(updated?.props.subtitle).toBe('settingsProviders.detail.testDescription');
        expect(updated?.props.loading).toBe(false);
    });

    it('fails closed when a null-identity daemon replaces an otherwise identical connection snapshot', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: null,
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await pressAndFlush(testRow);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('conservatively clears legacy-daemon probe truth when revision or projected security state changes', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            revision: 1,
            credential: { required: true, accountBound: false, boundMachineIds: [] },
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        state.connection = connection({
            probeCapability: 'catalog',
            revision: 2,
            credential: { required: true, accountBound: true, boundMachineIds: [] },
        });
        await pressAndFlush(testRow);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('ignores a probe response that completes after the connection security scope changes', async () => {
        state.connection = connection({
            probeCapability: 'catalog', revision: 1, scope: 'account',
            endpoints: [{
                endpointTemplateId: 'responses', protocol: 'openai-responses',
                baseUrl: 'https://account.example/v1', effectiveSource: 'accountOverride',
            }],
        });
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await act(async () => { testRow?.props.onPress?.(); });

        state.connection = connection({
            probeCapability: 'catalog', revision: 1, scope: 'machine',
            endpoints: [{
                endpointTemplateId: 'responses', protocol: 'openai-responses',
                baseUrl: 'http://127.0.0.1:8080/v1', effectiveSource: 'machineOverride',
            }],
        });
        await screen.update(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });

        const updated = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        expect(updated?.props.subtitle).toBe('settingsProviders.detail.testDescription');
        expect(updated?.props.loading).toBe(false);
    });

    it('invalidates a successful probe as soon as an access mutation starts', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:access-before-mutation',
            scope: 'account',
            grants: {
                accountEnabled: true,
                enabledMachineIds: [],
                accountState: 'valid',
                machineState: 'absent',
                effectiveState: 'valid',
            },
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        run.mockReturnValue(new Promise(() => undefined));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection');
        await pressAndFlush(testRow);
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        const accountRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        await act(async () => { accountRow?.props.rightElement.props.onValueChange(false); });

        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.testConnection')?.props.subtitle)
            .toBe('settingsProviders.detail.testDescription');
    });

    it('retries the exact typed detail mutation instead of substituting a connection read', async () => {
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const accountRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');

        await act(async () => { await accountRow?.props.rightElement.props.onValueChange(true); });
        const retry = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        await act(async () => { await retry?.props.onPress?.(); });

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('reviews an unknown detail mutation by refreshing the current connection without replay', async () => {
        run.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const accountRow = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');

        await act(async () => { await accountRow?.props.rightElement.props.onValueChange(true); });
        const review = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState');
        expect(review).toBeDefined();
        const readsBeforeReview = providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        await act(async () => { await review?.props.onPress?.(); });

        expect(run).toHaveBeenCalledOnce();
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toHaveLength(readsBeforeReview + 1);
    });

    it('shows account access and machine grants together for a mixed connection', async () => {
        state.connection = connection({
            scope: 'machine', authorized: true,
            grants: {
                accountEnabled: true, enabledMachineIds: ['machine-a'],
                accountState: 'valid', machineState: 'valid', effectiveState: 'valid',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('settingsProviders.detail.accountAccess');
        // Machine rows are named by the canonical Administration candidate
        // projection, not by a second lookup in the active server's store.
        expect(titles).toContain('Mac');
        expect(titles).toContain('Linux box');
    });

    it('enables the exact selected machine from its not-enabled recovery action', async () => {
        state.connection = connection({
            scope: 'machine',
            authorized: false,
            grants: {
                accountEnabled: false, enabledMachineIds: [],
                accountState: 'absent', machineState: 'absent', effectiveState: 'absent',
            },
            authorizationError: createProviderErrorV1('provider_not_enabled_on_machine', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const enable = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.errors.actions.enableOnMachine');
        expect(enable).toBeDefined();

        await pressAndFlush(enable);

        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            action: 'setEnabled',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            enabled: true,
        }));
        expect(screen.findByType('MachineAdministrationTargetSelector').props.selection.selectedTarget.machineId)
            .toBe('machine-a');
    });

    it('returns a successfully deleted connection to the Provider index without requiring back history', async () => {
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const remove = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle');

        await pressAndFlush(remove);

        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            action: 'delete',
            machineId: 'machine-a',
            connectionId: 'pc_a',
        }));
        expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers');
        expect(router.back).not.toHaveBeenCalled();
    });

    it('refuses a confirmed delete once the machine selection moved while the modal was open', async () => {
        // The confirmation authorized deleting the connection on machine-a. By
        // the time it resolved the user had switched targets, so running the
        // captured request would delete on a machine they never confirmed.
        confirm.mockReset();
        confirm.mockImplementationOnce(async () => {
            administrationTarget.controller.select('machine-b');
            return true;
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const remove = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle');

        await pressAndFlush(remove);

        expect(confirm).toHaveBeenCalledOnce();
        expect(run.mock.calls.map((call) => (call[0] as { action?: string }).action))
            .not.toContain('delete');
        expect(router.replace).not.toHaveBeenCalled();
        // The detail view has already re-scoped to the newly selected machine,
        // so the refusal is silent by the existing scope contract rather than
        // surfacing an error about the machine the user just left.
        expect(screen.findByType('MachineAdministrationTargetSelector')
            .props.selection.selectedTarget.machineId).toBe('machine-b');
    });

    it('admits one delete confirmation and re-enables the action after cancellation', async () => {
        const confirmation = createDeferred<boolean>();
        confirm.mockReturnValueOnce(confirmation.promise).mockResolvedValueOnce(false);
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await act(async () => {
            const remove = screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle');
            remove?.props.onPress?.();
            remove?.props.onPress?.();
            await Promise.resolve();
        });

        expect(confirm).toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle')?.props)
            .toMatchObject({ loading: true, disabled: true });

        await act(async () => {
            confirmation.resolve(false);
            await confirmation.promise;
            await Promise.resolve();
        });
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle')?.props)
            .toMatchObject({ loading: false, disabled: false });

        await pressAndFlush(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle'));
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(run).not.toHaveBeenCalled();
    });

    it('admits one delete mutation and re-enables the action after failure', async () => {
        const deletion = createDeferred<never>();
        run.mockReturnValueOnce(deletion.promise);
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await act(async () => {
            const remove = screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle');
            remove?.props.onPress?.();
            remove?.props.onPress?.();
            for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
        });

        expect(confirm).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledOnce();
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle')?.props)
            .toMatchObject({ loading: true, disabled: true });

        await act(async () => {
            deletion.reject(new Error('delete acknowledgement unavailable'));
            try {
                await deletion.promise;
            } catch {
                // The mutation owner translates transport failure into typed recovery.
            }
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        expect(router.replace).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle')?.props)
            .toMatchObject({ loading: false, disabled: false });

        confirm.mockResolvedValueOnce(false);
        await pressAndFlush(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.deleteTitle'));
        expect(confirm).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenCalledOnce();
    });

    it('labels account and machine grant switches with their owning rows', async () => {
        state.connection = connection({
            scope: 'machine', authorized: true,
            grants: {
                accountEnabled: true, enabledMachineIds: ['machine-a'],
                accountState: 'valid', machineState: 'valid', effectiveState: 'valid',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const switchRows = screen.findAllByType('Item').filter((item) => (
            typeof item.props.rightElement?.props?.onValueChange === 'function'
        ));

        expect(switchRows.length).toBeGreaterThan(0);
        for (const row of switchRows) {
            expect(row.props.rightElement.props.accessibilityLabel).toBe(row.props.title);
        }
    });

    it('qualifies endpoint reset and machine-override actions with their protocol', async () => {
        state.connection = connection({
            endpoints: [
                {
                    endpointTemplateId: 'responses', protocol: 'openai-responses',
                    baseUrl: 'https://gateway.example/responses', effectiveSource: 'accountOverride',
                },
                {
                    endpointTemplateId: 'anthropic', protocol: 'anthropic',
                    baseUrl: 'https://gateway.example/anthropic', effectiveSource: 'template',
                },
            ],
        });
        expect(createProviderConnectionsDescribeFixture({
            connections: [state.connection as ReturnType<typeof createProviderConnectionViewFixture>],
        }).connections[0]?.endpoints).toHaveLength(2);
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const actionRows = screen.findAllByType('Item').filter((item) => (
            item.props.title === 'settingsProviders.detail.resetEndpoint'
            || item.props.title === 'settingsProviders.detail.endpointMachine'
        ));

        expect(actionRows.map((item) => item.props.accessibilityLabel)).toEqual([
            'openai-responses, settingsProviders.detail.endpointDefault, settingsProviders.detail.resetEndpoint',
            'openai-responses, settingsProviders.detail.endpointMachine',
            'anthropic, settingsProviders.detail.endpointMachine',
        ]);
    });

    it('keeps account/default and machine endpoint controls visible under a machine override', async () => {
        state.connection = connection({
            endpoints: [{
                endpointTemplateId: 'responses', protocol: 'openai-responses',
                baseUrl: 'http://127.0.0.1:8080/v1', effectiveSource: 'machineOverride',
                defaultBaseUrl: 'https://provider.example/v1',
                accountOverrideBaseUrl: 'https://account.example/v1',
                machineOverrideBaseUrl: 'http://127.0.0.1:8080/v1',
            }],
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const rows = screen.findAllByType('Item');
        const defaultRow = rows.find((row) => row.props.accessibilityLabel
            === 'openai-responses, settingsProviders.detail.endpointDefault');
        const machineRow = rows.find((row) => row.props.accessibilityLabel
            === 'openai-responses, settingsProviders.detail.endpointMachine');

        expect(defaultRow?.props.subtitle).toBe('https://account.example/v1');
        expect(machineRow?.props.subtitle).toBe('http://127.0.0.1:8080/v1');
        expect(rows.filter((row) => row.props.title === 'settingsProviders.detail.resetEndpoint'))
            .toHaveLength(2);
    });

    it.each([
        ['provider_account_grant_stale', 'settingsProviders.errors.actions.reviewAccountGrant'],
        ['provider_machine_grant_stale', 'settingsProviders.errors.actions.reviewMachineGrant'],
    ] as const)('renders stale %s access as off with an actionable review', async (code, actionTitle) => {
        state.connection = connection({
            scope: 'machine',
            authorized: false,
            grants: {
                accountEnabled: true, enabledMachineIds: ['machine-a'],
                accountState: 'stale', machineState: 'stale', effectiveState: 'stale',
            },
            authorizationError: {
                v: 1, code, retryable: false,
                action: code === 'provider_account_grant_stale' ? 'review_account_grant' : 'review_machine_grant',
                connectionId: 'pc_a', machineId: 'machine-a',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const account = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType('Item').find((item) => item.props.title === 'Mac');
        expect(account?.props.rightElement.props.value).toBe(false);
        expect(machine?.props.rightElement.props.value).toBe(false);
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toContain(actionTitle);
    });

    it('presents account and current-machine grant validity independently', async () => {
        state.connection = connection({
            scope: 'machine', authorized: true,
            grants: {
                accountEnabled: false,
                enabledMachineIds: ['machine-a'],
                accountState: 'stale',
                machineState: 'valid',
                effectiveState: 'valid',
            },
            authorizationError: null,
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const account = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType('Item').find((item) => item.props.title === 'Mac');

        expect(account?.props.rightElement.props.value).toBe(false);
        expect(machine?.props.rightElement.props.value).toBe(true);
    });

    it('offers direct manual-model recovery when enumeration is unavailable', async () => {
        state.connection = connection({
            probeCapability: 'none', manualModelPolicy: 'allowed',
            runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.models.add');
    });

    it('renders daemon-owned per-agent Works with summaries without inferring protocols', async () => {
        state.connection = connection({
            icon: 'sparkle',
            compatibility: [{
                agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental',
                reasons: ['compatibility_evidence_missing'],
            }],
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const codex = screen.findAllByType('Item').find((item) => item.props.title === 'Codex');
        expect(codex?.props.rightElement.props.label).toBe('settingsProviders.compatibility.experimental');
        expect(codex?.props.subtitle).toContain('settingsProviders.compatibility.experimentalDescription');
        expect(codex?.props.subtitle).toContain('settingsProviders.compatibility.reasons.evidenceMissing');
    });

    it('keeps unknown compatibility fallback coverage at the presentation boundary', () => {
        expect(presentProviderCompatibilityReasons(['future_reason_from_newer_daemon']))
            .toEqual([{ descriptionKey: 'settingsProviders.compatibility.reasons.unknown', known: false }]);
    });

    it('uses the canonical connection presentation status instead of treating authorization as health', async () => {
        state.connection = connection({
            authorized: true,
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
            runtime: { health: 'unreachable', modelCount: 4, checkedAt: 1, endpoints: [] },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const status = screen.findAllByType('Item')
            .find((item) => item.props.title === 'Acme')?.props.rightElement;
        expect(status?.props.label).toBe('settingsProviders.status.unreachable');
        expect(status?.props.variant).toBe('danger');
    });

    it('distinguishes adopted local service ownership and offers managed start when installed', async () => {
        state.discoveryCandidates = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme',
            providerName: 'Acme', endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:11434/',
            evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
            connection: { status: 'matched', connectionId: 'pc_a' },
        }];
        state.localInstallations = [{
            v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme',
            providerName: 'Acme', status: 'installed_not_running', managedStartAvailable: true,
        }];
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(screen.findAllByType('Item').map((item) => item.props.subtitle))
            .toContain('settingsProviders.local.runningOutsideHappier');
        const start = screen.findAllByType('Item')
            .find((item) => typeof item.props.onPress === 'function'
                && item.props.subtitle === 'settingsProviders.local.installedNotRunning');
        expect(start).toBeDefined();
        await act(async () => { await start?.props.onPress?.(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'startLocal', machineId: 'machine-a', connectionId: 'pc_a',
            contributionKey: 'acme.plugin/acme',
        }), 'start:acme.plugin/acme');
    });

    it('shows projected Provider and Connected Service titles for managed effects without raw implementation ids', async () => {
        connectedServiceRegistryState.entries = [{
            serviceId: 'external-account-service',
            service: {
                pluginId: 'external.connected-service',
                localId: 'account',
            },
            connectCommand: 'happier connect external-account-service',
            supportsOauth: true,
            projectedTitle: 'External account service',
        }];
        connectedAccountProfileState.accounts = [{
            ref: {
                service: {
                    pluginId: 'external.connected-service',
                    localId: 'account',
                },
                accountId: 'work',
            },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'cred-1',
            configurationReady: true,
            configurationRevision: null,
            displayName: 'Work account',
            scopes: [],
        }];
        state.connection = connection({
            providerName: 'External Gateway',
            scope: 'machine',
            deployment: {
                kind: 'managedLocal',
                targetMachineId: 'machine-a',
                effects: {
                    implementationIdentity: {
                        pluginId: 'external.managed.provider',
                        localId: 'gateway',
                    },
                    protocols: ['openai-chat', 'openai-responses'],
                    connectedAccountPurposes: [{
                        purpose: 'upstream-account',
                        service: {
                            pluginId: 'external.connected-service',
                            localId: 'account',
                        },
                        required: true,
                        target: {
                            kind: 'account',
                            account: {
                                service: {
                                    pluginId: 'external.connected-service',
                                    localId: 'account',
                                },
                                accountId: 'work',
                            },
                        },
                    }],
                },
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const rows = screen.findAllByType('Item');
        const implementation = rows.find(
            (item) => item.props.testID === 'provider-connection-managed-implementation',
        );
        const titles = rows.map((item) => item.props.title);

        expect(titles).toEqual(expect.arrayContaining([
            'External Gateway',
            'External account service',
            'settingsProviders.authoring.protocolTitle',
            'settingsProviders.local.subscriptionPolicyTitle',
        ]));
        expect(titles).not.toContain('external.managed.provider/gateway');
        expect(titles).not.toContain('upstream-account');
        expect(titles).not.toContain('external.connected-service/account');
        expect(titles.some((title) => typeof title === 'string' && /(?:account|group):/.test(title))).toBe(false);
        expect(implementation?.props.subtitle).toEqual(expect.stringContaining(
            'settingsProviders.local.startedByHappier',
        ));
        expect(rows.map((item) => item.props.subtitle)).toEqual(expect.arrayContaining([
            'openai-chat · openai-responses',
            'settingsProviders.local.subscriptionPolicyDescription',
            'Work account',
        ]));
        expect(rows.map((item) => item.props.testID)).toEqual(expect.arrayContaining([
            'provider-connection-managed-subscription-policy',
            'provider-connection-managed-implementation',
            'provider-connection-managed-protocols',
            'provider-connection-managed-purpose:upstream-account',
        ]));
        expect(rows.some(
            (item) => item.props.testID === 'provider-connection-managed-dependency',
        )).toBe(false);
        expect(rows.map((item) => item.props.title)).not.toContain('cliproxyapi');
    });

    it('shows localized unavailable copy when the managed target machine is missing', async () => {
        state.connection = connection({
            providerName: 'Managed Gateway',
            scope: 'machine',
            deployment: {
                kind: 'managedLocal',
                targetMachineId: 'machine-missing',
                effects: {
                    implementationIdentity: {
                        pluginId: 'external.managed.provider',
                        localId: 'gateway',
                    },
                    protocols: ['openai-responses'],
                    connectedAccountPurposes: [],
                },
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const implementation = screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-implementation',
        );

        expect(implementation?.props.subtitle).toBe(
            'settingsProviders.local.startedByHappier · common.unavailable',
        );
        expect(implementation?.props.subtitle).not.toContain('machine-missing');
    });

    it('renders a null managed effect as unavailable without hiding the external escape action', async () => {
        state.connection = connection({
            sourceStatus: 'unavailable',
            scope: 'machine',
            deployment: {
                kind: 'managedLocal',
                targetMachineId: 'machine-a',
                effects: null,
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const rows = screen.findAllByType('Item');
        const unavailable = rows.find(
            (item) => item.props.testID === 'provider-connection-managed-unavailable',
        );

        expect(unavailable?.props.subtitle).toBe('settingsProviders.status.sourceUnavailable');
        expect(rows.some(
            (item) => item.props.testID === 'provider-connection-managed-use-external',
        )).toBe(true);
        expect(rows.some(
            (item) => item.props.testID === 'provider-connection-managed-implementation',
        )).toBe(false);
    });

    it('activates managed deployment with a structured group choice through the existing connection CAS', async () => {
        connectedAccountProfileState.groups = [{
            v: 1,
            ref: {
                service: {
                    pluginId: 'happier.connected-account.openai',
                    localId: 'openai',
                },
                groupId: 'team',
            },
            incarnation: 'qualified-group-row-team',
            displayName: 'Team pool',
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { quota: true, usageLimit: true } },
            activeConnectedAccountId: null,
            generation: 1,
            runtimeStateRevision: 1,
            state: { status: 'ready' },
            createdAt: 1,
            updatedAt: 1,
            members: [],
        }];
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'upstream',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: true,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const activate = screen.findAllByType('Item').find(
            (item) => item.props.title === 'settingsProviders.local.configureManaged',
        );

        expect(activate).toBeDefined();
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.local.subscriptionPolicyTitle');
        await pressAndFlush(activate);
        expect(run).not.toHaveBeenCalled();
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream',
        );
        await act(async () => {
            chooser?.props.onChange({
                kind: 'group',
                service: {
                    pluginId: 'happier.connected-account.openai',
                    localId: 'openai',
                },
                groupId: 'team',
            });
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        ));
        expect(run).toHaveBeenCalledWith({
            action: 'update',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            expectedRevision: 0,
            deployment: {
                kind: 'managedLocal',
                purposeBindingDefaults: {
                    upstream: {
                        kind: 'group',
                        service: {
                            pluginId: 'happier.connected-account.openai',
                            localId: 'openai',
                        },
                        groupId: 'team',
                    },
                },
            },
        }, 'deployment:managedLocal');
    });

    it('refuses to store a chosen connected-account target the Account no longer offers', async () => {
        // The draft survives a profile refresh, so a group removed after it was
        // chosen would otherwise be written to the daemon as a reference that
        // only fails later.
        connectedAccountProfileState.groups = [{
            v: 1,
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                groupId: 'team',
            },
            incarnation: 'qualified-group-row-team',
            displayName: 'Team pool',
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { quota: true, usageLimit: true } },
            activeConnectedAccountId: null,
            generation: 1,
            runtimeStateRevision: 1,
            state: { status: 'ready' },
            createdAt: 1,
            updatedAt: 1,
            members: [],
        }];
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'upstream',
                    service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                    required: true,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        await act(async () => {
            screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
                (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream',
            )?.props.onChange({
                kind: 'group',
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                groupId: 'team',
            });
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });

        // The Account drops the group while the editor is still open, and the
        // user reloads the chooser's targets through its own refresh action.
        connectedAccountProfileState.groups = [];
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream:reload',
        ));
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        ));

        expect(alert).toHaveBeenCalledWith(
            'settingsProviders.local.invalidPurposeTargetTitle',
            'settingsProviders.local.invalidPurposeTargetDescription',
        );
        expect(run).not.toHaveBeenCalled();
    });

    it('refuses managed connected-account configuration when the target belongs to another server Account', async () => {
        // Connected accounts, their labels, and the qualified-account transport
        // all come from the ACTIVE server's Account. Offering this Account's
        // choices for a target on another server would store a foreign
        // reference that only fails later on that server.
        administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Mac' },
            {
                machineId: 'machine-remote',
                displayName: 'Remote box',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
            },
        ]);
        administrationTarget.controller.select('machine-remote', 'srv_b');
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-remote',
                connectedAccountPurposes: [{
                    purpose: 'telemetry',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: false,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        const testIDs = screen.findAllByType('Item').map((item) => item.props.testID);
        expect(testIDs).toContain('provider-connection-managed-account-scope');
        expect(testIDs).not.toContain('provider-connection-managed-configure');
        expect(run).not.toHaveBeenCalled();
    });

    it('activates managed deployment with empty defaults when every purpose is optional and unbound', async () => {
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'telemetry',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: false,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const activate = screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        );

        await pressAndFlush(activate);
        expect(run).not.toHaveBeenCalled();
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        ));
        expect(alert).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith({
            action: 'update',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            expectedRevision: 0,
            deployment: {
                kind: 'managedLocal',
                purposeBindingDefaults: {},
            },
        }, 'deployment:managedLocal');
    });

    it('reloads Connected Accounts through the canonical profile owner while the chooser is open', async () => {
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'telemetry',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: false,
                }],
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));

        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:telemetry',
        );
        expect(chooser?.props.reloadSubtitle).toBe('settingsProviders.status.disabled');

        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:telemetry:reload',
        ));

        expect(refreshProfile).toHaveBeenCalledTimes(1);
    });

    it('requires a structured target for required purposes and cancellation performs no write', async () => {
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'upstream',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: true,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const activate = screen.findAllByType('Item').find(
            (item) => item.props.title === 'settingsProviders.local.configureManaged',
        );

        await pressAndFlush(activate);
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        ));
        expect(alert).toHaveBeenCalledWith(
            'settingsProviders.local.invalidPurposeTargetTitle',
            'settingsProviders.local.invalidPurposeTargetDescription',
        );
        expect(run).not.toHaveBeenCalled();

        // The English copy for the body this screen just raised must name an
        // action this screen offers. The only editor rendered for a managed
        // purpose is ConnectedAccountPurposeTargetChooser — there is no text
        // field — so instructing an `account:<id>` / `group:<id>` syntax would
        // send the user looking for an input that does not exist.
        const raisedBody = en.settingsProviders.local.invalidPurposeTargetDescription;
        expect(raisedBody).not.toMatch(/\b(account|group)\s*:\s*<?id>?/iu);
        expect(screen.findAllByType('TextInput')).toHaveLength(0);
        expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser).length).toBeGreaterThan(0);

        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-cancel',
        ));
        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').some(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        )).toBe(true);
    });

    it('joins an edited managed-purpose draft to the existing unsaved-changes navigation guard', async () => {
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'telemetry',
                    service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                    required: false,
                }],
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));
        expect(navigationPreventRemove.enabled).toBe(false);

        await act(async () => {
            screen.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({
                kind: 'account',
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                accountId: 'work',
            });
            await Promise.resolve();
        });

        expect(navigationPreventRemove.enabled).toBe(true);
        navigationPreventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
        await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(
            'common.discardChanges',
            'common.unsavedChangesWarning',
            expect.any(Array),
        ));
        const buttons = alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
        await act(async () => { buttons.find((button) => button.text === 'common.keepEditing')?.onPress?.(); });

        expect(navigationDispatch).not.toHaveBeenCalled();
        expect(screen.findAllByType('Item').some(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        )).toBe(true);
    });

    it('edits future managed defaults and explicitly contracts back to external', async () => {
        connectedAccountProfileState.groups = [{
            v: 1,
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                groupId: 'future-team',
            },
            incarnation: 'qualified-group-row-future-team',
            displayName: 'Future team pool',
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { quota: true, usageLimit: true } },
            activeConnectedAccountId: null,
            generation: 1,
            runtimeStateRevision: 1,
            state: { status: 'ready' },
            createdAt: 1,
            updatedAt: 1,
            members: [],
        }];
        state.connection = connection({
            revision: 4,
            scope: 'machine',
            deployment: {
                kind: 'managedLocal',
                targetMachineId: 'machine-a',
                effects: {
                    implementationIdentity: {
                        pluginId: 'happier.provider.gateway',
                        localId: 'gateway',
                    },
                    protocols: ['openai-responses'],
                    connectedAccountPurposes: [{
                        purpose: 'upstream',
                        service: {
                            pluginId: 'happier.connected-account.openai',
                            localId: 'openai',
                        },
                        required: true,
                        target: {
                            kind: 'group',
                            service: {
                                pluginId: 'happier.connected-account.openai',
                                localId: 'openai',
                            },
                            groupId: 'team',
                        },
                    }],
                },
            },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposes: [{
                    purpose: 'upstream',
                    service: {
                        pluginId: 'happier.connected-account.openai',
                        localId: 'openai',
                    },
                    required: true,
                }],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const rows = screen.findAllByType('Item');
        const edit = rows.find(
            (item) => item.props.title === 'settingsProviders.local.editManagedDefaults',
        );
        const useExternal = rows.find(
            (item) => item.props.title === 'settingsProviders.local.useExternal',
        );

        expect(edit).toBeDefined();
        expect(useExternal).toBeDefined();
        await pressAndFlush(edit);
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream',
        );
        await act(async () => {
            chooser?.props.onChange({
                kind: 'group',
                service: {
                    pluginId: 'happier.connected-account.openai',
                    localId: 'openai',
                },
                groupId: 'future-team',
            });
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        await pressAndFlush(screen.findAllByType('Item').find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-save',
        ));
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'update',
            connectionId: 'pc_a',
            expectedRevision: 4,
            deployment: {
                kind: 'managedLocal',
                purposeBindingDefaults: {
                    upstream: expect.objectContaining({
                        kind: 'group',
                        groupId: 'future-team',
                    }),
                },
            },
        }), 'deployment:managedLocal');

        await pressAndFlush(useExternal);
        expect(confirm).toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith({
            action: 'update',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            expectedRevision: 4,
            deployment: { kind: 'external' },
        }, 'deployment:external');
    });

    it('offers separate same-source and custom duplication actions', async () => {
        run.mockResolvedValue({ status: 'success', action: 'duplicate', connection: connection() });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const rows = screen.findAllByType('Item');
        expect(rows.map((item) => item.props.title)).toContain('settingsProviders.customTitle');
        await act(async () => {
            await rows.find((item) => item.props.title === 'settingsProviders.customTitle')?.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'duplicate', connectionId: 'pc_a', mode: 'asCustom', displayName: 'Custom copy',
        }), 'duplicate:asCustom');
    });
});
