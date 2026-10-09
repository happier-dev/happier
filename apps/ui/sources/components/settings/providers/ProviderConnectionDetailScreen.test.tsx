import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { act } from 'react-test-renderer';
import { NavigationContext, useNavigation } from '@react-navigation/native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelsFixture,
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import { en } from '@/text/translations/en';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function DetailNavigationBoundary(props: React.PropsWithChildren) {
    const navigation = useNavigation();
    return <NavigationContext.Provider value={navigation}>{props.children}</NavigationContext.Provider>;
}

const state = vi.hoisted(() => ({
    focused: true,
    connection: null as Record<string, unknown> | null,
    discoveryCandidates: [] as Record<string, unknown>[],
    localInstallations: [] as Record<string, unknown>[],
    error: null as Record<string, unknown> | null,
}));
const run = vi.hoisted(() => vi.fn());
const prompt = vi.hoisted(
    () => vi.fn(async (): Promise<string | null> => 'Custom copy'),
);
const confirm = vi.hoisted(() => vi.fn(async () => true));
const alert = vi.hoisted(() => vi.fn());
const alertAsync = vi.hoisted(() => vi.fn(async () => undefined));
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
const probeProviderConnection = vi.hoisted(() => vi.fn());
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
const account = createProviderSettingsAccountHarness();
let foreignServerId = '';
let machines = [createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now(), metadata: {
    host: 'mac.local', platform: 'darwin', displayName: 'Mac', happyCliVersion: 'test',
    happyHomeDir: '/Users/tester/.happy', homeDir: '/Users/tester',
} }), createMachineFixture({ id: 'machine-b', kind: 'persistent', activeAt: Date.now(), metadata: {
    host: 'linux.local', platform: 'linux', displayName: 'Linux box', happyCliVersion: 'test',
    happyHomeDir: '/home/tester/.happy', homeDir: '/home/tester',
} })];
const administrationTarget = {
    controller: {
        async setMachines(entries: ReadonlyArray<Readonly<{ machineId: string; displayName?: string; serverId?: string; serverIdentityId?: string; serverLabel?: string }>>) {
            const byServer = new Map<string, ReturnType<typeof createMachineFixture>[]>();
            byServer.set(account.serverId, []);
            if (foreignServerId) byServer.set(foreignServerId, []);
            for (const entry of entries) {
                const serverId = entry.serverId === 'server-b' ? foreignServerId : account.serverId;
                const group = byServer.get(serverId) ?? [];
                group.push(createMachineFixture({ ...machines[0], id: entry.machineId, activeAt: Date.now(),
                    metadata: { ...machines[0]!.metadata!, displayName: entry.displayName ?? entry.machineId } }));
                byServer.set(serverId, group);
            }
            for (const [serverId, rows] of byServer) await account.publishMachines(serverId, rows);
        },
        async select(machineId: string, serverIdentityId?: string) {
            await account.selectMachine(serverIdentityId === 'srv_b' ? foreignServerId : account.serverId, machineId);
        },
    },
};

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/settings/providers/cpx-moving', router,
            navigation: { dispatch: navigationDispatch, addListener: () => () => undefined, isFocused: () => true },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: { openURL: openUrl },
        });
    },
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { prompt, confirm, alert, alertAsync },
        }).module;
    },
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return { ...createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    }), useIsFocused: () => state.focused };
});

// Legend's third-party native recycler requires platform layout/scroll geometry.
// The canonical native adapter supplies that boundary and invokes the real header/row renderers.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

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

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

/** The header's Test action with its result line, read as one control (null result = nothing shown). */
function findTestRow(screen: RenderedScreen) {
    const button = screen.findByTestId('provider-connection-test');
    if (!button) return undefined;
    const result = findComposite(screen, 'provider-connection-probe-result', 'text');
    return {
        props: {
            onPress: button.props.onPress as (() => void) | undefined,
            loading: Boolean(button.props.loading),
            subtitle: (result?.props.text ?? null) as string | null,
        },
    };
}

/** One entry of the entity header's `⋯` menu, as a pressable row. */
function findMenuAction(screen: RenderedScreen, id: string) {
    const actions = findComposite(screen, 'provider-connection-menu', 'actions')?.props.actions as
        | Array<{ id: string; disabled?: boolean; onSelect: () => unknown }>
        | undefined;
    const action = actions?.find((entry) => entry.id === id);
    return action ? { props: { onPress: action.onSelect, disabled: Boolean(action.disabled) } } : undefined;
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


/** The rendered component that carries `prop` for a test id (the host view under it carries none). */
function findComposite(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string, prop: string) {
    return screen.findAllByTestId(testID).find((node) => node.props[prop] !== undefined) ?? null;
}

await loadSyncSingletonForTests();
const [{ Item }, { ItemGroup }] = await Promise.all([
    import('@/components/ui/lists/Item'), import('@/components/ui/lists/ItemGroup'),
]);
const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');

/** Error pages now use the real shared state card, not a pair of Item rows. */
function presentedTitles(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const errors = screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('provider-error:') && typeof node.props.title === 'string');
    return [...screen.findAllByType(Item).map(item => item.props.title),
        ...errors.flatMap(node => [node.props.title, node.props.action?.label].filter(Boolean))];
}

function findProviderRecoveryAction(screen: Awaited<ReturnType<typeof renderScreen>>, label: string) {
    return screen.findAll(node => node.props.accessibilityRole === 'button'
        && node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
}

describe('ProviderConnectionDetailScreen', () => {
    afterEach(async () => { standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        providerHarness.reset();
        machines = machines.map(machine => createMachineFixture({ ...machine, activeAt: Date.now() }));
        state.focused = true;

        state.connection = connection();
        state.discoveryCandidates = [];
        state.localInstallations = [];
        state.error = null;
        run.mockReset();
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
        await account.restore({ serverIdentityId: 'srv_provider_detail', machines, waivedActions: [
            'providers.connections.update', 'providers.connections.enabled.set', 'providers.connections.delete',
            'providers.connections.duplicate', 'providers.connections.endpoint.set', 'providers.connections.start_local',
            'providers.connections.secrets.bind', 'providers.probe',
        ] });
        await account.selectMachine(account.serverId, 'machine-a');
        foreignServerId = await account.addHome({ name: 'Other Provider Account', serverUrl: 'https://provider-detail-foreign.test',
            serverIdentityId: 'srv_b', accountId: 'account-foreign', active: false });
        const [{ storage }, registry, { captureActiveServerAccountScopeLifetime }] = await Promise.all([
            import('@/sync/domains/state/storage'), import('@/sync/domains/connectedServices/connectedServiceRegistry'),
            import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        for (const [field, key] of [['accounts', 'connectedAccountsV4'], ['groups', 'connectedAccountGroupsV4']] as const) {
            Object.defineProperty(connectedAccountProfileState, field, {
                configurable: true, get: () => storage.getState().profile[key],
                set: value => {
                    const profile = AccountProfileSchema.parse({ ...storage.getState().profile, [key]: value });
                    storage.getState().applyProfile(profile);
                    account.home.answer(account.serverId, '/v1/account/profile', { body: profile });
                },
            });
        }
        Object.defineProperty(connectedServiceRegistryState, 'entries', {
            configurable: true, get: () => registry.getConnectedServiceRegistrySnapshot().entries,
            set: (entries: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
                const descriptors = entries.map(entry => {
                    const service = entry.service as { pluginId: string; localId: string };
                    return ConnectedAccountUiProjectionEntryV1Schema.parse({
                        id: service.localId, pluginId: service.pluginId, serviceId: entry.serviceId,
                        provenance: 'external', sourceKind: 'plugin', title: entry.projectedTitle ?? entry.serviceId,
                        authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                            pkce: 'required', outcomeReconciliation: 'none' }] },
                        capabilities: [], availability: { state: 'available', reason: 'installed' }, diagnostics: [],
                    });
                });
                registry.installConnectedAccountDescriptorProjection({ scopeKey: account.serverId, status: 'ready',
                    descriptors, conflicts: [], errorReason: null }, captureActiveServerAccountScopeLifetime());
            },
        });
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai', service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
            projectedTitle: 'OpenAI',
        }];
        account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
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

    it('requests no Provider data when blurred and only selected-machine data for an account connection', async () => {
        state.focused = false;
        const detail = (section?: string) => <DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId="pc_a" section={section} />
        </DetailNavigationBoundary>;
        const screen = await renderScreen(detail());
        await flushHookEffects();
        const describeRequests = () => providerHarness.state.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        const modelRequests = () => providerHarness.state.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODELS);
        expect(describeRequests()).toHaveLength(0);
        expect(modelRequests()).toHaveLength(0);
        state.focused = true;
        await screen.update(detail('models'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-detail')).toBeTruthy());
        await flushHookEffects();
        expect(describeRequests()).toHaveLength(1);
        expect(modelRequests()).toHaveLength(1);
    });

    it('recovers a directly opened detail route when Provider availability finishes loading', async () => {
        const { deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        let releaseFeatures!: () => void;
        const pending = new Promise<void>(resolve => { releaseFeatures = resolve; });
        const features = createRootLayoutFeaturesResponse({ features: { providers: { enabled: true } } });
        account.home.answer(account.serverId, '/v1/features', { body: features, respondAfter: pending });
        account.home.answer(account.serverId, '/v1/features/authenticated', { body: features, respondAfter: pending });
        deleteServerFeaturesSnapshot({ serverId: account.serverId });
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(providerHarness.state.requests).toHaveLength(0);
        await act(async () => { releaseFeatures(); await account.publishFeatures(account.serverId, features); await flushHookEffects(); });
        expect(findComposite(screen, 'provider-connection-header', 'title')?.props.title).toBe('Acme');
    });

    it('renders connection identity supplied by the shared Provider RPC boundary', async () => {
        state.connection = createProviderConnectionViewFixture({
            displayName: 'Boundary detail', providerName: 'Boundary detail',
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await waitForHomeGovernance(() => expect({
            title: findComposite(screen, 'provider-connection-header', 'title')?.props.title,
            titles: presentedTitles(screen), requests: providerHarness.state.requests,
        }).toMatchObject({ title: 'Boundary detail' }));
    });

    it('keeps foreign-daemon inspection but disables active-Account Saved Secrets with colliding ids', async () => {
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Account A machine' },
            {
                machineId: 'machine-a',
                displayName: 'Account B machine',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
                serverLabel: 'Server B',
            },
        ]);
        await administrationTarget.controller.select('machine-a', 'srv_b');
        state.connection = connection({
            credential: {
                required: true,
                accountBound: true,
                boundMachineIds: ['machine-a'],
            },
        });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await flushHookEffects();

        expect(providerHarness.state.requests.some((request) => (
            request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE
            && request.serverId === resolveServerProfileScopeIdForIdentifier(foreignServerId)
        ))).toBe(true);
        for (const testID of [
            'provider-connection-account-api-key',
            'provider-connection-machine-api-key',
        ]) {
            const row = screen.findAllByType(Item).find((item) => item.props.testID === testID);
            // The key's Replace stays visible but cannot open the other Account's Saved Secrets.
            expect(row?.props.rightElement.props.disabled).toBe(true);
            expect(row?.props.onPress).toBeUndefined();
            expect(row?.props.subtitle).toBe('settingsProviders.local.accountScopeMismatchDescription');
        }
        expect(run).not.toHaveBeenCalled();
    });

    it('offers an Account Provider credential to an exact Team through the canonical source picker', async () => {
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true } },
        } }));
        state.connection = connection({
            credential: { required: true, accountBound: true, boundMachineIds: [] },
            teamCredentialSourceOffer: {
                connectionId: 'pc_a',
                connectionSecurityFingerprint: 'connection-security:v1:current',
                credentialSlotId: 'apiKey',
                label: 'Acme',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        const shareRow = screen.findAllByType(Item)
            .find((item) => item.props.testID === 'provider-connection-share-with-team');
        expect(shareRow).toBeDefined();
        await pressAndFlush(shareRow);

        expect(router.push).toHaveBeenCalledWith(
            `/settings/teams?credentialSourceKind=provider_connection&credentialSourceServerId=${account.serverId}&credentialSourceConnectionId=pc_a&credentialSourceSlotId=apiKey&credentialSourceMachineId=machine-a&credentialSourceConnectionSecurityFingerprint=connection-security%3Av1%3Acurrent`,
        );
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
        const titles = presentedTitles(screen);
        const testStatusBefore = findTestRow(screen)?.props.subtitle;

        expect(findMenuAction(screen, 'website')).toBeDefined();
        expect(titles).not.toContain('settingsProviders.links.getApiKey');
        await pressAndFlush(findMenuAction(screen, 'website'));

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test');
        expect(run).not.toHaveBeenCalled();
        expect(state.connection).toBe(initialConnection);
        expect(findTestRow(screen)?.props.subtitle)
            .toBe(testStatusBefore);
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
        const titles = presentedTitles(screen);
        const getKeyRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.links.getApiKey');

        expect(findMenuAction(screen, 'website')).toBeUndefined();
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

        await pressAndFlush(findMenuAction(screen, 'website'));

        expect(alert).toHaveBeenCalledWith('common.error', 'settingsProviders.links.failedToOpen');
        expect(findComposite(screen, 'provider-connection-header', 'title')?.props.title).toBe('Acme');
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
        const unavailableTitles = presentedTitles(unavailable);
        expect(findMenuAction(unavailable, 'website')).toBeUndefined();
        expect(unavailableTitles).not.toContain('settingsProviders.links.getApiKey');

        state.connection = connection({
            contributionKey: null,
            provenance: 'custom',
        });
        const custom = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const customTitles = presentedTitles(custom);
        expect(findMenuAction(custom, 'website')).toBeUndefined();
        expect(customTitles).not.toContain('settingsProviders.links.getApiKey');
    });

    it('omits Test connection and explains first-session checking when no safe probe exists', async () => {
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findTestRow(screen)).toBeUndefined();
        expect(findComposite(screen, 'provider-connection-probe-result', 'text')?.props.text)
            .toBe('settingsProviders.detail.testOnFirstSession');
    });

    it('offers Test connection only for a projected safe probe capability', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:machine-a',
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findTestRow(screen)).toBeDefined();
    });

    it('labels only an externally sourced Provider connection as experimental', async () => {
        state.connection = connection({ provenance: 'external' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const external = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findComposite(external, 'provider-connection-experimental', 'label')?.props.label)
            .toBe('settingsProviders.compatibility.experimental');

        state.connection = connection({ provenance: 'first_party' });
        const bundled = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(bundled.findByTestId('provider-connection-experimental')).toBeNull();
    });

    it('renders an initial typed load failure instead of falsely claiming the connection was deleted', async () => {
        state.connection = null;
        state.error = {
            v: 1, code: 'provider_endpoint_unavailable', retryable: true, action: 'retry', connectionId: 'pc_a',
        };
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = presentedTitles(screen);
        expect(titles).toContain('settingsProviders.errors.unreachableTitle');
        expect(titles).toContain('settingsProviders.errors.actions.retry');
        expect(screen.findByTestId('provider-connection-not-found')).toBeNull();
    });

    it('reports a failed probe beside the header Test action', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        probeProviderConnection.mockResolvedValue({
            status: 'error',
            error: { v: 1, code: 'provider_endpoint_unreachable', retryable: true, action: 'retry' },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);

        const updatedTestRow = findTestRow(screen);
        expect(updatedTestRow?.props.subtitle).toBe('settingsProviders.errors.unreachableDescription');
    });

    it('normalizes a thrown probe failure through the shared typed Provider boundary', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        probeProviderConnection.mockRejectedValueOnce(new Error('socket implementation detail'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);

        await pressAndFlush(testRow);

        const updatedTestRow = findTestRow(screen);
        expect(updatedTestRow?.props.subtitle).toBe('externalSessions.browseAgentFailed');
        expect(updatedTestRow?.props.subtitle).not.toContain('socket implementation detail');
    });

    it('clears the previous machine probe result when the target machine changes', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:machine-a',
        });
        probeProviderConnection.mockResolvedValue({ status: 'success' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        expect(findTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await act(async () => {
            await administrationTarget.controller.select('machine-b');
        });
        expect(findTestRow(screen)?.props.subtitle)
            .toBeNull();
    });

    it('ignores a probe response that completes after the target machine changes', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);
        await act(async () => { testRow?.props.onPress?.(); });
        await act(async () => { await administrationTarget.controller.select('machine-b'); });
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });
        const updated = findTestRow(screen);
        expect(updated?.props.subtitle).toBeNull();
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
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        expect(findTestRow(screen)?.props.subtitle)
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
            await administrationTarget.controller.select('machine-a');
        });

        expect(findTestRow(screen)?.props.subtitle)
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
        const testRow = findTestRow(screen);
        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:secret-record-two',
        });
        await pressAndFlush(testRow);

        expect(findTestRow(screen)?.props.subtitle)
            .toBeNull();
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
        const testRow = findTestRow(screen);
        await act(async () => { testRow?.props.onPress?.(); });

        state.connection = connection({
            ...facts,
            probeObservationIdentity: 'probe-observation:v1:request-two',
        });
        await act(async () => {
            await administrationTarget.controller.select('machine-a');
        });
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });

        const updated = findTestRow(screen);
        expect(updated?.props.subtitle).toBeNull();
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
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        expect(findTestRow(screen)?.props.subtitle)
            .toBeNull();
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
        const testRow = findTestRow(screen);
        state.connection = connection({
            probeCapability: 'catalog',
            revision: 2,
            credential: { required: true, accountBound: true, boundMachineIds: [] },
        });
        await pressAndFlush(testRow);
        expect(findTestRow(screen)?.props.subtitle)
            .toBeNull();
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
        const testRow = findTestRow(screen);
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

        const updated = findTestRow(screen);
        expect(updated?.props.subtitle).toBeNull();
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
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        expect(findTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        const accountRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        await act(async () => { accountRow?.props.rightElement.props.onValueChange(false); });

        expect(findTestRow(screen)?.props.subtitle)
            .toBeNull();
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
        const accountRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');

        await act(async () => { await accountRow?.props.rightElement.props.onValueChange(true); });
        const retry = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        await act(async () => { await retry?.props.onPress?.(); });

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('reviews an unknown detail mutation by refreshing the current connection without replay', async () => {
        run.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const accountRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');

        await act(async () => { await accountRow?.props.rightElement.props.onValueChange(true); });
        const review = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState');
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
        const titles = presentedTitles(screen);
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
        const enable = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.enableOnMachine');
        expect(enable).toBeDefined();

        await pressAndFlush(enable);

        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            action: 'setEnabled',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            enabled: true,
        }));
    });

    it('returns a successfully deleted connection to the Provider index without requiring back history', async () => {
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const remove = findMenuAction(screen, 'delete');

        await pressAndFlush(remove);

        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            action: 'delete',
            machineId: 'machine-a',
            connectionId: 'pc_a',
        }));
        expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers');
        expect(router.back).not.toHaveBeenCalled();
    });

    it('uses default Ask-first approval once and navigates only after its real terminal result', async () => {
        await account.restore({ accountId: 'default-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect({
            remove: findMenuAction(screen, 'delete'), titles: presentedTitles(screen),
            requests: providerHarness.state.requests,
        }).toMatchObject({ remove: expect.anything() }));
        await act(async () => {
            const remove = findMenuAction(screen, 'delete');
            expect(remove).toBeDefined();
            remove!.props.onPress();
            remove!.props.onPress();
            await flushHookEffects();
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(account.home.artifacts(account.serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(account.serverId).list()[0]!.id;
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(account.serverId)}`);
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        await expect(decideApprovalAsInbox(account.serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });
        await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers'));
        expect(run.mock.calls.filter(([input]) => input.action === 'delete')).toHaveLength(1);
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE))
            .toEqual([expect.objectContaining({ serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
                accountId: 'default-approval-account', machineId: 'machine-a',
                payload: expect.objectContaining({ action: 'delete', connectionId: 'pc_a' }) })]);
    });

    it('keeps a durable approval addressed to its captured Machine when selection moves', async () => {
        await account.restore({ accountId: 'captured-machine-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await pressAndFlush(findMenuAction(screen, 'delete'));
        await waitForHomeGovernance(() => expect(account.home.artifacts(account.serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(account.serverId).list()[0]!.id;
        await act(async () => { await account.selectMachine(account.serverId, 'machine-b'); await flushHookEffects(); });
        await decideApprovalAsInbox(account.serverId, artifactId, 'approve');
        const writes = providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE);
        expect(writes).toEqual([expect.objectContaining({ machineId: 'machine-a', payload: expect.objectContaining({ action: 'delete' }) })]);
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('admits one approval request and re-enables deletion after cancellation without writing', async () => {
        await account.restore({ accountId: 'cancelled-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await act(async () => {
            const remove = findMenuAction(screen, 'delete');
            remove?.props.onPress();
            remove?.props.onPress();
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(account.home.artifacts(account.serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(account.serverId).list()[0]!.id;
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        await decideApprovalAsInbox(account.serverId, artifactId, 'cancel');
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(false));
        expect(run).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        await pressAndFlush(findMenuAction(screen, 'delete'));
        await waitForHomeGovernance(() => expect(account.home.artifacts(account.serverId).list()).toHaveLength(2));
        expect(run).not.toHaveBeenCalled();
    });

    it('admits one waived delete mutation and re-enables the action after transport failure', async () => {
        const deletion = createDeferred<never>();
        run.mockReturnValueOnce(deletion.promise);
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await act(async () => {
            const remove = findMenuAction(screen, 'delete');
            remove?.props.onPress();
            remove?.props.onPress();
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledOnce());
        expect(confirm).not.toHaveBeenCalled();
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        await act(async () => { deletion.reject(new Error('delete acknowledgement unavailable')); await flushHookEffects(); });
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(false));
        expect(router.replace).not.toHaveBeenCalled();
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
        const switchRows = screen.findAllByType(Item).filter((item) => (
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
        const actionRows = screen.findAllByType(Item).filter((item) => (
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
        const rows = screen.findAllByType(Item);
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
        const account = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType(Item).find((item) => item.props.title === 'Mac');
        expect(account?.props.rightElement.props.value).toBe(false);
        expect(machine?.props.rightElement.props.value).toBe(false);
        expect(presentedTitles(screen)).toContain(actionTitle);
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
        const account = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType(Item).find((item) => item.props.title === 'Mac');

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
        expect(presentedTitles(screen))
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
        const codex = screen.findAllByType(Item).find((item) => item.props.title === 'Codex');
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
        const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
            Array<{ key: string; text: string }> | undefined;
        expect(meta?.find((fact) => fact.key === 'status')?.text).toBe('settingsProviders.status.unreachable');
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
        expect(screen.findAllByType(Item).map((item) => item.props.subtitle))
            .toContain('settingsProviders.local.runningOutsideHappier');
        const start = screen.findAllByType(Item)
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
            credentialRevision: 'csr_1111111111111111111111',
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
        const rows = screen.findAllByType(Item);
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
        const implementation = screen.findAllByType(Item).find(
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
        const rows = screen.findAllByType(Item);
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
        connectedAccountProfileState.accounts = [{
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                accountId: 'work',
            },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_2222222222222222222222',
            configurationReady: true,
            configurationRevision: null,
            displayName: 'Work account',
            scopes: [],
        }];
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
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
            activeConnectedAccountId: 'work',
            generation: 1,
            runtimeStateRevision: 1,
            state: { status: 'ready' },
            createdAt: 1,
            updatedAt: 1,
            members: [{
                v: 1,
                connectedAccountId: 'work',
                priority: 1,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 1,
            }],
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-managed-configure')).toBeTruthy());
        const activate = screen.findAllByType(Item).find(
            (item) => item.props.title === 'settingsProviders.local.configureManaged',
        );

        expect(activate).toBeDefined();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.local.subscriptionPolicyTitle');
        await pressAndFlush(activate);
        expect(run).not.toHaveBeenCalled();
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream',
        );
        expect(chooser?.props.localizedTextPluginId).toBe('acme.plugin');
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
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
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
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
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
        await pressAndFlush(screen.findAllByType(Item).find(
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
        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:upstream:reload',
        ));
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);

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
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Mac' },
            {
                machineId: 'machine-remote',
                displayName: 'Remote box',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
            },
        ]);
        await administrationTarget.controller.select('machine-remote', 'srv_b');
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

        const testIDs = screen.findAllByType(Item).map((item) => item.props.testID);
        expect(testIDs).toContain('provider-connection-managed-account-scope');
        expect(testIDs).not.toContain('provider-connection-managed-configure');
        expect(run).not.toHaveBeenCalled();
    });

    it('synchronously retires an open Account purpose editor when the target switches to another server', async () => {
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Account A machine' },
            {
                machineId: 'machine-a',
                displayName: 'Account B machine',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
            },
        ]);
        connectedAccountProfileState.groups = [{
            v: 1,
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                groupId: 'account-a-team',
            },
            incarnation: 'qualified-group-row-account-a-team',
            displayName: 'Account A team',
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
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
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));
        expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1);

        await act(async () => {
            await administrationTarget.controller.select('machine-a', 'srv_b');
            await Promise.resolve();
        });

        expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(0);
        expect(presentedTitles(screen))
            .not.toContain('Account A team');
        expect(screen.findAllByType(Item).map((item) => item.props.testID))
            .toContain('provider-connection-managed-account-scope');
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
        const activate = screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        );

        await pressAndFlush(activate);
        expect(run).not.toHaveBeenCalled();
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
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

    it('refuses an empty managed-purpose save only when the producer explicitly requires one binding', async () => {
        state.connection = connection({
            deployment: { kind: 'external' },
            managedLocalOption: {
                targetMachineId: 'machine-a',
                connectedAccountPurposeBindingPolicy: { minimumBound: 1 },
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
        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);

        expect(alert).toHaveBeenCalledWith(
            'settingsProviders.local.invalidPurposeTargetTitle',
            'settingsProviders.local.invalidPurposeTargetDescription',
        );
        expect(run).not.toHaveBeenCalled();
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
        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));

        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const chooser = screen.findAllByType(ConnectedAccountPurposeTargetChooser).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:telemetry',
        );
        expect(chooser?.props.reloadSubtitle).toBe('settingsProviders.status.disabled');

        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:telemetry:reload',
        ));

        expect(account.home.requestsFor('/v1/account/profile').length).toBeGreaterThan(0);
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
        const activate = screen.findAllByType(Item).find(
            (item) => item.props.title === 'settingsProviders.local.configureManaged',
        );

        await pressAndFlush(activate);
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
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
        // (The page's own Name field and model filter sit in other sections.)
        const managedSection = screen.findAllByType(ItemGroup)
            .find((group) => group.props.title === 'settingsProvidersCollection.managedTitle');
        expect(managedSection).toBeDefined();
        expect(managedSection?.findAllByType('TextInput')).toHaveLength(0);
        expect(managedSection?.findAllByType(ConnectedAccountPurposeTargetChooser).length).toBeGreaterThan(0);

        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-cancel') ?? undefined);
        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType(Item).some(
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
        await pressAndFlush(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        ));
        expect(navigationPreventRemove.enabled).toBe(false);

        await act(async () => {
            screen.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({
                kind: 'account',
                account: {
                    service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                    accountId: 'work',
                },
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
        expect(screen.findByTestId('provider-connection-managed-purpose-save')).not.toBeNull();
    });

    it('joins a typed manual-model draft to the same unsaved-changes guard and discards it on a machine change', async () => {
        state.connection = connection({ manualModelPolicy: 'allowed' });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => createProviderModelsFixture({
            connectionId: 'pc_a', connectionRevision: 0, manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent',
            models: [{ id: 'model-one', name: 'Model one', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' }],
        }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { getActiveUnsavedChangesGuard, runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" startAddingModels />);
        await flushHookEffects();
        const manualField = () => findComposite(screen, 'provider-manual-model-ids', 'onChangeText');
        expect(navigationPreventRemove.enabled).toBe(false);

        await act(async () => {
            manualField()?.props.onChangeText('draft-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        // Leaving with the draft asks first; keeping it editing leaves everything in place.
        expect(navigationPreventRemove.enabled).toBe(true);
        navigationPreventRemove.callback?.({ data: { action: { type: 'GO_BACK' } } });
        await vi.waitFor(() => expect(alert).toHaveBeenCalled());
        const keepButtons = alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
        await act(async () => { keepButtons.find((button) => button.text === 'common.keepEditing')?.onPress?.(); });
        expect(navigationDispatch).not.toHaveBeenCalled();
        expect(manualField()?.props.value).toBe('draft-model');

        // Moving to another machine goes through the same guard; discarding clears the draft.
        let navigationResult: true | Promise<boolean> = true;
        await act(async () => {
            navigationResult = runGuardedNavigation(async () => { await administrationTarget.controller.select('machine-b'); });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const discardButtons = alert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await act(async () => {
            discardButtons.find((button) => button.style === 'destructive')?.onPress?.();
            await navigationResult;
        });
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it('edits future managed defaults and explicitly contracts back to external', async () => {
        connectedAccountProfileState.accounts = [{
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                accountId: 'work',
            },
            status: 'connected',
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_2222222222222222222222',
            configurationReady: true,
            configurationRevision: null,
            displayName: 'Work account',
            scopes: [],
        }];
        connectedAccountProfileState.groups = [{
            v: 1,
            ref: {
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' },
                groupId: 'future-team',
            },
            incarnation: 'qualified-group-row-future-team',
            displayName: 'Future team pool',
            policy: { v: 1, strategy: 'least_limited', autoSwitch: true },
            activeConnectedAccountId: 'work',
            generation: 1,
            runtimeStateRevision: 1,
            state: { status: 'ready' },
            createdAt: 1,
            updatedAt: 1,
            members: [{
                v: 1,
                connectedAccountId: 'work',
                priority: 1,
                enabled: true,
                state: {},
                createdAt: 1,
                updatedAt: 1,
            }],
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-managed-use-external')).toBeTruthy());
        const rows = screen.findAllByType(Item);
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
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
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
        expect(confirm).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith({
            action: 'update',
            machineId: 'machine-a',
            connectionId: 'pc_a',
            expectedRevision: 4,
            deployment: { kind: 'external' },
        }, 'deployment:external');
    });

    it('turns the whole connection off from the header with one connection-scope disable', async () => {
        state.connection = connection({
            authorized: true,
            grants: { accountEnabled: true, enabledMachineIds: ['machine-a'], effectiveState: 'valid' },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const enabled = screen.findByTestId('provider-connection-enabled');
        expect(enabled?.props.value).toBe(true);

        await act(async () => { await enabled?.props.onValueChange(false); });

        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'setEnabled', connectionId: 'pc_a', enabled: false, scope: 'connection',
        }), 'pc_a');
    });

    it('remembers the opened connection for the wide landing, whichever layout opened it', async () => {
        const { readLastVisitedProviderConnectionId } = await import('./collection/providerCollectionModel');
        state.connection = connection({ connectionId: 'pc_remembered' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_remembered" />);
        expect(readLastVisitedProviderConnectionId()).toBe('pc_remembered');
    });

    it('shows a saved key as Saved with Replace and never its value', async () => {
        state.connection = connection({
            credential: { required: true, accountBound: true, boundMachineIds: [] },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        expect(findComposite(screen, 'provider-connection-account-api-key.saved', 'label')?.props.label)
            .toBe('settingsProvidersCollection.saved');
        expect(findComposite(screen, 'provider-connection-account-api-key.choose', 'title')?.props.title)
            .toBe('settingsProvidersCollection.replace');
        // No key on this machine yet: it offers to choose one, with no Saved claim.
        expect(screen.findByTestId('provider-connection-machine-api-key.saved')).toBeNull();
        expect(findComposite(screen, 'provider-connection-machine-api-key.choose', 'title')?.props.title)
            .toBe('settingsProvidersCollection.addKey');
    });

    it('offers separate same-source and custom duplication actions', async () => {
        run.mockResolvedValue({ status: 'success', action: 'duplicate', connection: connection() });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findMenuAction(screen, 'duplicate')).toBeDefined();
        await act(async () => {
            await findMenuAction(screen, 'duplicateAsCustom')?.props.onPress?.();
        });
        expect(run).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('provider-connection-duplicate-name', 'Custom copy'); });
        await screen.pressByTestIdAsync('provider-connection-duplicate-save');
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'duplicate', connectionId: 'pc_a', mode: 'asCustom', displayName: 'Custom copy',
        }), 'duplicate:asCustom');
        expect(prompt).not.toHaveBeenCalled();
    });

    it('commits endpoint overrides from the inline field to the same revisioned writer', async () => {
        const endpointId = 'endpoint_main';
        state.connection = connection({ revision: 3, endpoints: [{
            endpointTemplateId: endpointId, protocol: 'openai-chat', baseUrl: 'https://acme.test/v1',
            defaultBaseUrl: 'https://acme.test/v1', accountOverrideBaseUrl: null,
            machineOverrideBaseUrl: null, effectiveSource: 'template',
        }] });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const fieldId = `provider-connection-endpoint.${endpointId}.account`;
        const field = () => screen.findAllByTestId(fieldId).find((node) => typeof node.props.onChangeText === 'function');
        expect(field()).toBeDefined();
        await act(async () => { field()?.props.onChangeText('https://edited.example/v1'); });
        await act(async () => { field()?.props.onSubmitEditing(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'setEndpointOverride', connectionId: 'pc_a', expectedRevision: 3,
            endpointTemplateId: endpointId, scope: 'account', baseUrl: 'https://edited.example/v1',
        }), `endpoint:account:${endpointId}`);
        expect(prompt).not.toHaveBeenCalled();
    });
    it('renames the connection through its update write, with the owner validation inline', async () => {
        state.connection = connection({ displayName: 'Acme', revision: 3 });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const nameField = () => findComposite(screen, 'provider-connection-name', 'onChangeText');
        expect(nameField()?.props.value).toBe('Acme');

        // Leaving the field unchanged writes nothing.
        await act(async () => { await nameField()?.props.onBlur?.(); });
        expect(run).not.toHaveBeenCalled();

        // A name the connection schema refuses is reported under the field, before any write.
        await act(async () => { nameField()?.props.onChangeText('   '); });
        await act(async () => { await nameField()?.props.onSubmitEditing?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(nameField()?.props.error).toBe('settingsProvidersCollection.nameRequired');

        await act(async () => { nameField()?.props.onChangeText('x'.repeat(129)); });
        await act(async () => { await nameField()?.props.onBlur?.(); });
        expect(run).not.toHaveBeenCalled();
        // The limit comes from the connection schema, not from this page.
        expect(nameField()?.props.error).toBe('settingsProvidersCollection.nameTooLong(max=128)');

        await act(async () => { nameField()?.props.onChangeText('  Work  '); });
        expect(nameField()?.props.error).toBeFalsy();
        await act(async () => { await nameField()?.props.onSubmitEditing?.(); });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith({
            action: 'update', machineId: 'machine-a', connectionId: 'pc_a',
            expectedRevision: 3, displayName: 'Work', displayNameMode: 'custom',
        }, 'pc_a');
    });

    it('lists the connection models inside its page, with no second scroll owner', async () => {
        state.connection = connection({ manualModelPolicy: 'allowed', probeCapability: 'catalog' });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => createProviderModelsFixture({
            connectionId: 'pc_a',
            connectionRevision: 0,
            manualModelPolicy: 'allowed',
            modelLoadAction: 'descriptor_absent',
            models: [
                { id: 'model-one', name: 'Model one', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
                { id: 'model-two', name: 'Model two', source: 'static', stale: false, loadState: 'unknown', visibility: 'hidden_all_agents' },
            ],
        }));
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        const { SelectionListScreen } = await import('@/components/ui/selectionList');
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await flushHookEffects();

        const manager = screen.findByType(ProviderModelManager);
        expect(manager.props.page).toBeDefined();
        expect(manager.props.groups[0].rows.map((row: { descriptor: { name: string } }) => row.descriptor.name))
            .toEqual(['Model one', 'Model two']);
        // The page's own sections scroll with the list: the header is part of the same list.
        expect(findComposite(screen, 'provider-connection-header', 'title')?.props.title).toBe('Acme');
        // Hidden models stay out of the list until asked for; the visible one is a row with its switch.
        const { providerModelRowKey } = await import('@/providers/models/modelRowKey');
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'model-one')}`)).not.toBeNull();
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'model-two')}`)).toBeNull();
        expect(screen.findAllByType(SelectionListScreen)).toHaveLength(0);
        expect(screen.findByTestId('provider-connection-manage-models')).toBeNull();
    });
});
