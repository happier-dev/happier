import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { act } from 'react-test-renderer';
import { NavigationContext, useNavigation } from '@react-navigation/native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpc/errors';
import { DaemonProviderConnectionViewV1Schema, DaemonProviderUsageRefreshResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelsFixture,
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
    installBundledProviderDeclarationsRpcBoundary,
    installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSavedSecretCatalogHttpBoundary } from '@/dev/testkit/harness/savedSecretEditorHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderReadyProviderDetail, pressAndFlush, openAdvanced } from './detailScreenTestHelpers';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { presentProviderCompatibilityReasons } from '@/providers/connection/compatibilityReasonPresentation';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { en } from '@/text/translations/en';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function DetailNavigationBoundary(props: React.PropsWithChildren) {
    const navigation = useNavigation<NonNullable<React.ContextType<typeof NavigationContext>>>();
    // Focus belongs to navigation context, which must notify even a memoized screen.
    const focusedNavigation = React.useMemo(() => ({ ...navigation, isFocused: () => state.focused }), [navigation, state.focused]);
    return <NavigationContext.Provider value={focusedNavigation}>{props.children}</NavigationContext.Provider>;
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

/** Opens a purpose chooser's sheet and presses its one Refresh (the modal boundary is mocked). */
async function refreshPurposeTargets(screen: Awaited<ReturnType<typeof renderScreen>>, chooserTestID: string): Promise<void> {
    const { Modal } = await import('@/modal');
    await pressAndFlush(screen.findAllByType(Item).find((item) => item.props.testID === chooserTestID));
    const sheet = vi.mocked(Modal.show).mock.calls.at(-1)?.[0] as
        { props?: { refresh?: { onRefresh(): void } | null } } | undefined;
    await pressAndFlush({ props: { onPress: sheet?.props?.refresh?.onRefresh } });
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
// Import the actual target only after installing its genuine RPC transport boundary.
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
const [{ Item }, { ItemGroup }] = await Promise.all([
    import('@/components/ui/lists/Item'), import('@/components/ui/lists/ItemGroup'),
]);
const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');

/** Populate the genuine Account HTTP leaf for tests that write saved configuration. */
function installDetailCatalog(input: { serverId?: string; saved?: ReturnType<typeof ProviderConnectionV1Schema.parse>;
    catalogSource?: 'manual' | 'probe' } = {}) {
    const view = state.connection!;
    const saved = input.saved ?? ProviderConnectionV1Schema.parse({ v: 1,
        id: view.connectionId, source: { kind: 'custom', template: buildCustomProviderTemplate({
            ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://acme.test/v1',
            requiresApiKey: false, catalog: input.catalogSource ?? 'manual',
        }) }, role: 'named', displayName: view.displayName, displayNameMode: 'custom',
        revision: view.revision, createdAt: 1, updatedAt: 1 });
    state.connection = { ...view, role: saved.role, displayNameMode: saved.displayNameMode,
        contributionKey: saved.source.kind === 'contribution' ? saved.source.contributionKey : null };
    return installProviderConnectionsCatalogHttpBoundary({ home: account.home,
        serverId: input.serverId ?? account.serverId,
        catalog: ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] }) });
}

function accountCatalogWrites() {
    return account.home.requests.filter(request => request.path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 && request.input != null);
}

async function enableDetailAccountConnection(stored: ReturnType<typeof installDetailCatalog>) {
    const [{ mutateProviderConnection }, { buildProviderConnectionEnableMutation }] = await Promise.all([
        import('@/providers/actions/client'), import('@/providers/connection/enableMutation'),
    ]);
    const result = await mutateProviderConnection({ serverId: account.serverId,
        request: buildProviderConnectionEnableMutation({ connectionId: stored.catalog.connections[0]!.id,
            enabled: true, access: 'account' }),
    });
    expect(result.status).toBe('success');
}

/** The daemon commits endpoint health before its successful probe response. */
async function publishSuccessfulProbe() {
    const observedAt = Date.now();
    state.connection = connection({ ...state.connection,
        runtime: { health: 'available', modelCount: 0, checkedAt: observedAt, endpoints: [{
            endpointTemplateId: 'openai-chat', status: 'available', activity: 'idle',
            observedAt, errorCode: null, retryAt: null,
        }] },
    });
    return { status: 'success', models: [], requestFingerprint: 'probe-request:v1:detail' };
}

function installManagedDetailCatalog() {
    const view = createProviderConnectionViewFixture(state.connection as Parameters<typeof createProviderConnectionViewFixture>[0]);
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    connectedServiceRegistryState.entries = [{ serviceId: 'openai-codex', service, projectedTitle: 'ChatGPT' }];
    for (const field of ['accounts', 'groups'] as const) {
        connectedAccountProfileState[field] = connectedAccountProfileState[field].map(row => ({ ...row,
            ref: { ...(row.ref as Record<string, unknown>), service } }));
    }
    const defaults = view.deployment.kind === 'managedLocal'
        ? Object.fromEntries((view.deployment.effects?.connectedAccountPurposes ?? []).map(row => [
            row.purpose === 'upstream' ? 'openai-upstream' : row.purpose, { ...row.target, service },
        ])) : undefined;
    state.connection = { ...view, contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
        deployment: view.deployment.kind === 'managedLocal' ? { ...view.deployment,
            effects: view.deployment.effects ? { ...view.deployment.effects,
                implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                connectedAccountPurposes: view.deployment.effects.connectedAccountPurposes.map(row => ({ ...row,
                    purpose: row.purpose === 'upstream' ? 'openai-upstream' : row.purpose,
                    service, target: { ...row.target, service } })) } : null } : view.deployment,
        managedLocalOption: view.managedLocalOption ? { ...view.managedLocalOption,
            connectedAccountPurposes: view.managedLocalOption.connectedAccountPurposes.map(row => ({ ...row,
                service, purpose: row.purpose === 'upstream' ? 'openai-upstream' : row.purpose })) } : null };
    return installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: view.connectionId,
        source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        role: view.role, displayName: view.displayName, displayNameMode: view.displayNameMode,
        deployment: { kind: view.deployment.kind }, ...(defaults ? { purposeBindingDefaults: defaults } : {}),
        revision: view.revision, createdAt: 1, updatedAt: 1 }) });
}

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
            'providers.connections.secrets.bind', 'providers.probe', 'providers.usage.refresh',
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
                        callbackUrl: 'http://127.0.0.1:4000/auth/callback',
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

    it('does not rerender Provider detail for an unrelated Profile publication', async () => {
        installDetailCatalog();
        let commits = 0;
        const screen = await renderReadyProviderDetail(<React.Profiler id="provider-detail" onRender={() => { commits += 1; }}>
            <ProviderConnectionDetailScreen connectionId="pc_a" />
        </React.Profiler>);
        await act(async () => {});
        const before = commits;
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, firstName: 'Unrelated name' }); });
        expect(commits - before).toBe(0);
        await screen.unmount();
    });

    it('uses Account shown and total catalog counts in the header and Models row without a machine', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_count',
            source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-responses'), name: 'Count source',
                baseUrl: 'https://count.example/v1', requiresApiKey: false, catalog: 'manual',
            }) }, role: 'named', displayName: 'Count source', displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1 });
        const hiddenRef = serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: saved.id, modelId: 'hidden' });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [saved], manualModelsByConnectionId: { [saved.id]: [
                { id: 'shown', name: 'Shown model', addedAt: 1 }, { id: 'hidden', name: 'Hidden model', addedAt: 1 },
            ] }, modelVisibilityByRef: { [hiddenRef]: 'hidden' },
        });
        await account.restore({ accountId: 'account-counts', catalog, machines: [] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId={saved.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-models-row')).not.toBeNull());
        const header = findComposite(screen, 'provider-connection-header', 'meta');
        expect(header?.props.meta.find((entry: { key: string }) => entry.key === 'models')?.text)
            .toBe('settingsProvidersCollection.modelsShown(shown=1,total=2)');
        const row = findComposite(screen, 'provider-connection-models-row', 'detail');
        expect(row?.props.detail).toBe('settingsProvidersCollection.modelsShownCount(count=1)');
        expect(providerHarness.state.requests).toEqual([]);
    });

    it.each([
        ['every model is shown', false],
        ['a model is hidden', true],
    ] as const)('offers Show all models on the Models page only when %s', async (_state, offered) => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_show_all',
            source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-responses'), name: 'Show all source',
                baseUrl: 'https://show-all.example/v1', requiresApiKey: false, catalog: 'manual',
            }) }, role: 'named', displayName: 'Show all source', displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1 });
        const hiddenRef = serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: saved.id, modelId: 'second' });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [saved], manualModelsByConnectionId: { [saved.id]: [
                { id: 'first', name: 'First model', addedAt: 1 }, { id: 'second', name: 'Second model', addedAt: 1 },
            ] }, modelVisibilityByRef: offered ? { [hiddenRef]: 'hidden' } : {},
        });
        await account.restore({ accountId: `account-show-all-${offered}`, catalog, machines: [] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        const { ProviderConnectionModelsScreen } = await import('./models/ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId={saved.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-model-manager.summary')).not.toBeNull());
        expect(screen.findByTestId('provider-model-manager.show-all') !== null).toBe(offered);
    });

    it('offers Show in model picker for a connected built-in provider, which is no longer listed as available', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_deepseek',
            source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
            role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic',
            revision: 1, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        await account.restore({ accountId: 'account-picker-kind', catalog, machines: [] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId={saved.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-models-row')).not.toBeNull());
        // A direct (frontier) provider's models show by default (D8).
        expect(screen.findByTestId('provider-connection-picker-visibility')).not.toBeNull();
    });

    it('shows an Account-enabled, untested connection as on and quiet in the header without a machine', async () => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_on',
            source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-responses'), name: 'On source',
                baseUrl: 'https://on.example/v1', requiresApiKey: false, catalog: 'manual',
            }) }, role: 'named', displayName: 'On source', displayNameMode: 'custom',
            revision: 0, createdAt: 1, updatedAt: 1 });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        // Switch it on through the Account action owner, the same write the Connect flow makes.
        const execute = createAccountProviderActionExecuteV1({
            assertCurrent() {}, now: () => 10,
            readCatalog: async () => ({ status: 'ready', revision: 1, catalog }),
            readDefinitions: async () => [],
            writeCatalog: async (input) => { catalog = input.catalog; return { status: 'updated' }; },
        });
        expect(await execute(parseProviderActionRequestV1('providers.connections.enabled.set', {
            action: 'setEnabled', connectionId: saved.id, scope: 'account', enabled: true,
        }), {})).toMatchObject({ ok: true });
        await account.restore({ accountId: 'account-enabled-header', catalog, machines: [] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId={saved.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-enabled')).not.toBeNull());
        expect(screen.findByTestId('provider-connection-enabled')?.props.value).toBe(true);
        // Healthy and not yet tested says nothing; the Test row owns results (lab PD1).
        const header = findComposite(screen, 'provider-connection-header', 'meta');
        expect(header?.props.meta.map((entry: { key: string }) => entry.key)).not.toContain('status');
    });

    it.each(['running', 'idle'] as const)('reads %s gateway custody from the exact chosen hub while peer reachability stays unchecked', async status => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, gatewayPlacement: { kind: 'machine', machineId: 'machine-b' },
            revision: 3, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        // A new Account lifetime admits this synthetic revision-1 fixture; replaying
        // version 1 in the prior Account correctly retains its already-loaded rows.
        await account.restore({ accountId: `account-gateway-${status}`, catalog, machines,
            waivedActions: ['providers.connections.update'] });
        // This detail belongs to one Home, not the foreign Home also saved by the suite.
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        const target = await renderHook(() => useProviderSettingsTarget());
        expect(target.getCurrent()).toMatchObject({
            machineId: 'machine-a', serverId: account.serverId, selectedTargetServerMatchesActiveAccount: true,
            machineRows: expect.arrayContaining([expect.objectContaining({ online: true,
                target: expect.objectContaining({ machineId: 'machine-b' }) })]),
        });
        expect(target.getCurrent().resolveCurrentTarget()).toEqual({ machineId: 'machine-a', serverId: account.serverId });
        await target.unmount();
        const view = createProviderConnectionViewFixture({ connectionId: saved.id, contributionKey: saved.source.kind === 'contribution' ? saved.source.contributionKey : null,
            revision: saved.revision,
            displayName: saved.displayName, displayNameMode: saved.displayNameMode, role: saved.role,
            deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
            gatewayPlacement: saved.gatewayPlacement,
            // The connection is enabled on its hub, not the machine inspected by this page.
            grants: { accountEnabled: true, enabledMachineIds: ['machine-b'], accountState: 'valid',
                machineState: 'absent', effectiveState: 'absent' },
            managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [{ purpose: 'upstream',
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' }, required: false }] },
            runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [],
                gateway: { status: 'not_checked', reachability: 'not_checked' } },
        });
        state.connection = view;
        const stored = installDetailCatalog({ saved });
        let currentView = view;
        let hubStatus: 'running' | 'idle' = status;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async request => createProviderConnectionsDescribeFixture({
            connections: [{ ...currentView, runtime: { ...currentView.runtime, gateway: {
                status: request.machineId === 'machine-b' ? hubStatus : 'not_checked', reachability: 'not_checked',
            } } }],
        }));
        const detail = () => <DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId={saved.id} />
        </DetailNavigationBoundary>;
        const screen = await renderReadyProviderDetail(detail());
        await waitForHomeGovernance(() => {
            const snapshot = {
                header: findComposite(screen, 'provider-connection-header', 'meta')?.props.meta,
                missing: screen.findByTestId('provider-connection-not-found') !== null,
                errors: presentedTitles(screen),
                rpc: providerHarness.state.requests.map(request => ({ method: request.method, machineId: request.machineId })),
            };
            expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ header: expect.any(Array) });
        });
        // A gateway's on/off is the header switch, as on every connection (lab s2svc:gateway), and only
        // there: the ⋯ menu does not repeat it. What runs on one machine is the Runs on section's.
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-enabled')).not.toBeNull());
        expect(findMenuAction(screen, 'gatewayEnabled')).toBeUndefined();
        // The ⋯ menu speaks about a gateway: no Provider duplicate/custom-copy items, and removal names the gateway.
        // The menu settles once the gateway's declarations arrive; until then it is a Provider's menu.
        await waitForHomeGovernance(() => expect(((findComposite(screen, 'provider-connection-menu', 'actions')?.props.actions ?? []) as Array<{ id: string }>)
            .map(action => action.id)).not.toEqual(expect.arrayContaining(['duplicate'])));
        const gatewayMenu = (findComposite(screen, 'provider-connection-menu', 'actions')?.props.actions ?? []) as Array<{ id: string; title: string }>;
        expect(gatewayMenu.map(action => action.id)).not.toEqual(expect.arrayContaining(['duplicate']));
        expect(gatewayMenu.map(action => action.id)).not.toEqual(expect.arrayContaining(['duplicateAsCustom']));
        expect(gatewayMenu.find(action => action.id === 'delete')?.title).toBe('settingsProvidersCollection.gateway.removeGateway');
        // "Experimental" is said once, by the Details section's What to know row, not by a header pill.
        expect(screen.findByTestId('provider-connection-experimental')).toBeNull();
        expect(screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('settings.providers.administration.target'))).toHaveLength(0);
        const controls = screen.findAll(node => typeof node.props.onChangePlacement === 'function'
            && typeof node.props.onChangeHelperModels === 'function')[0];
        expect(controls?.props.placement).toEqual(saved.gatewayPlacement);
        expect(controls?.props.machines).toEqual(expect.arrayContaining([
            expect.objectContaining({ machineId: 'machine-b', online: true }),
        ]));
        // Connecting an upstream keeps the managed gateway and its unfinished settings in place.
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        await act(async () => { controls!.props.onConnectService('happier.agent.codex/openai-codex'); });
        expect(Modal.show).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: { scope: { serverId: resolveServerProfileScopeIdForIdentifier(account.serverId), accountId: `account-gateway-${status}` },
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
        }) }));
        vi.mocked(Modal.show).mock.calls.at(-1)?.[0].onRequestClose?.();
        await flushHookEffects();
        expect(screen.findByTestId('provider-connection-enabled')?.props.value).toBe(true);
        expect(providerHarness.state.requests.some(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE
            && request.machineId === 'machine-b')).toBe(true);
        await waitForHomeGovernance(() => {
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string; text: string }>;
            expect(meta?.find(row => row.key === 'gateway-status')?.text).toBe(status === 'running'
                ? 'settingsProvidersCollection.gateway.statusRunningOn(machine=Linux box)'
                : 'settingsProvidersCollection.gateway.statusIdle');
        });
        // A gateway's identity line is its live custody (lab GW1 "Running on <machine>", GW1p "Idle"):
        // no engine name, and its model count stays on the Models row.
        expect((findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string }>)
            .map(row => row.key)).toEqual(['gateway-status']);
        // Test is a header action on a gateway and runs on its saved placement (machine-b), not on the
        // page's inspection machine (machine-a).
        const probesBefore = providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_PROBE).length;
        await pressAndFlush(findTestRow(screen));
        const probes = providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_PROBE);
        expect(probes.slice(probesBefore).map(request => request.machineId)).toEqual(['machine-b']);
        expect(screen.findAll(node => typeof node.props.onChangePlacement === 'function'
            && typeof node.props.onChangeHelperModels === 'function')[0]?.props.reachability).toBe('not_checked');
        if (status === 'running') {
            // A display-only Account write retains the Machine's checked facts
            // (df1130f827); the next presentation reacquires the chosen hub.
            account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
                select: input => {
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                    expect(mutation.expectedRevision).toBe(stored.revision);
                    if (mutation.content?.t !== 'plain') throw new Error('Expected Account gateway write');
                    const renamed = mutation.content.v.connections[0]!;
                    currentView = { ...view, displayName: renamed.displayName, revision: renamed.revision,
                        runtime: { ...view.runtime, checkedAt: 2 } };
                    hubStatus = 'idle';
                    account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
                        body: { status: 'present', revision: stored.revision + 1, content: mutation.content },
                    });
                    return { body: { status: 'updated', revision: stored.revision + 1, cursor: stored.revision + 1 } };
                },
            });
            const nameField = () => findComposite(screen, 'provider-connection-name', 'onChangeText');
            expect(nameField()?.props.value).toBe(saved.displayName);
            await act(async () => { nameField()?.props.onChangeText('Renamed subscriptions'); });
            await act(async () => { nameField()?.props.onSubmitEditing(); });
            await waitForHomeGovernance(() => {
                const snapshot = { title: findComposite(screen, 'provider-connection-header', 'title')?.props.title,
                    errors: presentedTitles(screen), name: nameField()?.props,
                    rpc: providerHarness.state.requests.map(request => ({ method: request.method, machineId: request.machineId })) };
                expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ title: 'Renamed subscriptions' });
            });
            const retainedMeta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string; text: string }>;
            expect(retainedMeta.find(row => row.key === 'gateway-status')?.text)
                .toBe('settingsProvidersCollection.gateway.statusRunningOn(machine=Linux box)');
            state.focused = false;
            await screen.update(detail());
            state.focused = true;
            await screen.update(detail());
            await waitForHomeGovernance(() => {
                const refreshedMeta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string; text: string }>;
                expect(refreshedMeta.find(row => row.key === 'gateway-status')?.text).toBe('settingsProvidersCollection.gateway.statusIdle');
            });
        }
    });

    it('says an off gateway once: the header switch is its one enable control and Test waits for it', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, gatewayPlacement: { kind: 'sessionMachine' },
            revision: 3, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        await account.restore({ accountId: 'account-gateway-off', catalog, machines,
            waivedActions: ['providers.connections.update'] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        state.connection = createProviderConnectionViewFixture({ connectionId: saved.id,
            contributionKey: saved.source.kind === 'contribution' ? saved.source.contributionKey : null,
            revision: saved.revision, displayName: saved.displayName, displayNameMode: saved.displayNameMode, role: saved.role,
            deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
            gatewayPlacement: saved.gatewayPlacement,
            grants: { accountEnabled: false, enabledMachineIds: [], accountState: 'absent',
                machineState: 'absent', effectiveState: 'absent' },
            managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [{ purpose: 'upstream',
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' }, required: false }] },
            authorizationError: createProviderErrorV1('provider_not_enabled_on_machine', { connectionId: saved.id, machineId: 'machine-a' }),
            runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [],
                gateway: { status: 'idle', reachability: 'not_checked' } },
        });
        installDetailCatalog({ saved });
        const screen = await renderReadyProviderDetail(<DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId={saved.id} />
        </DetailNavigationBoundary>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-enabled')?.props.value).toBe(false));
        // Off is said once, in the header, beside its one switch; idle needs the gateway on.
        const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string; text: string }>;
        expect(meta.map(row => [row.key, row.text])).toEqual([['gateway-status', 'settingsProvidersCollection.gateway.statusOff']]);
        // No second "not enabled" card with its own Enable, and no Use on all machines switch.
        expect(screen.findAll(node => typeof node.props.enableOnMachine === 'function')).toHaveLength(0);
        expect(screen.findByTestId('provider-connection-account-access')).toBeNull();
        // Test is unavailable until the gateway is on.
        expect(screen.findByTestId('provider-connection-test')?.props.disabled).toBe(true);
    });

    it('turns a gateway on where it runs with its one header switch, never a second "Enable on machine" card', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, gatewayPlacement: { kind: 'sessionMachine' },
            revision: 3, createdAt: 1, updatedAt: 1 });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        await account.restore({ accountId: 'account-gateway-half-on', catalog, machines,
            waivedActions: ['providers.connections.update'] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        // Admitted for the Account, but enabled on no machine: it runs nowhere yet.
        state.connection = createProviderConnectionViewFixture({ connectionId: saved.id,
            contributionKey: saved.source.kind === 'contribution' ? saved.source.contributionKey : null,
            revision: saved.revision, displayName: saved.displayName, displayNameMode: saved.displayNameMode, role: saved.role,
            deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null },
            gatewayPlacement: saved.gatewayPlacement,
            grants: { accountEnabled: true, enabledMachineIds: [], accountState: 'valid',
                machineState: 'absent', effectiveState: 'absent' },
            managedLocalOption: { targetMachineId: 'machine-a', connectedAccountPurposes: [{ purpose: 'upstream',
                service: { pluginId: 'happier.connected-account.openai', localId: 'openai' }, required: false }] },
            authorizationError: createProviderErrorV1('provider_not_enabled_on_machine', { connectionId: saved.id, machineId: 'machine-a' }),
            runtime: { health: 'available', modelCount: 3, checkedAt: 1, endpoints: [],
                gateway: { status: 'idle', reachability: 'not_checked' } },
        });
        installDetailCatalog({ saved });
        const screen = await renderReadyProviderDetail(<DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId={saved.id} />
        </DetailNavigationBoundary>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-enabled')).not.toBeNull());
        // Not running anywhere reads as off, in the header, beside the one switch.
        expect(screen.findByTestId('provider-connection-enabled')?.props.value).toBe(false);
        const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as Array<{ key: string; text: string }>;
        expect(meta.map(row => [row.key, row.text])).toEqual([['gateway-status', 'settingsProvidersCollection.gateway.statusOff']]);
        expect(screen.findAll(node => typeof node.props.enableOnMachine === 'function')).toHaveLength(0);
        expect(screen.findByTestId('provider-connection-test')?.props.disabled).toBe(true);
        // On enables it on the machine it runs on, the write the card's button made.
        await act(async () => { await screen.findByTestId('provider-connection-enabled')?.props.onValueChange(true); });
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'setEnabled', scope: 'machine', machineId: 'machine-a', enabled: true }),
            'machine:machine-a'));
    });

    it.each(['none', 'offline'] as const)('edits gateway placement and helper pins through the Account writer with %s machine availability', async availability => {
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
            source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
            role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom',
            deployment: { kind: 'managedLocal' }, revision: 3, createdAt: 1, updatedAt: 1 });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved] });
        let revision = 1;
        await account.restore({ accountId: `account-gateway-${availability}`, catalog, machines: availability === 'offline'
            ? [createMachineFixture({ id: 'machine-a', active: false, activeAt: 1 })] : [],
            waivedActions: ['providers.connections.update'] });
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, availability === 'offline' ? 'machine-a' : null);
        const target = await renderHook(() => useProviderSettingsTarget());
        expect(target.getCurrent().machineId).toBeNull();
        const targetServerId = target.getCurrent().serverId;
        if (!targetServerId) throw new Error('Expected the Provider Account Home');
        expect(resolveServerProfileScopeIdForIdentifier(targetServerId)).toBe(resolveServerProfileScopeIdForIdentifier(account.serverId));
        expect(target.getCurrent().machineRows).toHaveLength(availability === 'offline' ? 1 : 0);
        await target.unmount();
        state.connection = createProviderConnectionViewFixture({ connectionId: saved.id,
            contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
            deployment: { kind: 'managedLocal', targetMachineId: null, effects: null },
            managedLocalOption: null, sourceStatus: 'unavailable',
        });
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const request = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(request.expectedRevision).toBe(revision);
                if (request.content?.t !== 'plain') throw new Error('Expected Account gateway write');
                catalog = request.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId={saved.id} />);
        // React's renderer unwraps memo components; inspect the real composed control interface.
        const controls = () => screen.findAll(node => typeof node.props.onChangePlacement === 'function'
            && typeof node.props.onChangeHelperModels === 'function')[0];
        await vi.waitFor(() => expect(controls(), JSON.stringify({
            title: findComposite(screen, 'provider-connection-header', 'title')?.props.title,
            missing: screen.findByTestId('provider-connection-not-found')?.props.title,
            errors: presentedTitles(screen),
            rpc: providerHarness.state.requests.map(request => ({ method: request.method, machineId: request.machineId })),
        })).toBeTruthy());
        expect(controls()!.props.disabled).toBe(false);
        await act(async () => { await controls()!.props.onChangePlacement({ kind: 'sessionMachine' }); });
        await waitForHomeGovernance(() => expect(catalog.connections[0]?.gatewayPlacement).toEqual({ kind: 'sessionMachine' }));
        await waitForHomeGovernance(() => expect(controls()!.props.placement).toEqual({ kind: 'sessionMachine' }));
        await act(async () => { await controls()!.props.onChangeHelperModels({ fast: 'private-fast' }); });
        await waitForHomeGovernance(() => expect(catalog.connections[0]?.claudeHelperModels).toEqual({ fast: 'private-fast' }));
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE)).toEqual([]);
    });

    it('requests no Provider data when blurred and only selected-machine data for an account connection', async () => {
        state.focused = false;
        const detail = () => <DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId="pc_a" />
        </DetailNavigationBoundary>;
        const screen = await renderScreen(detail());
        await flushHookEffects();
        const describeRequests = () => providerHarness.state.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        const modelRequests = () => providerHarness.state.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODELS);
        expect(describeRequests()).toHaveLength(0);
        expect(modelRequests()).toHaveLength(0);
        state.focused = true;
        await screen.update(detail());
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await waitForHomeGovernance(() => expect({
            title: findComposite(screen, 'provider-connection-header', 'title')?.props.title,
            titles: presentedTitles(screen), requests: providerHarness.state.requests,
        }).toMatchObject({ title: 'Boundary detail' }));
    });

    it('persists source visibility from the detail through Account CAS and reloads the stored choice', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        let catalog = ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{
                // A many-model catalog: its admitted declaration starts it hidden from the picker (D8).
                v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'happier.provider.openrouter/openrouter' },
                role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            }],
            manualModelsByConnectionId: { pc_a: [{ id: 'saved-model', addedAt: 1 }] },
        });
        const original = catalog;
        let revision = 1;
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account catalog write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => (
            createProviderConnectionsDescribeFixture({
                // Like the real projection, a configured source is no longer listed as available.
                connections: [createProviderConnectionViewFixture()],
                available: [],
            })
        ));
        const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
        await refreshProviderCatalog({ serverId: account.serverId, accountId: 'account-a' });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-detail')).toBeTruthy());
        const visibilityControl = () => findComposite(screen, 'provider-connection-picker-visibility', 'rightElement')
            ?.props.rightElement as React.ReactElement<{ value: boolean; onValueChange: (shown: boolean) => void }> | undefined;
        await waitForHomeGovernance(() => expect(visibilityControl()?.props.value).toBe(false));
        for (const shown of [true, false]) {
            await act(async () => { visibilityControl()?.props.onValueChange(shown); });
            await waitForHomeGovernance(() => expect(visibilityControl()?.props.value).toBe(shown));
            expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_a: shown });
            expect(catalog.connections).toEqual(original.connections);
            expect(catalog.manualModelsByConnectionId).toEqual(original.manualModelsByConnectionId);
            expect(catalog.accountGrants).toEqual(original.accountGrants);
        }
        await screen.unmount();
        const reloaded = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findComposite(reloaded, 'provider-connection-picker-visibility', 'rightElement')
            ?.props.rightElement.props.value).toBe(false));
        const reloadedControl = findComposite(reloaded, 'provider-connection-picker-visibility', 'rightElement')
            ?.props.rightElement as React.ReactElement<{ value: boolean }>;
        expect(reloadedControl.props.value).toBe(false);
        expect(providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE
            || request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE)).toHaveLength(0);
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
        installDetailCatalog({ serverId: foreignServerId });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
            providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true, externalApi: { enabled: false } } },
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        const { CredentialShareButton } = await import('@/components/sharing/credentials/CredentialShareSheet');
        // Share is the header action for the connection as a whole, as on a connected account or a pool:
        // not a row in the Connection sheet and no longer a ⋯ item.
        expect(screen.findAllByType(Item)
            .find((item) => item.props.testID === 'provider-connection-share-with-team')).toBeUndefined();
        await waitForHomeGovernance(() => expect(screen.findAllByType(CredentialShareButton)).toHaveLength(1));
        expect(findMenuAction(screen, 'shareWithTeam')).toBeUndefined();
        expect(screen.findAllByType(CredentialShareButton)[0]?.props.source).toEqual({
            kind: 'provider_connection', serverId: account.serverId, machineId: 'machine-a', connectionId: 'pc_a',
            credentialSlotId: 'apiKey', connectionSecurityFingerprint: 'connection-security:v1:current',
        });
    });

    it('opens a website-only projected Provider destination without mutating connection state', async () => {
        state.connection = connection({
            websiteUrl: 'https://provider.example.test',
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:link-test',
        });
        const initialConnection = state.connection;
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = presentedTitles(screen);
        const getKeyRow = screen.findAllByType(Item)
            .find((item) => item.props.accessibilityLabel === 'settingsProviders.links.getApiKey');

        expect(findMenuAction(screen, 'website')).toBeUndefined();
        expect(titles).not.toContain('settingsProviders.links.providerWebsite');
        expect(getKeyRow?.props.accessibilityLabel).toBe('settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.onPress).toBeUndefined();
        await pressAndFlush(findProviderExternalLink(screen, 'settingsProviders.links.getApiKey'));

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test/keys');
        expect(run).not.toHaveBeenCalled();
        expect(state.connection).toBe(initialConnection);
    });

    it('keeps the lab detail anatomy: rare sections behind Advanced, models on their own page (P2-4)', async () => {
        state.connection = connection({
            scope: 'account',
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
            endpoints: [{
                endpointTemplateId: 'chat', protocol: 'openai-chat', baseUrl: 'https://acme.test/v1',
                defaultBaseUrl: 'https://acme.test/v1', accountOverrideBaseUrl: null,
                machineOverrideBaseUrl: null, effectiveSource: 'template',
            }],
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        // Healthy and rare: availability and endpoints wait behind one Advanced disclosure.
        expect(presentedTitles(screen)).not.toContain('settingsProviders.detail.accountAccess');
        expect(screen.findAllByTestId('provider-connection-endpoint.chat.account')).toHaveLength(0);
        await screen.pressByTestIdAsync('provider-connection-advanced');
        expect(presentedTitles(screen)).toContain('settingsProviders.detail.accountAccess');
        // The endpoint is its own sheet titled by its protocol, with no raw wire id as a title.
        expect(screen.findAllByTestId('provider-connection-endpoint.chat')
            .some((node) => node.props.title === 'settingsProviders.authoring.protocol.openai-chat.title')).toBe(true);
        expect(presentedTitles(screen)).not.toContain('openai-chat');
        expect(screen.findAllByTestId('provider-connection-endpoint.chat.account').length).toBeGreaterThan(0);

        // The Models row opens the connection's Models page instead of an inline manager.
        expect(screen.findAll((node) => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('provider-model-manager.row:'))).toHaveLength(0);
        await screen.pressByTestIdAsync('provider-connection-models-row');
        expect(router.push).toHaveBeenCalledWith('/(app)/settings/providers/pc_a/models');
    });

    it.each(['provider_connection_disabled', 'provider_not_enabled_on_machine'] as const)(
        'keeps an intentionally Off provider collapsed for %s and permits manual opening and closing', async code => {
            state.connection = connection({ scope: code === 'provider_connection_disabled' ? 'account' : 'machine',
                authorizationError: createProviderErrorV1(code, { connectionId: 'pc_a', machineId: 'machine-a' }) });
            const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
            const advanced = () => screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-advanced')!;
            expect(advanced().props.accessibilityExpanded).toBe(false);
            // The shared model reader can settle independently of the disclosure.
            await waitForHomeGovernance(() => expect(findComposite(screen, 'provider-connection-header', 'meta')
                ?.props.meta.find((entry: { key: string }) => entry.key === 'models')?.text)
                .toBe('settingsProvidersCollection.modelsShown(shown=1,total=1)'));
            if (code === 'provider_not_enabled_on_machine') {
                await openAdvanced(screen);
                await waitForHomeGovernance(() => {
                    const rows = screen.findAllByType(Item);
                    expect(rows.find(item => item.props.title === 'Mac')?.props.rightElement.props.disabled).toBe(false);
                    expect(rows.find(item => item.props.title === 'Linux box')?.props.subtitle)
                        .toBe('settingsProviders.detail.selectMachineToManage');
                });
                await screen.pressByTestIdAsync('provider-connection-advanced');
            }
            await screen.pressByTestIdAsync('provider-connection-advanced');
            expect(advanced().props.accessibilityExpanded).toBe(true);
            await screen.pressByTestIdAsync('provider-connection-advanced');
            expect(advanced().props.accessibilityExpanded).toBe(false);
            expect(probeProviderConnection).not.toHaveBeenCalled();
        },
    );

    it.each(['stale-grant', 'disabled-stale-grant', 'authorization-failure'] as const)('keeps genuine %s repair visible and explained in Advanced', async reason => {
        const staleGrant = reason !== 'authorization-failure';
        state.connection = connection({ scope: 'machine',
            grants: { accountEnabled: !staleGrant, enabledMachineIds: ['machine-a'],
                accountState: staleGrant ? 'stale' : 'valid', machineState: 'valid', effectiveState: 'valid' },
            authorizationError: createProviderErrorV1(reason === 'disabled-stale-grant' ? 'provider_connection_disabled'
                : staleGrant ? 'provider_account_grant_stale' : 'provider_endpoint_unauthorized',
                { connectionId: 'pc_a', machineId: 'machine-a' }),
        });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const advanced = screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-advanced');
        // An Account grant is repaired by Use on all machines: Availability stands on its own with the cause under
        // that switch, said once, and the rest of Advanced (Machines, endpoints) stays behind its toggle.
        expect(advanced?.props.accessibilityExpanded).toBe(!staleGrant);
        expect(advanced?.props.onPress === undefined).toBe(!staleGrant);
        expect(advanced?.props.subtitle).toBe(staleGrant ? 'settingsProvidersCollection.advancedSummary'
            : 'settingsProviders.errors.unauthorizedDescription');
        if (staleGrant) {
            const accountRow = screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-account-access');
            expect(accountRow?.props.subtitle).toBe('settingsProviders.accountAccessStale');
            expect(screen.getTextContent()).not.toContain('settingsProviders.errors.accessChangedDescription');
        }
        expect(probeProviderConnection).not.toHaveBeenCalled();
    });

    it('does not carry a forced Advanced repair into an Off connection after changing context', async () => {
        state.connection = connection({ authorizationError: createProviderErrorV1('provider_endpoint_unauthorized', { connectionId: 'pc_a' }),
            grants: { accountEnabled: true, accountState: 'valid', effectiveState: 'valid' } });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const advanced = () => screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-advanced');
        expect(advanced()?.props.accessibilityExpanded).toBe(true);
        state.connection = connection({ connectionId: 'pc_off', scope: 'account',
            authorizationError: createProviderErrorV1('provider_connection_disabled', { connectionId: 'pc_off' }) });
        await screen.update(<ProviderConnectionDetailScreen connectionId="pc_off" />);
        await vi.waitFor(() => expect(advanced()?.props.accessibilityExpanded).toBe(false));
        expect(probeProviderConnection).not.toHaveBeenCalled();
    });

    it('moves Get API key into the menu once a key is saved (P2-6)', async () => {
        state.connection = connection({
            credential: {
                required: true,
                accountBound: true,
                boundMachineIds: [],
                keyUrl: 'https://provider.example.test/keys',
            },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const getKeyRow = screen.findAllByType(Item)
            .find((item) => item.props.accessibilityLabel === 'settingsProviders.links.getApiKey');

        expect(getKeyRow).toBeUndefined();
        await pressAndFlush(findMenuAction(screen, 'getApiKey'));
        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test/keys');
        expect(run).not.toHaveBeenCalled();
    });

    it('preserves the detail screen and reports non-secret feedback when opening fails', async () => {
        state.connection = connection({
            websiteUrl: 'https://provider.example.test',
        });
        openUrl.mockRejectedValueOnce(new Error('platform opener unavailable'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

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
        const unavailable = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const unavailableTitles = presentedTitles(unavailable);
        expect(findMenuAction(unavailable, 'website')).toBeUndefined();
        expect(unavailableTitles).not.toContain('settingsProviders.links.getApiKey');

        state.connection = connection({
            contributionKey: null,
            provenance: 'custom',
        });
        const custom = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const customTitles = presentedTitles(custom);
        expect(findMenuAction(custom, 'website')).toBeUndefined();
        expect(customTitles).not.toContain('settingsProviders.links.getApiKey');
    });

    it('omits Test connection and explains first-session checking when no safe probe exists', async () => {
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findTestRow(screen)).toBeDefined();
    });

    it('labels only an externally sourced Provider connection as experimental', async () => {
        state.connection = connection({ provenance: 'external' });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const external = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findComposite(external, 'provider-connection-experimental', 'label')?.props.label)
            .toBe('settingsProviders.compatibility.experimental');

        state.connection = connection({ provenance: 'first_party' });
        const bundled = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(bundled.findByTestId('provider-connection-experimental')).toBeNull());
        expect(bundled.findByTestId('provider-connection-experimental')).toBeNull();
    });

    it('renders an initial typed load failure instead of falsely claiming the connection was deleted', async () => {
        state.connection = null;
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { status: 503, body: {} });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const titles = presentedTitles(screen);
        expect(screen.findAll(node => node.props.diagnosticCode === 'provider_catalog_unavailable')).not.toHaveLength(0);
        expect(titles).toContain('settingsProviders.errors.genericTitle');
        expect(titles).toContain('settingsProviders.errors.actions.retry');
        expect(screen.findByTestId('provider-connection-not-found')).toBeNull();
    });

    it('reports a failed probe beside the header Test action', async () => {
        state.connection = connection({ probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:failed-test',
            authorized: true, grants: { accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid' } });
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        // A daemon endpoint probe commits the observation before returning its typed failure.
        probeProviderConnection.mockImplementationOnce(async () => {
            state.connection = connection({ ...state.connection, runtime: {
                health: 'unreachable', modelCount: null, checkedAt: 200, endpoints: [{
                    endpointTemplateId: 'openai-chat', status: 'unreachable', activity: 'idle',
                    observedAt: 200, errorCode: 'provider_endpoint_unreachable', retryAt: null,
                }],
            } });
            return { status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') };
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);

        await waitForHomeGovernance(() => {
            const probeResult = findComposite(screen, 'provider-connection-probe-result', 'text')?.props.text;
            expect(probeResult).toContain('settingsProviders.errors.unreachableDescription');
            expect(probeResult).toContain('connectedServicesCollection.checkedAt');
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
                Array<{ key: string; text: string }> | undefined;
            expect(meta?.find(fact => fact.key === 'status')?.text).toBe('settingsProviders.status.unreachable');
        });
    });

    it.each([503, 403] as const)('reads the canonical %s Test result when the prior description has no observation identity', async status => {
        state.connection = connection({ probeCapability: 'catalog', probeObservationIdentity: 'probe-observation:v1:checked',
            authorized: true, grants: { accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid' },
            runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
        });
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        let checked = false;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => checked
            ? createProviderConnectionsDescribeFixture({ connections: [DaemonProviderConnectionViewV1Schema.parse(state.connection)] })
            : { status: 'error', error: createProviderErrorV1('agent_timeout') });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => ({
            status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable'),
        }));
        const errorCode = status === 503 ? 'provider_endpoint_unavailable' : 'provider_endpoint_unauthorized';
        probeProviderConnection.mockImplementationOnce(async () => {
            checked = true;
            state.connection = connection({ ...state.connection, probeObservationIdentity: 'probe-observation:v1:checked',
                runtime: { health: 'needs_attention', modelCount: 466, checkedAt: 200, endpoints: [{
                    endpointTemplateId: 'openai-chat', status: status === 503 ? 'temporarily_unavailable' : 'unauthorized',
                    activity: 'idle', observedAt: 200, errorCode, retryAt: null,
                }] },
            });
            return { status: 'error', error: createProviderErrorV1(errorCode) };
        });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => {
            expect(findTestRow(screen)?.props.onPress).toBeTypeOf('function');
            expect(findTestRow(screen)?.props.subtitle).toBeNull();
        });
        if (status === 403) {
            const [{ sync }, { storage }] = await Promise.all([import('@/sync/sync'), import('@/sync/domains/state/storage')]);
            const expectedSettingsScope = storage.getState().settingsScope;
            if (!expectedSettingsScope) throw new Error('Expected the restored Account scope');
            await act(async () => { sync.applySettings({ showLineNumbers: false }, { expectedSettingsScope }); });
        }
        await pressAndFlush(findTestRow(screen));
        expect(probeProviderConnection).toHaveBeenCalledOnce();
        await waitForHomeGovernance(() => {
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
                Array<{ key: string; text: string }> | undefined;
            expect(meta?.find(fact => fact.key === 'status')?.text).toBe('settingsProviders.status.needsAttention');
            expect(findTestRow(screen)?.props.subtitle).toContain('connectedServicesCollection.checkedAt');
            if (status === 403) expect(findTestRow(screen)?.props.subtitle).toContain('settingsProviders.errors.unauthorizedDescription');
        });
    });

    it('refreshes the header and row from the canonical Machine check after an explicit 503 Test', async () => {
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => ({
            status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable'),
        }));
        state.connection = connection({ probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:stable',
            authorized: true, grants: { accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid' },
            runtime: { health: 'unreachable', modelCount: 466, checkedAt: 100, endpoints: [{
                endpointTemplateId: 'openai-chat', status: 'unreachable', activity: 'idle',
                observedAt: 100, errorCode: 'provider_endpoint_unreachable', retryAt: null,
            }] },
        });
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        let finishProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockImplementationOnce(async () => {
            state.connection = connection({ ...state.connection,
                runtime: { health: 'needs_attention', modelCount: 466, checkedAt: 200, endpoints: [{
                    endpointTemplateId: 'openai-chat', status: 'temporarily_unavailable', activity: 'idle',
                    observedAt: 200, errorCode: 'provider_endpoint_unavailable', retryAt: null,
                }] },
            });
            return new Promise(resolve => { finishProbe = resolve; });
        });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.errors.unreachableDescription'));
        const headerMeta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
            Array<{ key: string; text: string }> | undefined;
        expect(headerMeta?.find(fact => fact.key === 'models')?.text)
            .toBe('settingsProvidersCollection.modelsShown(shown=466,total=466)');
        await pressAndFlush(findTestRow(screen));
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { useProviderConnections } = await import('@/providers/hooks/useProviderConnections');
        const sibling = await renderHook(() => useProviderConnections({ enabled: true,
            machineId: 'machine-a', serverId: account.serverId, connectionId: 'pc_a' }));
        try {
            await waitForHomeGovernance(() => expect(sibling.getCurrent().data?.connections[0]?.runtime.checkedAt).toBe(200));
            // A normal sibling Action has published the daemon's newer check;
            // the already-mounted header must consume it without remounting.
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
                Array<{ key: string; text: string }> | undefined;
            expect(meta?.find(fact => fact.key === 'status')?.text).toBe('settingsProviders.status.needsAttention');
        } finally {
            // The newer admitted observation survives a subsequent optional
            // Machine describe refusal; that refusal is not a health result.
            providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => ({
                status: 'error', error: createProviderErrorV1('provider_secret_missing'),
            }));
            await act(async () => {
                finishProbe?.({ status: 'error', error: createProviderErrorV1('provider_endpoint_unavailable') });
                await Promise.resolve();
            });
        }
        await waitForHomeGovernance(() => {
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
                Array<{ key: string; text: string }> | undefined;
            expect(meta?.find(fact => fact.key === 'status')?.text).toBe('settingsProviders.status.needsAttention');
            expect(findTestRow(screen)?.props.subtitle).toContain('connectedServicesCollection.checkedAt');
            expect(findTestRow(screen)?.props.subtitle).not.toContain('settingsProviders.errors.unreachableDescription');
        });
    });

    it('shows the latest canonical check after a successful Test instead of retaining a competing success', async () => {
        state.connection = connection({ probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:stable',
            authorized: true, grants: { accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid' },
            runtime: { health: 'unreachable', modelCount: 467, checkedAt: 100, endpoints: [{
                endpointTemplateId: 'openai-chat', status: 'unreachable', activity: 'idle',
                observedAt: 100, errorCode: 'provider_endpoint_unreachable', retryAt: null,
            }] },
        });
        probeProviderConnection.mockImplementationOnce(async () => {
            state.connection = connection({ ...state.connection,
                runtime: { health: 'available', modelCount: 467, checkedAt: 200, endpoints: [{
                    endpointTemplateId: 'openai-chat', status: 'available', activity: 'idle',
                    observedAt: 200, errorCode: null, retryAt: null,
                }] },
            });
            return { status: 'success', models: [], requestFingerprint: 'probe-request:v1:detail' };
        });
        const detail = () => <DetailNavigationBoundary>
            <ProviderConnectionDetailScreen connectionId="pc_a" />
        </DetailNavigationBoundary>;
        const screen = await renderScreen(detail());
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.errors.unreachableDescription'));
        await pressAndFlush(findTestRow(screen));
        await waitForHomeGovernance(() => {
            expect(findTestRow(screen)?.props.subtitle).toContain('connectedServicesCollection.checkedAt');
            expect(findTestRow(screen)?.props.subtitle).not.toContain('settingsProviders.errors.unreachableDescription');
        });

        state.connection = connection({ ...state.connection,
            runtime: { health: 'needs_attention', modelCount: 467, checkedAt: 300, endpoints: [{
                endpointTemplateId: 'openai-chat', status: 'unauthorized', activity: 'idle',
                observedAt: 300, errorCode: 'provider_endpoint_unauthorized', retryAt: null,
            }] },
        });
        state.focused = false;
        await screen.update(detail());
        state.focused = true;
        await screen.update(detail());
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.errors.unauthorizedDescription'));
        const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
            Array<{ key: string; text: string }> | undefined;
        expect(meta?.find(fact => fact.key === 'status')?.text).toBe('settingsProviders.status.needsAttention');
    });

    it('normalizes a thrown probe failure through the shared typed Provider boundary', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        probeProviderConnection.mockRejectedValueOnce(new Error('socket implementation detail'));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);

        await pressAndFlush(testRow);

        await waitForHomeGovernance(() => {
            const updatedTestRow = findTestRow(screen);
            expect(updatedTestRow?.props.subtitle).toBeTruthy();
            expect(updatedTestRow?.props.subtitle).not.toContain('socket implementation detail');
        });
    });

    it('clears the previous machine probe result when the target machine changes', async () => {
        state.connection = connection({
            probeCapability: 'catalog',
            probeObservationIdentity: 'probe-observation:v1:machine-a',
            authorized: true,
            grants: { accountEnabled: true, accountState: 'valid', effectiveState: 'valid' },
        });
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        probeProviderConnection.mockImplementationOnce(publishSuccessfulProbe);
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findTestRow(screen)).toBeDefined());
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.status.available'));

        state.connection = connection({ ...state.connection,
            runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
        });
        await act(async () => {
            await administrationTarget.controller.select('machine-b');
        });
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle).toBeNull());
    });

    it('ignores a probe response that completes after the target machine changes', async () => {
        state.connection = connection({ probeCapability: 'catalog' });
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderConnection.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const testRow = findTestRow(screen);
        await act(async () => { testRow?.props.onPress?.(); });
        await act(async () => { await administrationTarget.controller.select('machine-b'); });
        await act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(findTestRow(screen)).toBeDefined());
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
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        probeProviderConnection.mockImplementationOnce(publishSuccessfulProbe);
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findTestRow(screen)).toBeDefined());
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.status.available'));

        state.connection = connection({
            ...state.connection,
            displayName: 'Renamed only', displayNameMode: 'custom', revision: 2,
            probeCapability: 'catalog', authorized: true,
            probeObservationIdentity: 'probe-observation:v1:current-observation',
            grants: {
                accountEnabled: true, enabledMachineIds: [],
                accountState: 'valid', machineState: 'absent', effectiveState: 'valid',
            },
        });
        const nameField = () => findComposite(screen, 'provider-connection-name', 'onChangeText');
        await act(async () => { nameField()?.props.onChangeText('Renamed only'); });
        await act(async () => { nameField()?.props.onSubmitEditing(); });
        await waitForHomeGovernance(() => expect(findComposite(screen, 'provider-connection-header', 'title')?.props.title)
            .toBe('Renamed only'));
        expect(stored.catalog.connections[0]?.displayName).toBe('Renamed only');

        expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.status.available');
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
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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

    it('keeps the canonical last check while an access mutation is pending', async () => {
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
        const stored = installDetailCatalog({ catalogSource: 'probe' });
        await enableDetailAccountConnection(stored);
        probeProviderConnection.mockImplementationOnce(publishSuccessfulProbe);
        const write = createDeferred<void>();
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            respondAfter: write.promise, body: { status: 'updated', revision: stored.revision + 1, cursor: stored.revision + 1 },
        });
        const writesBeforeMutation = accountCatalogWrites().length;
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findTestRow(screen)).toBeDefined());
        await openAdvanced(screen);
        const testRow = findTestRow(screen);
        await pressAndFlush(testRow);
        await waitForHomeGovernance(() => expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.status.available'));

        const accountRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        await act(async () => { accountRow?.props.rightElement.props.onValueChange(false); });

        expect(findTestRow(screen)?.props.subtitle)
            .toContain('settingsProviders.status.available');
        await waitForHomeGovernance(() => expect(accountCatalogWrites()).toHaveLength(writesBeforeMutation + 1));
        await act(async () => { write.resolve(); await flushHookEffects(); });
    });

    it('retries the exact typed detail mutation instead of substituting a connection read', async () => {
        state.connection = connection({ endpoints: [{ endpointTemplateId: 'endpoint_main', protocol: 'openai-chat',
            baseUrl: 'https://acme.test/v1', defaultBaseUrl: 'https://acme.test/v1',
            accountOverrideBaseUrl: null, machineOverrideBaseUrl: null, effectiveSource: 'template' }] });
        run.mockResolvedValue({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const field = () => findComposite(screen, 'provider-connection-endpoint.endpoint_main.machine', 'onChangeText');
        expect(field()).toBeDefined();
        await act(async () => { field()?.props.onChangeText('https://machine.example/v1'); });
        await act(async () => { await field()?.props.onSubmitEditing(); });
        await waitForHomeGovernance(() => expect(findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.retry')).toBeDefined());
        const retry = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.retry');
        expect(retry).toBeDefined();
        await act(async () => { await retry?.props.onPress?.(); });

        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    });

    it('reviews an unknown detail mutation by refreshing the current connection without replay', async () => {
        installDetailCatalog();
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { dispatchThenFail: true });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const accountRow = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');

        await act(async () => { await accountRow?.props.rightElement.props.onValueChange(true); });
        await waitForHomeGovernance(() => expect(findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')).toBeDefined());
        const review = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState');
        expect(review).toBeDefined();
        const readsBeforeReview = providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        ).length;
        await act(async () => { await review?.props.onPress?.(); });

        await waitForHomeGovernance(() => expect(providerHarness.state.requests.filter(
            request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toHaveLength(readsBeforeReview + 1));
        expect(accountCatalogWrites()).toHaveLength(1);
        expect(run).not.toHaveBeenCalled();
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        )).toHaveLength(readsBeforeReview + 1);
        // The fresh read settled the question, so the "needs review" notice leaves with it.
        expect(findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState')).toBeUndefined();
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
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
        const stored = installDetailCatalog();

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const enable = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.enableOnMachine');
        expect(enable).toBeDefined();

        await pressAndFlush(enable);

        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledOnce());
        expect(stored.writes).toBe(0);
        expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ action: 'setEnabled', machineId: 'machine-a',
            connectionId: 'pc_a', enabled: true, scope: 'machine' }));
    });

    it('returns a successfully deleted connection to the Provider index without requiring back history', async () => {
        const stored = installDetailCatalog();
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const remove = findMenuAction(screen, 'delete');

        await pressAndFlush(remove);

        await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers'));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers');
        expect(router.back).not.toHaveBeenCalled();
    });

    it('keeps the duplicate draft pending native confirmation and preserves it after decline', async () => {
        await account.restore({ accountId: 'duplicate-approval-account', serverIdentityId: 'srv_provider_detail', machines: [] });
        await account.home.requireUiApproval(account.serverId, 'providers.connections.duplicate');
        const stored = installDetailCatalog();
        const decision = createDeferred<boolean>();
        confirm.mockImplementationOnce(() => decision.promise);
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, null);
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'duplicate')).toBeDefined());
        await pressAndFlush(findMenuAction(screen, 'duplicate'));
        await act(async () => { screen.changeTextByTestId('provider-connection-duplicate-name', 'Work copy'); });
        const button = () => findComposite(screen, 'provider-connection-duplicate-save', 'loading');
        await act(async () => { button()?.props.onPress(); });
        await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledOnce());
        await waitForHomeGovernance(() => expect(button()?.props.disabled).toBe(true));
        expect(button()?.props.loading).toBe(true);
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
        expect(stored.writes).toBe(0);
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(screen.findByTestId('provider-connection-duplicate-approval')).toBeNull();
        expect(findComposite(screen, 'provider-connection-duplicate-name', 'value')?.props.value).toBe('Work copy');
        await act(async () => { decision.resolve(false); });
        await waitForHomeGovernance(() => expect(button()?.props.disabled).toBe(false));
        expect(findComposite(screen, 'provider-connection-duplicate-name', 'value')?.props.value).toBe('Work copy');
        expect(stored.writes).toBe(0);
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
    });

    it('keeps explicit UI Ask in native confirmation and navigates only after its real terminal result', async () => {
        await account.restore({ accountId: 'default-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.home.requireUiApproval(account.serverId, 'providers.connections.delete');
        const stored = installDetailCatalog();
        const decision = createDeferred<boolean>();
        confirm.mockImplementationOnce(() => decision.promise);
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledOnce());
        expect(run).not.toHaveBeenCalled();
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
        expect(stored.writes).toBe(0);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        await act(async () => { decision.resolve(true); });
        await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers'));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        expect(accountCatalogWrites()).toEqual([expect.objectContaining({ serverId: account.serverId })]);
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
    });

    it('keeps native confirmation on its captured Account catalog when machine selection moves', async () => {
        await account.restore({ accountId: 'captured-machine-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.home.requireUiApproval(account.serverId, 'providers.connections.delete');
        const stored = installDetailCatalog();
        const decision = createDeferred<boolean>();
        confirm.mockImplementationOnce(() => decision.promise);
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await pressAndFlush(findMenuAction(screen, 'delete'));
        await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledOnce());
        expect(stored.writes).toBe(0);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
        await act(async () => { await account.selectMachine(account.serverId, 'machine-b'); await flushHookEffects(); });
        await act(async () => { decision.resolve(true); });
        await waitForHomeGovernance(() => expect(router.replace).toHaveBeenCalledWith('/(app)/settings/providers'));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections).toEqual([]);
        expect(run).not.toHaveBeenCalled();
        expect(router.replace).toHaveBeenCalledTimes(1);
        expect(accountCatalogWrites()).toEqual([expect.objectContaining({ serverId: account.serverId })]);
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
    });

    it('admits one native confirmation and re-enables deletion after cancellation without writing', async () => {
        await account.restore({ accountId: 'cancelled-approval-account', serverIdentityId: 'srv_provider_detail', machines });
        await account.home.requireUiApproval(account.serverId, 'providers.connections.delete');
        const stored = installDetailCatalog();
        const decision = createDeferred<boolean>();
        confirm.mockImplementationOnce(() => decision.promise);
        await account.home.selectHomes([account.serverId]);
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await act(async () => {
            const remove = findMenuAction(screen, 'delete');
            remove?.props.onPress();
            remove?.props.onPress();
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledOnce());
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        expect(stored.writes).toBe(0);
        expect(router.replace).not.toHaveBeenCalled();
        await act(async () => { decision.resolve(false); });
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(false));
        expect(run).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(stored.writes).toBe(0);
        confirm.mockResolvedValueOnce(false);
        await pressAndFlush(findMenuAction(screen, 'delete'));
        await waitForHomeGovernance(() => expect(confirm).toHaveBeenCalledTimes(2));
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(false));
        expect(run).not.toHaveBeenCalled();
        expect(stored.writes).toBe(0);
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(account.home.artifacts(account.serverId).list()).toEqual([]);
    });

    it('admits one waived delete mutation and re-enables the action after transport failure', async () => {
        installDetailCatalog();
        const deletion = createDeferred<void>();
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            respondAfter: deletion.promise, dispatchThenFail: true,
        });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')).toBeDefined());
        await act(async () => {
            const remove = findMenuAction(screen, 'delete');
            remove?.props.onPress();
            remove?.props.onPress();
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(accountCatalogWrites()).toHaveLength(1));
        expect(confirm).not.toHaveBeenCalled();
        expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(true);
        await act(async () => { deletion.resolve(); await flushHookEffects(); });
        await waitForHomeGovernance(() => expect(findMenuAction(screen, 'delete')?.props.disabled).toBe(false));
        expect(router.replace).not.toHaveBeenCalled();
        expect(accountCatalogWrites()).toHaveLength(1);
        expect(run).not.toHaveBeenCalled();
    });

    it('opens one read per visible Machine and exposes a failed peer row Retry without reloading healthy rows', async () => {
        state.connection = connection({
            scope: 'machine', authorized: true,
            grants: { accountEnabled: true, enabledMachineIds: ['machine-a'],
                accountState: 'valid', machineState: 'valid', effectiveState: 'valid' },
        });
        let failPeer = true;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async request => {
            if (request.machineId === 'machine-b' && failPeer) {
                throw new RpcError('RPC transport unavailable', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
            }
            return createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture(state.connection!)] });
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-detail')).not.toBeNull());
        const reads = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        expect(reads().filter(request => request.machineId === 'machine-b')).toHaveLength(0);
        const beforeOpen = reads().length;
        await openAdvanced(screen);
        await waitForHomeGovernance(() => expect(screen.findAllByType(ProviderErrorItems)
            .some(item => item.props.error?.code === 'provider_machine_unavailable' && typeof item.props.retry === 'function')).toBe(true));
        expect(reads().slice(beforeOpen).map(request => request.machineId).sort()).toEqual(['machine-a', 'machine-b']);
        const retry = screen.findByTestId('provider-error-action:provider_machine_unavailable');
        expect(retry).not.toBeNull();
        const beforeRetry = reads().length;
        failPeer = false;
        await screen.pressByTestIdAsync('provider-error-action:provider_machine_unavailable');
        await waitForHomeGovernance(() => expect(reads()).toHaveLength(beforeRetry + 1));
        expect(reads().slice(beforeRetry).map(request => request.machineId)).toEqual(['machine-b']);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-error-action:provider_machine_unavailable')).toBeNull());
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const actionRows = screen.findAllByType(Item).filter((item) => (
            item.props.title === 'settingsProviders.detail.resetEndpoint'
            || item.props.title === 'settingsProviders.detail.endpointMachine'
        ));

        expect(actionRows.map((item) => item.props.accessibilityLabel)).toEqual([
            'settingsProviders.authoring.protocol.openai-responses.title, settingsProviders.detail.endpointDefault, settingsProviders.detail.resetEndpoint',
            'settingsProviders.authoring.protocol.openai-responses.title, settingsProviders.detail.endpointMachine',
            'settingsProviders.authoring.protocol.anthropic.title, settingsProviders.detail.endpointMachine',
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const rows = screen.findAllByType(Item);
        const fieldValue = (fieldTestID: string) => screen.findAllByTestId(fieldTestID)
            .find((node) => typeof node.props.value === 'string')?.props.value;

        // Each address is shown once, as its field's value (no repeated URL rows).
        expect(fieldValue('provider-connection-endpoint.responses.account')).toBe('https://account.example/v1');
        expect(fieldValue('provider-connection-endpoint.responses.machine')).toBe('http://127.0.0.1:8080/v1');
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const account = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType(Item).find((item) => item.props.title === 'Mac');
        expect(account?.props.rightElement.props.value).toBe(false);
        await waitForHomeGovernance(() => expect(machine?.props.rightElement.props.value).toBe(false));
        expect(machine?.props.rightElement.props.value).toBe(false);
        if (code === 'provider_account_grant_stale') {
            // The page is where Review account access leads: the cause sits under the switch that repairs it.
            expect(account?.props.subtitle).toBe('settingsProviders.accountAccessStale');
            expect(presentedTitles(screen)).not.toContain(actionTitle);
        } else {
            expect(presentedTitles(screen)).toContain(actionTitle);
        }
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const account = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.detail.accountAccess');
        const machine = screen.findAllByType(Item).find((item) => item.props.title === 'Mac');

        expect(account?.props.rightElement.props.value).toBe(false);
        await waitForHomeGovernance(() => expect(machine?.props.rightElement.props.value).toBe(true));
        expect(machine?.props.rightElement.props.value).toBe(true);
    });

    it('offers direct manual-model recovery when enumeration is unavailable', async () => {
        state.connection = connection({
            probeCapability: 'none', manualModelPolicy: 'allowed',
            runtime: { health: 'not_checked', modelCount: null, checkedAt: null, endpoints: [] },
        });
        // Manual models are added on the connection's Models page, behind the detail's Models row.
        const { ProviderConnectionModelsScreen } = await import('./models/ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(presentedTitles(screen))
            .toContain('settingsProviders.models.add'));
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const codex = screen.findAllByType(Item).find((item) => item.props.title === 'Codex');
        expect(codex?.props.rightElement.props.label).toBe('settingsProviders.compatibility.experimental');
        expect(codex?.props.subtitle).toBe('settingsProviders.compatibility.reasons.evidenceMissing');
    });

    it('keeps unknown compatibility fallback coverage at the presentation boundary', () => {
        expect(presentProviderCompatibilityReasons(['future_reason_from_newer_daemon']))
            .toEqual([{ descriptionKey: 'settingsProviders.compatibility.reasons.unknown', known: false }]);
    });

    it('retains the typed DNS cause when reopening a checked connection', async () => {
        const checkedAt = Date.now() - 5 * 60_000;
        state.connection = connection({
            probeCapability: 'catalog',
            runtime: { health: 'unreachable', modelCount: 2, checkedAt, endpoints: [{
                endpointTemplateId: 'openai-chat', status: 'unreachable', activity: 'idle', observedAt: checkedAt,
                errorCode: 'provider_endpoint_unreachable', retryAt: null,
                failureCause: { phase: 'providers.probe.resolve_host', errorClass: 'Error', errorCode: 'ENOTFOUND', httpStatus: null },
            }] },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findTestRow(screen)).toBeDefined());
        const result = findTestRow(screen)?.props.subtitle;
        expect(result).toContain('settingsProviders.errors.hostNotFoundDescription');
        expect(result).toContain('connectedServicesCollection.checkedAt');
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => {
            const meta = findComposite(screen, 'provider-connection-header', 'meta')?.props.meta as
                Array<{ key: string; text: string }> | undefined;
            expect(meta?.find((fact) => fact.key === 'status')?.text).toBe('settingsProviders.status.unreachable');
        });
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        // One "Local runtime" row on this computer: who runs the server, and Start where Happier can.
        expect(screen.findAllByType(Item).map((item) => item.props.subtitle))
            .toContain('settingsProviders.local.runningOutsideHappier');
        expect(screen.findByTestId('provider-connection-local-start-managed')).not.toBeNull();
        await screen.pressByTestIdAsync('provider-connection-local-start-managed');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'startLocal', machineId: 'machine-a', connectionId: 'pc_a',
            contributionKey: 'acme.plugin/acme',
        }), 'start:acme.plugin/acme'));
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
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
        const stored = installManagedDetailCatalog();

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
            (item) => item.props.testID === 'provider-connection-managed-purpose-chooser:openai-upstream',
        );
        expect(chooser?.props.localizedTextPluginId).toBe('happier.provider.cliproxyapi');
        await act(async () => {
            chooser?.props.onChange({
                kind: 'group',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                groupId: 'team',
            });
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
        await waitForHomeGovernance(() => expect({ writes: stored.writes, alerts: alert.mock.calls,
            errors: presentedTitles(screen), requests: accountCatalogWrites() }).toMatchObject({ writes: 1 }));
        expect(stored.catalog.connections[0]).toMatchObject({ revision: 1,
            deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: {
                    'openai-upstream': {
                        kind: 'group',
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                        groupId: 'team',
                    },
            },
        });
        expect(run).not.toHaveBeenCalled();
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        await refreshPurposeTargets(screen, 'provider-connection-managed-purpose-chooser:upstream');
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
        installDetailCatalog({ serverId: foreignServerId, saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' }, role: 'default', displayName: 'Acme',
            displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-managed-account-scope')).not.toBeNull());
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
        installDetailCatalog({ serverId: foreignServerId, saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' }, role: 'default', displayName: 'Acme',
            displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const { ConnectedAccountPurposeTargetChooser } = await import(
            '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'
        );
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-managed-account-scope')).not.toBeNull());
        expect(screen.findAllByType(Item).map((item) => item.props.testID))
            .toContain('provider-connection-managed-account-scope');
        expect(run).not.toHaveBeenCalled();
    });

    it('submits optional unbound managed defaults without a local required-binding alert, but refuses an undeclared contribution', async () => {
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
        const stored = installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' }, role: 'default',
            displayName: 'Acme', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const activate = screen.findAllByType(Item).find(
            (item) => item.props.testID === 'provider-connection-managed-configure',
        );

        await pressAndFlush(activate);
        expect(run).not.toHaveBeenCalled();
        await pressAndFlush(screen.findByTestId('provider-connection-managed-purpose-save') ?? undefined);
        await waitForHomeGovernance(() => expect(presentedTitles(screen)).toContain('settingsProviders.errors.connectionInvalidTitle'));
        expect(alert).not.toHaveBeenCalled();
        expect(stored.writes).toBe(0);
        expect(stored.catalog.connections[0]?.deployment.kind).toBe('external');
        expect(presentedTitles(screen)).toContain('settingsProviders.errors.connectionInvalidTitle');
        expect(run).not.toHaveBeenCalled();
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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

        await refreshPurposeTargets(screen, 'provider-connection-managed-purpose-chooser:telemetry');

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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
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
        // The manual-model editor lives on the connection's Models page, behind the detail's Models row.
        const { ProviderConnectionModelsScreen } = await import('./models/ProviderConnectionModelsScreen');
        const { getActiveUnsavedChangesGuard, runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" startAdding />);
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

    it('edits future gateway defaults without rebinding the machine-applied purpose', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
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
        const stored = installManagedDetailCatalog();

        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const gateway = () => screen.findAll(node => typeof node.props.onChangeSlot === 'function'
            && typeof node.props.onChangePlacement === 'function')[0];
        await waitForHomeGovernance(() => expect(gateway()).toBeDefined());
        await act(async () => {
            gateway()?.props.onChangeSlot('openai-upstream', {
                kind: 'group',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                groupId: 'future-team',
            });
            for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        // The page names what the gateway draws on once a slot is set (lab GW1).
        await waitForHomeGovernance(() => expect(String(findComposite(screen, 'provider-connection-header', 'description')
            ?.props.description)).toMatch(/^settingsProvidersCollection\.gateway\.descriptionNamed\(services=.+\)$/));
        expect(stored.catalog.connections[0]).toMatchObject({ revision: 5,
            deployment: { kind: 'managedLocal' },
            purposeBindingDefaults: {
                    'openai-upstream': expect.objectContaining({
                        kind: 'group',
                        groupId: 'future-team',
                    }),
            },
        });

        expect(state.connection?.deployment).toMatchObject({ kind: 'managedLocal', effects: {
            connectedAccountPurposes: [expect.objectContaining({ target: expect.objectContaining({ groupId: 'team' }) })],
        } });
        expect(run).not.toHaveBeenCalled();
    });

    it('explicitly contracts a declared managed local service back to external through the Account writer', async () => {
        state.connection = connection({ contributionKey: 'happier.provider.ollama/ollama', revision: 4,
            deployment: { kind: 'managedLocal', targetMachineId: 'machine-a', effects: null } });
        const stored = installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' },
            role: 'default', displayName: 'Ollama', displayNameMode: 'automatic',
            deployment: { kind: 'managedLocal' }, revision: 4, createdAt: 1, updatedAt: 1 }) });
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-managed-use-external')).toBeTruthy());
        await pressAndFlush(screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-managed-use-external'));
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.catalog.connections[0]).toMatchObject({ revision: 5, deployment: { kind: 'external' } });
        expect(stored.catalog.connections[0]?.purposeBindingDefaults).toBeUndefined();
        expect(confirm).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
    });

    it('turns the whole connection off from the header with one connection-scope disable', async () => {
        state.connection = connection({
            authorized: true,
            grants: { accountEnabled: true, enabledMachineIds: ['machine-a'], effectiveState: 'valid' },
        });
        const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' }, role: 'default',
            displayName: 'Acme', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 });
        // Removal must clear retained grants too, including stale ones from a previous source revision.
        const stored = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: account.serverId,
            catalog: ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [saved], accountGrants: [{ v: 1, connectionId: 'pc_a',
                    connectionSecurityFingerprint: 'retained-account-security', confirmedAt: 1 }],
                machineGrants: [{ v: 1, connectionId: 'pc_a', machineId: 'machine-a',
                    endpointSetFingerprint: 'retained-endpoints', connectionSecurityFingerprint: 'retained-machine-security', confirmedAt: 1 }],
            }) });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const enabled = screen.findByTestId('provider-connection-enabled');
        expect(enabled?.props.value).toBe(true);

        await act(async () => { await enabled?.props.onValueChange(false); });

        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.accountGrants).toEqual([]);
        expect(stored.catalog.machineGrants).toEqual([]);
        expect(run).not.toHaveBeenCalled();
    });

    it('shows a saved key as Saved with Replace and never its value', async () => {
        state.connection = connection({
            credential: { required: true, accountBound: true, boundMachineIds: [] },
        });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);

        expect(findComposite(screen, 'provider-connection-account-api-key.saved', 'children')?.props.children)
            .toBe('settingsProvidersCollection.saved');
        expect(findComposite(screen, 'provider-connection-account-api-key.choose', 'title')?.props.title)
            .toBe('settingsProvidersCollection.replace');
        // No key on this machine yet: it offers to choose one, with no Saved claim.
        expect(screen.findByTestId('provider-connection-machine-api-key.saved')).toBeNull();
        expect(findComposite(screen, 'provider-connection-machine-api-key.choose', 'title')?.props.title)
            .toBe('settingsProvidersCollection.addKey');
    });

    it('links a Connect key result to the existing Provider credential slot', async () => {
        const contributionKey = 'happier.provider.openrouter/openrouter';
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        state.connection = connection({ credential: { required: true, accountBound: false, boundMachineIds: [] } });
        const stored = installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey }, role: 'default',
            displayName: 'OpenRouter', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });
        const ref = 'happier:shared-secret:v1:provider-key';
        installSavedSecretCatalogHttpBoundary({ home: account.home, serverId: account.serverId, resources: [{
            resourceId: 'provider-key', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Provider key', kind: 'apiKey', value: 'private-key' } },
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Provider key', kind: 'apiKey',
                revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] });
        const { Modal } = await import('@/modal');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await waitForHomeGovernance(() => expect(findComposite(screen, 'provider-connection-account-api-key.choose', 'disabled')?.props.disabled).toBe(false));
        const trigger = { measureInWindow: (_callback: unknown) => undefined };
        await act(async () => {
            const button = findComposite(screen, 'provider-connection-account-api-key.choose', 'onPress');
            button?.props.onPress({ currentTarget: trigger });
        });
        const sheet = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].props;
        if (!sheet || typeof sheet !== 'object' || !('request' in sheet) || !('onResult' in sheet) || typeof sheet.onResult !== 'function')
            throw new Error('Expected Provider Connect presentation');
        expect(sheet.request).toMatchObject({ service: { kind: 'key', keyKind: 'apiKey' },
            bindingTarget: { kind: 'provider', contributionKey, slot: 'apiKey' } });
        expect(sheet.request).toMatchObject({ anchor: { kind: 'view', ref: { current: trigger } } });
        const onResult = sheet.onResult;
        await act(async () => { onResult({ kind: 'selected', secretRef: ref }); });
        await waitForHomeGovernance(() => expect(stored.catalog.secretBindingsByConnectionId.pc_a?.account?.apiKey).toBe(ref));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.secretBindingsByConnectionId.pc_a?.byMachineId ?? {}).toEqual({});
    });

    it('offers separate same-source and custom duplication actions', async () => {
        installBundledProviderDeclarationsRpcBoundary(providerHarness);
        const stored = installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'contribution', contributionKey: 'happier.provider.openrouter/openrouter' },
            role: 'default', displayName: 'Acme', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        expect(findMenuAction(screen, 'duplicate')).toBeDefined();
        await act(async () => {
            await findMenuAction(screen, 'duplicateAsCustom')?.props.onPress?.();
        });
        expect(run).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('provider-connection-duplicate-name', 'Custom copy'); });
        await screen.pressByTestIdAsync('provider-connection-duplicate-save');
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.catalog.connections).toHaveLength(2);
        expect(stored.catalog.connections.find(row => row.id !== 'pc_a')).toMatchObject({
            role: 'named', displayName: 'Custom copy', source: { kind: 'custom' }, revision: 0,
        });
        expect(run).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('commits endpoint overrides from the inline field to the same revisioned writer', async () => {
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-chat'),
            name: 'Acme', baseUrl: 'https://acme.test/v1', requiresApiKey: false, catalog: 'manual' });
        const endpointId = template.endpointTemplates[0]!.id;
        state.connection = connection({ revision: 3, endpoints: [{
            endpointTemplateId: endpointId, protocol: 'openai-chat', baseUrl: 'https://acme.test/v1',
            defaultBaseUrl: 'https://acme.test/v1', accountOverrideBaseUrl: null,
            machineOverrideBaseUrl: null, effectiveSource: 'template',
        }] });
        const stored = installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
            source: { kind: 'custom', template }, role: 'named', displayName: 'Acme', displayNameMode: 'custom',
            revision: 3, createdAt: 1, updatedAt: 1 }) });
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        await openAdvanced(screen);
        const fieldId = `provider-connection-endpoint.${endpointId}.account`;
        const field = () => screen.findAllByTestId(fieldId).find((node) => typeof node.props.onChangeText === 'function');
        expect(field()).toBeDefined();
        await act(async () => { field()?.props.onChangeText('https://edited.example/v1'); });
        await act(async () => { field()?.props.onSubmitEditing(); });
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections[0]).toMatchObject({ revision: 4,
            endpointOverrides: [{ endpointTemplateId: endpointId, baseUrl: 'https://edited.example/v1' }],
        });
        expect(stored.catalog.connections[0]?.endpointOverridesByMachineId).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
    });
    it('renames the connection through its update write, with the owner validation inline', async () => {
        state.connection = connection({ displayName: 'Acme', revision: 3 });
        const stored = installDetailCatalog();
        const { ProviderConnectionDetailScreen } = await import('./ProviderConnectionDetailScreen');
        const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
        const nameField = () => findComposite(screen, 'provider-connection-name', 'onChangeText');
        expect(nameField()?.props.value).toBe('Acme');

        // Leaving the field unchanged writes nothing.
        await act(async () => { await nameField()?.props.onBlur?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(stored.writes).toBe(0);

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
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections[0]).toMatchObject({ id: 'pc_a', revision: 4,
            displayName: 'Work', displayNameMode: 'custom' });
        expect(ProviderConnectionsRowMutationV1Schema.parse(accountCatalogWrites()[0]?.input).expectedRevision).toBe(1);
        expect(run).not.toHaveBeenCalled();
    });

    it('lists the connection models on its Models page, with no second scroll owner', async () => {
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
        const { ProviderConnectionModelsScreen } = await import('./models/ProviderConnectionModelsScreen');
        const screen = await renderScreen(<ProviderConnectionModelsScreen connectionId="pc_a" />);
        await flushHookEffects();

        const manager = screen.findByType(ProviderModelManager);
        expect(manager.props.page).toBeDefined();
        expect(manager.props.groups[0].rows.map((row: { descriptor: { name: string } }) => row.descriptor.name))
            .toEqual(['Model one', 'Model two']);
        // The page header scrolls with the list: it is part of the same list.
        expect(findComposite(screen, 'provider-connection-models-header', 'title')?.props.title)
            .toBe('settingsProviders.detail.modelsTitle');
        // Hidden models stay out of the list until asked for; the visible one is a row with its switch.
        const { providerModelRowKey } = await import('@/providers/models/modelRowKey');
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'model-one')}`)).not.toBeNull();
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'model-two')}`)).toBeNull();
        expect(screen.findAllByType(SelectionListScreen)).toHaveLength(0);
        expect(screen.findByTestId('provider-connection-manage-models')).toBeNull();
    });
    describe('Usage (declared usage sources)', () => {
        const OPENROUTER = 'happier.provider.openrouter/openrouter';
        const usageSources = [
            { id: 'key-usage', endpointTemplateId: 'openrouter-openai-chat', path: '/api/v1/key', parser: 'openrouter-key-usage' },
            { id: 'account-credits', endpointTemplateId: 'openrouter-openai-chat', path: '/api/v1/credits', parser: 'openrouter-account-credits',
                billingCredential: { slotId: 'managementKey', title: 'Management key', keyUrl: 'https://openrouter.ai/settings/management-keys',
                    destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } } },
        ];
        const usd = { unit: 'usd', utilizationPct: null, resetsAt: null, status: 'ok', source: 'provider_api', confidence: 'exact', details: {} };
        function installUsageConnection() {
            installBundledProviderDeclarationsRpcBoundary(providerHarness, { [OPENROUTER]: { usageSources } });
            return installDetailCatalog({ saved: ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a',
                source: { kind: 'contribution', contributionKey: OPENROUTER },
                role: 'default', displayName: 'OpenRouter', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }) });
        }
        const usageRequests = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH);

        it('shares presented usage demand and reacquires after binding the billing key without touching the API key', async () => {
            const stored = installUsageConnection();
            // No Machine can acquire usage yet, so the unchecked state is stable
            // rather than a race against the first presented-demand request.
            await account.publishMachines(account.serverId, []);
            await account.selectMachine(account.serverId, null);
            // The Account's Saved Secret catalog is the genuine HTTP leaf the bind writer admits against.
            const ref = 'happier:shared-secret:v1:billing-key';
            installSavedSecretCatalogHttpBoundary({ home: account.home, serverId: account.serverId, resources: [{
                resourceId: 'billing-key', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'OpenRouter management', kind: 'token', value: 'private-key' } },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'OpenRouter management', kind: 'token',
                    revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            const { Modal } = await import('@/modal');
            const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:billing-key:managementKey')).not.toBeNull());
            // The machine section says a machine is missing; Usage does not say it again.
            expect(screen.findByTestId('provider-connection-usage:not-checked')).toBeNull();
            expect(screen.findByTestId('provider-connection-usage:account')).toBeNull();
            const row = screen.findAllByType(Item).find(item => item.props.testID === 'provider-connection-usage:billing-key:managementKey');
            expect(row?.props.title).toBe('Management key');
            expect(findProviderExternalLink(screen, 'settingsProvidersCollection.usage.getBillingKey')).toBeDefined();
            expect(usageRequests()).toHaveLength(0);
            await account.publishMachines(account.serverId, machines);
            await account.selectMachine(account.serverId, 'machine-a');
            await waitForHomeGovernance(() => expect(usageRequests()).toHaveLength(1));

            await screen.pressByTestIdAsync('provider-connection-usage:billing-key:managementKey.choose');
            expect(vi.mocked(Modal.show)).toHaveBeenCalled();
            const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0] as { props?: { onResult?: (result: { kind: 'selected'; secretRef: string }) => void } } | undefined;
            const [{ refreshSavedSecretCatalog }, { storage }] = await Promise.all([
                import('@/sync/engine/settings/savedSecretCatalogEngine'), import('@/sync/domains/state/storage')]);
            const settingsScope = storage.getState().settingsScope;
            if (!settingsScope) throw new Error('Expected the restored Account settings scope');
            await act(async () => { await refreshSavedSecretCatalog(settingsScope); });
            await act(async () => { picker?.props?.onResult?.({ kind: 'selected', secretRef: ref }); });
            const binds = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE
                && (request.payload as { action?: string }).action === 'bindSecret');
            const bound = () => [...binds().map(request => request.payload),
                ...(stored.writes > 0 ? [(stored.catalog.secretBindingsByConnectionId as Readonly<Record<string, unknown>>).pc_a] : [])];
            await waitForHomeGovernance(() => expect(bound()).toHaveLength(1));
            // One write, to the billing slot only: the inference key's slot is never named or replaced.
            expect(JSON.stringify(bound())).toContain('managementKey');
            expect(JSON.stringify(bound())).toContain(ref);
            expect(JSON.stringify(bound())).not.toContain('apiKey');
            await waitForHomeGovernance(() => expect(usageRequests()).toHaveLength(2));
        });

        it('shows what one explicit Refresh reported: amounts as reported, unknown as unknown, and no account credits without a billing key', async () => {
            installUsageConnection();
            const { buildProviderAccountUsageRecordId } = await import('@happier-dev/protocol/connect/account-usage-primitives');
            const recordKey = { providerId: 'openrouter', accountSubjectId: 'subject', subjectKind: 'unknown', quotaScope: 'provider' } as const;
            providerHarness.setResponse(RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH, DaemonProviderUsageRefreshResponseV1Schema.parse({ status: 'success', sources: [
                { sourceId: 'key-usage', status: 'ok', snapshot: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
                    providerId: 'openrouter', accountSubject: { kind: 'provisionalLocalSubject', id: 'subject' },
                    observedAtMs: 1000, fetchedAtMs: 1000, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
                    meters: [
                        { ...usd, meterId: 'key-spend-daily', label: 'Today', used: 1.25, limit: null },
                        { ...usd, meterId: 'key-allowance', label: 'Allowance', used: null, limit: null, remaining: null },
                    ] } },
                { sourceId: 'account-credits', status: 'not_configured' },
            ] }));
            const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:refresh')).not.toBeNull());
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:key')).not.toBeNull());
            expect(usageRequests()).toHaveLength(1);
            await screen.pressByTestIdAsync('provider-connection-usage:refresh');
            await waitForHomeGovernance(() => expect(usageRequests()).toHaveLength(2));
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:key')).not.toBeNull());
            const spend = screen.findByTestId('provider-connection-usage:meter:key-spend-daily');
            expect(spend?.props.accessibilityLabel).toBe('Today, $1.25');
            expect(screen.findByTestId('provider-connection-usage:meter:key-spend-daily:bar')).toBeNull();
            expect(screen.findByTestId('provider-connection-usage:meter:key-allowance')?.props.accessibilityLabel).toBe('Allowance, common.unavailable');
            expect(screen.findByTestId('provider-connection-usage:meter:key-allowance:bar')).toBeNull();
            expect(screen.findByTestId('provider-connection-usage:account')).toBeNull();
            expect(screen.findByTestId('provider-connection-usage:not-checked')).toBeNull();
        });

        it('takes a refresh that needs the API key to the same Saved Secret picker and writer as the API key row, with no Retry', async () => {
            state.connection = connection({ credential: { required: true, accountBound: false, boundMachineIds: [] } });
            const stored = installUsageConnection();
            const ref = 'happier:shared-secret:v1:api-key';
            installSavedSecretCatalogHttpBoundary({ home: account.home, serverId: account.serverId, resources: [{
                resourceId: 'api-key', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'OpenRouter key', kind: 'token', value: 'private-key' } },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'OpenRouter key', kind: 'token',
                    revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            providerHarness.setResponse(RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH, DaemonProviderUsageRefreshResponseV1Schema.parse({ status: 'success', sources: [
                { sourceId: 'key-usage', status: 'error', error: createProviderErrorV1('provider_secret_missing', {}) },
                { sourceId: 'account-credits', status: 'not_configured' },
            ] }));
            const { Modal } = await import('@/modal');
            const screen = await renderReadyProviderDetail(<ProviderConnectionDetailScreen connectionId="pc_a" />);
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:refresh')).not.toBeNull());
            // Presented demand acquires once before the person's explicit Refresh.
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:error:key-usage')).not.toBeNull());
            expect(usageRequests()).toHaveLength(1);
            await screen.pressByTestIdAsync('provider-connection-usage:refresh');
            await waitForHomeGovernance(() => expect(usageRequests()).toHaveLength(2));
            await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-usage:error:key-usage')).not.toBeNull());
            expect(usageRequests()).toHaveLength(2);
            expect(screen.findByTestId('provider-connection-usage:error:key-usage:action')?.props.accessibilityLabel).toBe('settingsProvidersCollection.addKey');

            vi.mocked(Modal.show).mockClear();
            await screen.pressByTestIdAsync('provider-connection-usage:error:key-usage:action');
            expect(vi.mocked(Modal.show)).toHaveBeenCalledOnce();
            expect(usageRequests()).toHaveLength(2);
            const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0] as { props?: { onResult?: (result: { kind: 'selected'; secretRef: string }) => void } } | undefined;
            const [{ refreshSavedSecretCatalog }, { storage }] = await Promise.all([
                import('@/sync/engine/settings/savedSecretCatalogEngine'), import('@/sync/domains/state/storage')]);
            const settingsScope = storage.getState().settingsScope;
            if (!settingsScope) throw new Error('Expected the restored Account settings scope');
            await act(async () => { await refreshSavedSecretCatalog(settingsScope); });
            await act(async () => { picker?.props?.onResult?.({ kind: 'selected', secretRef: ref }); });
            const binds = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE
                && (request.payload as { action?: string }).action === 'bindSecret');
            const bound = () => [...binds().map(request => request.payload),
                ...(stored.writes > 0 ? [(stored.catalog.secretBindingsByConnectionId as Readonly<Record<string, unknown>>).pc_a] : [])];
            await waitForHomeGovernance(() => expect(bound()).toHaveLength(1));
            // The inference key's own slot, never the billing slot.
            expect(JSON.stringify(bound())).toContain(ref);
            expect(JSON.stringify(bound())).toContain('apiKey');
            expect(JSON.stringify(bound())).not.toContain('managementKey');
        });
    });
});
