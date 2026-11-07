import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/selection/v1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildProviderReasoningModelOptions } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import {
    RPC_METHODS,
    type DaemonProviderModelRowV1,
} from '@happier-dev/protocol/rpc';

import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { createMachineFixture, createDeferred, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen as renderBaseScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import type { ProviderModelLoadUiResult } from '@/providers/hooks/useProviderModelLoadAction';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const connectionId = ProviderConnectionIdSchema.parse('pc_a');

const state = vi.hoisted(() => ({
    manualModelPolicy: 'allowed' as 'allowed' | 'catalog-only',
    connectionRevision: 7,
    error: null as null | ReturnType<typeof createProviderErrorV1>,
    models: [{ id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' }] as DaemonProviderModelRowV1[],
}));
const refresh = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
const alert = vi.hoisted(() => vi.fn());
const loadModel = vi.hoisted(() => vi.fn<(_connectionId: string, _modelId: string) => Promise<ProviderModelLoadUiResult>>(
    async (_connectionId, _modelId) => ({ status: 'loaded', source: 'requested' }),
));
const probeProviderConnection = vi.hoisted(() => vi.fn<(_input: unknown) => Promise<Readonly<{
    status: 'success';
    models: readonly DaemonProviderModelRowV1[];
    requestFingerprint: string;
}>>>(async (_input) => ({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:test' })));
const routerPush = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const navigationDispatch = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
let accountScopeFixture: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
const accountLifetimeController = {
    reset() {
        accountScopeFixture?.dispose();
        accountScopeFixture = undefined;
    },
    async install(accountId: string) {
        this.reset();
        await restoreAccount(accountId);
        const fixture = await activateStorageAccountScope({ serverId: account.serverId, accountId });
        accountScopeFixture = fixture;
        return { retire: () => fixture.dispose() };
    },
};
let modelsRequestCount = 0;

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPush, back: routerBack },
            navigation: { dispatch: navigationDispatch },
        }).module;
    },
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true, spies: { confirm, alert } }).module;
    },
});

// The Home-backed harness reaches the real server/runtime graph; install the
// screen's boundary factories before evaluating that graph during collection.
const { createProviderConnectionViewFixture, createProviderConnectionsDescribeFixture, createProviderModelsFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary, installProviderConnectionsCatalogHttpBoundary } = await import('@/dev/testkit/harness/providerSettingsHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
const machine = createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now() });
let stored: ReturnType<typeof installProviderConnectionsCatalogHttpBoundary>;
let nextCatalogWriteReply: HomeDomainAnswer | undefined;
function catalogMutations() {
    return account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
        .filter(request => request.input != null)
        .map(request => ProviderConnectionsRowMutationV1Schema.parse(request.input));
}
function mutationCatalog(index: number) {
    const content = catalogMutations()[index]?.content;
    if (content?.t !== 'plain') throw new Error('Expected the Plain Account fixture catalog mutation');
    return content.v;
}
async function restoreAccount(
    accountId = 'account-a',
    modelVisibilityByRef = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1.modelVisibilityByRef,
    manualModels: ReadonlyArray<Readonly<{ id: string; name?: string; reasoningEffortLevels?: string[]; addedAt: number }>> = [{ id: 'manual-a', addedAt: 1 }],
) {
    const saved = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
        ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://acme.test/v1', requiresApiKey: false, catalog: 'probe',
    }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: state.connectionRevision, createdAt: 1, updatedAt: 1 });
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [saved], modelVisibilityByRef,
        manualModelsByConnectionId: { pc_a: manualModels } });
    await account.restore({ accountId, serverIdentityId: 'srv_provider_models', machines: [{ ...machine, activeAt: Date.now() }],
        catalog, waivedActions: [
        'providers.models.manual.add', 'providers.models.manual.remove', 'providers.models.visibility.set',
        'providers.models.visibility.reset', 'providers.models.visibility.bulk', 'providers.models.load', 'providers.probe',
        'providers.connections.update',
    ] });
    stored = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: account.serverId, catalog,
        reply: () => {
            const reply = nextCatalogWriteReply;
            nextCatalogWriteReply = undefined;
            return { body: { status: 'updated', revision: stored.revision, cursor: stored.revision }, ...reply };
        },
    });
}
const administrationTarget = { controller: {
    select(machineId: string | null) { return account.selectMachine(account.serverId, machineId); },
    setMachines(rows: ReadonlyArray<Readonly<{ machineId: string; displayName?: string }>>) {
        return account.publishMachines(account.serverId, rows.map(row => createMachineFixture({
            ...machine, id: row.machineId, metadata: { ...machine.metadata!, displayName: row.displayName ?? row.machineId },
        })));
    },
} };
afterAll(async () => { await account.reset(); });

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    });
});
// The Models section is part of the connection page's one virtualized list; the recycler renders
// every segment here.
const legendList = vi.hoisted(() => ({ props: null as null | { data?: ReadonlyArray<{ key: string }> } }));
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const original = await importOriginal<Record<string, unknown>>();
    const mock = createCapturingLegendListMock({ original });
    Object.defineProperty(legendList, 'props', { get: () => mock.state.props });
    return mock.module;
});

// Install transport and platform boundaries before loading the real view graph.
const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
const { MODEL_ROWS_PER_SEGMENT } = await import('@/providers/models/ProviderModelManagerPage');
const { Item } = await import('@/components/ui/lists/Item');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { InlineAddExpander } = await import('@/components/ui/forms/InlineAddExpander');
const { providerModelRowKey } = await import('@/providers/models/modelRowKey');
const { ProviderConnectionModelsPage } = await import('./ProviderConnectionModelsSection');
const { useProviderConnectionModelsSection } = await import('./useProviderConnectionModelsSection');
const { useProviderConnections } = await import('@/providers/hooks/useProviderConnections');
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');
const { useProviderFeatureAvailability } = await import('../ProviderFeatureAvailability');

/**
 * The connection page's Models section as the detail hosts it: the section hook over the live
 * connection read, rendered as the page's list. The rest of the page is covered by the detail's
 * own suite, including the unsaved-changes guard that joins this section's draft.
 */
function ModelsSectionHost(props: Readonly<{ connectionId: string; startAdding?: boolean }>) {
    const { enabled } = useProviderFeatureAvailability();
    const { machineId, resolveCurrentTarget, serverId } = useProviderSettingsTarget();
    const query = useProviderConnections({ enabled, active: true, machineId, serverId, connectionId: props.connectionId });
    const connection = query.data?.connections.find((item) => item.connectionId === props.connectionId) ?? null;
    const models = useProviderConnectionModelsSection({ declarationContext: query.declarationContext,
        connectionId: props.connectionId, connection, enabled, machineId, serverId, resolveCurrentTarget,
        startAdding: props.startAdding,
    });
    return (
        <ProviderConnectionModelsPage
            connectionId={props.connectionId}
            models={models}
            header={<></>}
            footer={<></>}
            revealOnMount={false}
            onRequestClose={() => routerBack()}
        />
    );
}

type RenderedScreen = Awaited<ReturnType<typeof renderBaseScreen>>;
async function renderScreen(element: React.ReactElement) {
    const screen = await renderBaseScreen(element);
    // Real feature/Home reads are asynchronous; interactions start only once
    // the section has published the current catalog (including typed errors).
    await act(async () => {
        await vi.waitFor(() => {
            expect(modelsRequestCount).toBeGreaterThan(0);
            expect(sectionState(screen).initialLoading).toBe(false);
            expect(sectionState(screen).groups).toHaveLength(1);
        });
    });
    return screen;
}
function sectionState(screen: RenderedScreen) {
    return screen.findByType(ProviderConnectionModelsPage).props.models;
}
function renderedModelRowCount(screen: RenderedScreen): number {
    return screen.findAllByType(Item)
        .filter((item) => String(item.props.testID ?? '').startsWith('provider-model-manager.row:')).length;
}
function modelSegments(): ReadonlyArray<{ key: string }> {
    return (legendList.props?.data ?? []).filter((row) => row.key.startsWith('models:rows:'));
}

async function openManualEditor(screen: RenderedScreen) {
    if (screen.findAllByType(FieldTextInput).length === 0) {
        await screen.pressByTestIdAsync('provider-model-add');
    }
}

/** Error pages now use the real shared state card, not a pair of Item rows. */
function presentedTitles(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.getTextContent();
}

async function reviewUnknownCatalogWrite(screen: RenderedScreen) {
    await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
    await waitForHomeGovernance(() => expect(screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown')).not.toBeNull());
    expect(alert).not.toHaveBeenCalled();
    expect(stored.writes).toBe(1);
    expect(catalogMutations()).toHaveLength(1);
    expect(modelsRequestCount).toBe(2);
    expect(sectionState(screen).errorRetry).toBeUndefined();
    expect(sectionState(screen).errorReviewCurrentState).toEqual(expect.any(Function));
    const review = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
    expect(review).not.toBeNull();
    await act(async () => {
        await review?.props.onPress?.();
        await vi.waitFor(() => expect(modelsRequestCount).toBe(3));
    });
    expect(stored.writes).toBe(1);
    expect(catalogMutations()).toHaveLength(1);
    expect(routerPush).not.toHaveBeenCalled();
}

describe('ProviderConnectionModelsSection', () => {
    afterEach(() => { standardCleanup(); accountLifetimeController.reset(); });
    beforeEach(async () => {
        providerHarness.reset();
        navigationDispatch.mockClear();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;
        accountLifetimeController.reset();
        nextCatalogWriteReply = undefined;
        modelsRequestCount = 0;
        state.manualModelPolicy = 'allowed';
        state.connectionRevision = 7;
        state.error = null;
        state.models = [{ id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' }];
        refresh.mockClear();
        confirm.mockClear();
        alert.mockClear();
        loadModel.mockClear();
        probeProviderConnection.mockClear();
        routerPush.mockClear();
        await account.reset();
        await restoreAccount();
        await account.selectMachine(account.serverId, 'machine-a');
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => (
            createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    contributionKey: 'plugin/acme',
                    displayName: 'Acme',
                    providerName: 'Acme',
                    revision: state.connectionRevision,
                })],
            })
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => {
            modelsRequestCount += 1;
            if (modelsRequestCount > 1) await refresh();
            if (state.error) return { status: 'error', error: state.error };
            return createProviderModelsFixture({
                connectionId: 'pc_a',
                connectionRevision: state.connectionRevision,
                models: state.models,
                manualModelPolicy: state.manualModelPolicy,
                modelLoadAction: 'available',
            });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, async (request) => (
            await probeProviderConnection({
                ...(request.payload as { machineId: string; connectionId: string }),
                serverId: request.serverId,
            })
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, async (request) => {
            const payload = request.payload as { connectionId: string; modelId: string };
            return await loadModel(payload.connectionId, payload.modelId);
        });
    });

    it('loads the catalog once Provider availability finishes loading', async () => {
        const features = createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true, localDiscovery: { enabled: true }, localModelManagement: { enabled: true } },
        } });
        const featureRead = createDeferred<void>();
        account.home.answer(account.serverId, '/v1/features', { body: features, respondAfter: featureRead.promise });
        account.home.answer(account.serverId, '/v1/features/authenticated', { body: features, respondAfter: featureRead.promise });
        const { deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        deleteServerFeaturesSnapshot({ serverId: account.serverId });
        const element = <ModelsSectionHost connectionId="pc_a" />;
        await renderBaseScreen(element);

        // The page shows the availability check (the detail's suite covers that notice); the
        // section reads nothing until Providers are available.
        expect(providerHarness.state.requests).toEqual([]);

        await act(async () => {
            featureRead.resolve();
        });
        await waitForHomeGovernance(() => expect(providerHarness.state.requests.map((request) => request.method)).toContain(
            RPC_METHODS.DAEMON_PROVIDERS_MODELS,
        ));
    });

    it('renders catalog rows supplied through the shared Provider RPC boundary and real manager', async () => {
        state.models = [{
                    id: 'boundary-model',
                    name: 'Boundary model',
                    source: 'static',
                    stale: false,
                    loadState: 'loaded',
                    visibility: 'visible',
                }];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(screen.findByType(ProviderModelManager).props.groups[0].rows[0].descriptor.name)
            .toBe('Boundary model');
    });

    it('keeps the model rows of a large catalog mounted as they are while an unrelated draft changes', async () => {
        await withPopoverWebGlobals(async () => {
            state.models = Array.from({ length: 500 }, (_, index): DaemonProviderModelRowV1 => ({
                id: `model-${index}`,
                name: `Model ${index}`,
                source: 'probe',
                stale: false,
                loadState: 'unknown',
                visibility: 'visible',
            }));
            const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
            const segmentsBefore = modelSegments();
            // Every model is listed, in segments the page's recycler mounts near the viewport.
            expect(renderedModelRowCount(screen)).toBe(500);
            expect(segmentsBefore.length).toBeGreaterThan(1);

            await openManualEditor(screen);
            await act(async () => {
                screen.findByType(FieldTextInput).props.onChangeText?.('draft-model');
            });

            const segmentsAfter = modelSegments();
            expect(segmentsAfter).toHaveLength(segmentsBefore.length);
            segmentsAfter.forEach((segment, index) => expect(segment).toBe(segmentsBefore[index]));
        });
    });

    it('lists hidden models only once asked to show them', async () => {
        state.models = [{
            id: 'hidden-model',
            name: 'Hidden model',
            source: 'probe',
            stale: false,
            loadState: 'unknown',
            visibility: 'hidden_all_agents',
        }];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const hiddenRow = `provider-model-manager.row:${providerModelRowKey('pc_a', 'hidden-model')}`;
        expect(screen.findByTestId(hiddenRow)).toBeNull();

        await act(async () => {
            screen.findAllByType('Pressable')
                .find((item) => item.props.accessibilityLabel === 'settingsProviders.models.showHidden')
                ?.props.onPress?.();
        });

        expect(screen.findByTestId(hiddenRow)).not.toBeNull();
    });

    it('filters the listed models by name', async () => {
        state.models = [
            { id: 'alpha', name: 'Alpha', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
            { id: 'beta', name: 'Beta', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
            ...Array.from({ length: MODEL_ROWS_PER_SEGMENT - 1 }, (_, index): DaemonProviderModelRowV1 => ({
                id: `other-${index}`, name: `Gamma ${index}`, source: 'static', stale: false, loadState: 'unknown', visibility: 'visible',
            })),
        ];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(renderedModelRowCount(screen)).toBe(state.models.length);

        await act(async () => {
            screen.findAllByProps({ testID: 'provider-model-manager.filter' })
                .find((node) => typeof node.props.onChangeText === 'function')
                ?.props.onChangeText('bet');
        });

        expect(renderedModelRowCount(screen)).toBe(1);
        expect(screen.findByTestId(`provider-model-manager.row:${providerModelRowKey('pc_a', 'beta')}`)).not.toBeNull();
    });

    it('explains catalog-managed providers without offering manual model entry', async () => {
        state.manualModelPolicy = 'catalog-only';
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(screen.findAllByType(InlineAddExpander)).toHaveLength(0);
        expect(presentedTitles(screen))
            .toContain('settingsProviders.models.providerManagedTitle');
    });

    it('does not claim an empty catalog while the initial catalog is loading or failed', async () => {
        const response = createDeferred<void>();
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => {
            modelsRequestCount += 1;
            await response.promise;
            return { status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') };
        });
        const screen = await renderBaseScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(modelsRequestCount).toBeGreaterThan(0));
        });
        expect(sectionState(screen).initialLoading).toBe(true);
        expect(renderedModelRowCount(screen)).toBe(0);
        expect(screen.findByTestId('provider-model-manager.empty')).toBeNull();
        expect(screen.findAllByType(Item).some((item) => item.props.loading === true)).toBe(true);

        // Settle the same physical read: another mount joins this pending RPC.
        await act(async () => {
            response.resolve();
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(sectionState(screen).initialLoading).toBe(false);
        });
        expect(sectionState(screen).error?.code).toBe('provider_endpoint_unreachable');
        expect(renderedModelRowCount(screen)).toBe(0);
        expect(screen.findByTestId('provider-model-manager.empty')).toBeNull();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('removes only through the manager callback using the current connection revision', async () => {
        state.connectionRevision = 11;
        await restoreAccount();
        await administrationTarget.controller.select('machine-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onRemoveManualModel?.('pc_a', 'manual-a');
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        });

        expect(confirm).not.toHaveBeenCalled();
        expect(catalogMutations()).toEqual([{
            expectedRevision: 1, content: { t: 'plain', v: stored.catalog },
            referencedSavedSecretIds: [], savedSecretRevisions: [],
        }]);
        expect(stored.catalog.connections[0].revision).toBe(11);
        expect(stored.catalog.manualModelsByConnectionId).toEqual({});
    });

    it('adapts connection catalog provenance into the manager multi-source contract', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const row = screen.findByType(ProviderModelManager).props.groups[0].rows[0];

        expect(row.sources).toEqual({ manual: true, static: false, probe: false });
        expect(row).not.toHaveProperty('source');
    });

    it('adds every pasted manual model in one atomic mutation', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('model-a\nmodel-b\nmodel-c');
        });
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
        });

        expect(catalogMutations()).toEqual([{
            expectedRevision: 1, content: { t: 'plain', v: stored.catalog },
            referencedSavedSecretIds: [], savedSecretRevisions: [],
        }]);
        expect(stored.catalog.manualModelsByConnectionId[connectionId]?.map(model => model.id))
            .toEqual(['manual-a', 'model-a', 'model-b', 'model-c']);
        expect(stored.catalog.connections[0].revision).toBe(7);
        expect(sectionState(screen).manualModelText).toBe('');
        expect(sectionState(screen).editorOpen).toBe(false);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('declares the chosen reasoning-effort levels on every added model and none when none are chosen', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('model-a\nmodel-b');
        });
        await screen.pressByTestIdAsync('provider-manual-model-effort.high');
        await screen.pressByTestIdAsync('provider-manual-model-effort.low');
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
        });

        expect(stored.catalog.manualModelsByConnectionId[connectionId]?.map(({ id, reasoningEffortLevels }) => ({ id, reasoningEffortLevels })))
            .toEqual([
                { id: 'manual-a', reasoningEffortLevels: undefined },
                { id: 'model-a', reasoningEffortLevels: ['low', 'high'] },
                { id: 'model-b', reasoningEffortLevels: ['low', 'high'] },
            ]);
        expect(sectionState(screen).manualEffortLevels).toEqual([]);
    });

    it('edits a manual model\'s levels without dropping its name or the levels it already declares', async () => {
        await restoreAccount('account-a', undefined, [{ id: 'manual-a', name: 'Acme A', reasoningEffortLevels: ['low', 'high'], addedAt: 1 }]);
        await account.selectMachine(account.serverId, 'machine-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });

        await act(async () => { screen.findByType(ProviderModelManager).props.onEditManualModel?.('pc_a', 'manual-a'); });
        expect(sectionState(screen).manualEffortLevels).toEqual(['low', 'high']);
        expect(sectionState(screen).editingModelDirty).toBe(false);
        await screen.pressByTestIdAsync('provider-manual-model-effort.medium');
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
        });

        expect(stored.catalog.manualModelsByConnectionId[connectionId]).toEqual([
            { id: 'manual-a', name: 'Acme A', reasoningEffortLevels: ['low', 'medium', 'high'], addedAt: 1 },
        ]);
        expect(sectionState(screen).editingModel).toBeNull();
        expect(sectionState(screen).editorOpen).toBe(false);

        await act(async () => { screen.findByType(ProviderModelManager).props.onEditManualModel?.('pc_a', 'manual-a'); });
        for (const level of ['low', 'medium', 'high']) await screen.pressByTestIdAsync(`provider-manual-model-effort.${level}`);
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await vi.waitFor(() => expect(stored.writes).toBe(2));
            await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
        });
        expect(stored.catalog.manualModelsByConnectionId[connectionId]).toEqual([
            { id: 'manual-a', name: 'Acme A', addedAt: 1 },
        ]);
    });

    describe('output allowance', () => {
        const editorModel = {
            id: 'qwen-base', name: 'Qwen base', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible',
            descriptor: {
                id: 'qwen-base', name: 'Qwen base', contextWindowTokens: 8192,
                inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 0, maxOutputTokens: 4096 },
            },
        } as const satisfies DaemonProviderModelRowV1;
        async function renderWithEditorModel() {
            state.models = [editorModel];
            // The Machine reports the connection revision the Account owner last acknowledged.
            providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, async () => {
                modelsRequestCount += 1;
                return createProviderModelsFixture({ connectionId: 'pc_a', connectionRevision: stored.catalog.connections[0].revision,
                    models: state.models, manualModelPolicy: state.manualModelPolicy, modelLoadAction: 'available' });
            });
            const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
            await act(async () => { await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1)); });
            return screen;
        }
        function openAllowanceEditor(screen: RenderedScreen) {
            return act(async () => { screen.findByType(ProviderModelManager).props.onEditGenerationSettings?.('pc_a', 'qwen-base'); });
        }
        async function typeAllowance(screen: RenderedScreen, text: string) {
            await act(async () => { screen.findByType(FieldTextInput).props.onChangeText?.(text); });
        }

        it('saves the typed allowance through the revision-checked connection update and shows it again, until Clear removes it', async () => {
            const screen = await renderWithEditorModel();
            await openAllowanceEditor(screen);
            expect(sectionState(screen).generationModel?.id).toBe('qwen-base');
            expect(screen.findByTestId('provider-model-generation-clear')).toBeNull();
            expect(screen.getTextContent()).toContain('Qwen base');

            await typeAllowance(screen, '2048');
            await act(async () => {
                await screen.findByType(InlineAddExpander).props.onSave?.();
                await vi.waitFor(() => expect(stored.writes).toBe(1));
                await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
            });
            const [connection] = stored.catalog.connections;
            expect(connection.modelSettings).toEqual({ 'qwen-base': { maxTokens: 2048 } });
            expect(connection.revision).toBe(8);
            expect(sectionState(screen).editorOpen).toBe(false);

            await openAllowanceEditor(screen);
            expect(screen.findByType(FieldTextInput).props.value).toBe('2048');
            expect(screen.getTextContent()).toContain('2,048');
            await screen.pressByTestIdAsync('provider-model-generation-clear');
            await act(async () => { await vi.waitFor(() => expect(stored.writes).toBe(2)); });
            expect(stored.catalog.connections[0].modelSettings?.['qwen-base']?.maxTokens ?? null).toBeNull();

            await openAllowanceEditor(screen);
            expect(screen.findByType(FieldTextInput).props.value).toBe('');
            expect(screen.findByTestId('provider-model-generation-clear')).toBeNull();
        });

        it('refuses a value the model cannot honour without writing', async () => {
            const screen = await renderWithEditorModel();
            await openAllowanceEditor(screen);
            for (const refused of ['', 'abc', '0', '-5', '4097']) {
                await typeAllowance(screen, refused);
                await act(async () => { await screen.findByType(InlineAddExpander).props.onSave?.(); });
                expect(sectionState(screen).editorError, refused).toEqual(expect.any(String));
            }
            expect(stored.writes).toBe(0);
        });
    });

    it('counts the rows the page lists, including models only the Machine discovered', async () => {
        // The Account catalog knows one manual model; the Machine also lists a discovered one.
        state.models = [
            { id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' },
            { id: 'discovered-b', name: 'Discovered B', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' },
            { id: 'discovered-c', name: 'Discovered C', source: 'probe', stale: false, loadState: 'unknown', visibility: 'hidden_all_agents' },
        ];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => { await vi.waitFor(() => expect(sectionState(screen).modelCount).toBe(3)); });
        expect(sectionState(screen).catalogCount).toEqual({ shown: 2, total: 3 });
        expect(screen.getTextContent()).toContain('settingsProvidersCollection.modelsShown(shown=2,total=3)');
    });

    it('names a model\'s declared levels on its row', async () => {
        state.models = [{
            id: 'manual-a', name: 'Manual A', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible',
            descriptor: {
                id: 'manual-a',
                name: 'Manual A',
                capabilities: { reasoningControls: 'supported' },
                modelOptions: buildProviderReasoningModelOptions({ supportedLevels: ['low', 'high'] }) as never,
            },
        }];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });

        expect(screen.getTextContent()).toContain('settingsProviders.models.reasoningEffortSummary(levels=Low, High)');
    });

    it('settles manual model authoring while the acknowledged catalog presentation refresh is pending', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        const revalidation = createDeferred<void>();
        refresh.mockImplementationOnce(() => revalidation.promise);
        await openManualEditor(screen);
        await act(async () => screen.findByType(FieldTextInput).props.onChangeText?.('acknowledged-model'));
        let settled = false;
        let save!: Promise<unknown>;
        await act(async () => {
            save = Promise.resolve(screen.findByType(InlineAddExpander).props.onSave?.()).then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalled());
            expect(stored.catalog.manualModelsByConnectionId[connectionId]?.map(model => model.id)).toContain('acknowledged-model');
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(sectionState(screen).savingManualModels).toBe(false);
            expect(sectionState(screen).manualModelText).toBe('');
            expect(sectionState(screen).editorOpen).toBe(false);
        } finally {
            await act(async () => { revalidation.resolve(); await save; });
        }
    });

    it('persists valid pasted models once while retaining only rejected lines inline', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('valid-model\nbad model\nvalid-model');
        });
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(sectionState(screen).savingManualModels).toBe(false));
        });

        expect(catalogMutations()).toEqual([{
            expectedRevision: 1, content: { t: 'plain', v: stored.catalog },
            referencedSavedSecretIds: [], savedSecretRevisions: [],
        }]);
        expect(stored.catalog.manualModelsByConnectionId[connectionId]?.map(model => model.id))
            .toEqual(['manual-a', 'valid-model']);
        expect(screen.findByType(InlineAddExpander).props.isOpen).toBe(true);
        expect(screen.findByType(FieldTextInput).props.value).toBe('bad model');
        expect(screen.findByType(FieldTextInput).props.error).toBeTruthy();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('renders typed catalog conflict recovery inline without committing or replaying the write', async () => {
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            status: 409, body: { status: 'conflict', revision: stored.revision + 1 },
        });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onResetVisibility?.();
        });
        await waitForHomeGovernance(() => expect(sectionState(screen).error).toMatchObject({
            code: 'provider_connection_changed', connectionId: 'pc_a',
        }));
        expect(screen.findByTestId('provider-error:provider_connection_changed')).not.toBeNull();

        expect(alert).not.toHaveBeenCalled();
        expect(sectionState(screen).errorRetry).toBeUndefined();
        expect(stored.writes).toBe(0);
        expect(catalogMutations()).toHaveLength(1);
        await screen.pressByTestIdAsync('provider-error-action:provider_connection_changed');
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
        expect(catalogMutations()).toHaveLength(1);
    });

    it('shows initial transport failure and preserves stale rows when a later refresh fails', async () => {
        state.models = [];
        state.error = createProviderErrorV1('provider_endpoint_unreachable', {
            connectionId: 'pc_a',
            machineId: 'machine-a',
        });
        const initialFailure = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        expect(renderedModelRowCount(initialFailure)).toBe(0);
        expect(presentedTitles(initialFailure))
            .toContain('settingsProviders.errors.unreachableTitle');
        expect(presentedTitles(initialFailure))
            .toContain('settingsProviders.errors.actions.retry');

        await act(async () => { initialFailure.tree.unmount(); });
        state.models = [{ id: 'stale-a', name: 'Stale A', source: 'manual', stale: true, loadState: 'unknown', visibility: 'visible' }];
        state.error = null;
        const staleFailure = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        state.error = createProviderErrorV1('provider_endpoint_unreachable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });
        await staleFailure.pressByTestIdAsync('provider-model-catalog-refresh');
        await waitForHomeGovernance(() => expect(staleFailure.findByTestId('provider-error:provider_endpoint_unreachable')).not.toBeNull());
        expect(renderedModelRowCount(staleFailure)).toBe(1);
        expect(staleFailure.findByType(ProviderModelManager).props.groups[0].rows).toHaveLength(1);
        expect(presentedTitles(staleFailure))
            .toContain('settingsProviders.errors.unreachableTitle');
    });

    it('turns an ambiguous reset transport failure into current-state review without replay', async () => {
        nextCatalogWriteReply = { dispatchThenFail: true };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onResetVisibility?.(); });

        await reviewUnknownCatalogWrite(screen);
        expect(stored.catalog.modelVisibilityByRef).toEqual({});
    });

    it('contains a bulk visibility transport failure in the same inline recovery owner', async () => {
        nextCatalogWriteReply = { dispatchThenFail: true };
        state.models = [{ ...state.models[0], visibility: 'hidden_all_agents' }];
        await restoreAccount('account-a', {
            [serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: connectionId, modelId: 'manual-a' })]: 'hidden',
        });
        await administrationTarget.controller.select('machine-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => { await screen.findByType(ProviderModelManager).props.onShowAll?.(); });

        await reviewUnknownCatalogWrite(screen);
        expect(stored.catalog.modelVisibilityByRef).toEqual({});
    });

    it('settles overlapping visibility writes in the order the user issued them', async () => {
        // Two rapid toggles for the same model must not race: dispatching them
        // concurrently lets the Account apply them in the opposite order and
        // leave the catalog showing the opposite of the user's last intent.
        const firstRelease = createDeferred<void>();
        nextCatalogWriteReply = { respondAfter: firstRelease.promise };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        const ref = { scope: 'allAgents' as const, providerConnectionId: connectionId, modelId: 'manual-a' };
        const key = serializeModelVisibilityRefV1(ref);
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;

        await act(async () => {
            setVisibility?.(ref, true);
            setVisibility?.(ref, false);
            await vi.waitFor(() => expect(stored.writes).toBe(1));
        });
        expect(catalogMutations()).toHaveLength(1);
        expect(stored.catalog.modelVisibilityByRef).toEqual({ [key]: 'hidden' });

        await act(async () => {
            firstRelease.resolve();
            await vi.waitFor(() => expect(stored.writes).toBe(2));
        });

        expect(catalogMutations().map(mutation => ({
            expectedRevision: mutation.expectedRevision,
            visibility: mutation.content?.t === 'plain' ? mutation.content.v.modelVisibilityByRef : null,
        }))).toEqual([
            { expectedRevision: 1, visibility: { [key]: 'hidden' } },
            { expectedRevision: 2, visibility: {} },
        ]);
        expect(stored.catalog.modelVisibilityByRef).toEqual({});
    });

    it('keeps queued Account visibility writes when the selected machine changes', async () => {
        const firstRelease = createDeferred<void>();
        nextCatalogWriteReply = { respondAfter: firstRelease.promise };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;
        const ref = { scope: 'allAgents' as const, providerConnectionId: connectionId, modelId: 'manual-a' };

        await act(async () => {
            setVisibility?.(ref, true);
            setVisibility?.(ref, false);
            await vi.waitFor(() => expect(stored.writes).toBe(1));
        });
        await act(async () => {
            await administrationTarget.controller.setMachines([
                { machineId: 'machine-a', displayName: 'Mac' },
                { machineId: 'machine-b', displayName: 'Linux' },
            ]);
            await administrationTarget.controller.select('machine-b');
            await flushHookEffects();
        });
        expect(stored.writes).toBe(1);
        await act(async () => {
            firstRelease.resolve();
            await vi.waitFor(() => expect(stored.writes).toBe(2));
            await flushHookEffects();
        });

        expect(catalogMutations().map(mutation => mutation.expectedRevision)).toEqual([1, 2]);
        expect(stored.catalog.modelVisibilityByRef).toEqual({});
    });

    it('retires an Account A queued write even when Account B restores the same machine identity', async () => {
        const accountA = await accountLifetimeController.install('account-a');
        const accountAStored = stored;
        const firstRelease = createDeferred<void>();
        nextCatalogWriteReply = { respondAfter: firstRelease.promise };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(1));
        });
        const setVisibility = screen.findByType(ProviderModelManager).props.onSetVisibility;
        const ref = { scope: 'allAgents' as const, providerConnectionId: connectionId, modelId: 'manual-a' };

        await act(async () => {
            setVisibility?.(ref, true);
            setVisibility?.(ref, false);
            await vi.waitFor(() => expect(accountAStored.writes).toBe(1));
        });
        expect(accountAStored.catalog.modelVisibilityByRef)
            .toEqual({ [serializeModelVisibilityRefV1(ref)]: 'hidden' });

        await act(async () => {
            accountA.retire();
            await accountLifetimeController.install('account-b');
            await administrationTarget.controller.select('machine-a');
            await screen.update(
                <ModelsSectionHost connectionId="pc_a" startAdding />,
            );
            await flushHookEffects();
        });
        const accountBStored = stored;
        refresh.mockClear();

        await act(async () => {
            firstRelease.resolve();
            await flushHookEffects();
        });

        expect(accountAStored.writes).toBe(1);
        expect(accountBStored.writes).toBe(0);
        expect(accountBStored.catalog.modelVisibilityByRef).toEqual({});
        expect(refresh).not.toHaveBeenCalled();
    });
    it('reports a typed manual-model draft as unsaved work to its hosting page', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);

        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('draft-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);
        await act(async () => { sectionState(screen).manualDraft.discard(); });
        expect(sectionState(screen).manualModelText).toBe('');
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);
        expect(catalogMutations()).toEqual([]);
        expect(stored.writes).toBe(0);
    });

    it('retires the Account A manual-model buffer and its editor error when the Account lifetime retires', async () => {
        const accountA = await accountLifetimeController.install('account-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(false);

        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('bad model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        await act(async () => {
            await screen.findByType(InlineAddExpander).props.onSave?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        // Account A authored both an unsaved buffer and inline validation state.
        expect(screen.findByType(FieldTextInput).props.value).toBe('bad model');
        expect(screen.findByType(FieldTextInput).props.error).toBeTruthy();
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);

        await act(async () => { accountA.retire(); });

        // The retired Account leaves no buffer or validation state behind.
        // (The catalog hook also clears Account A's rows through the same
        // lifetime, so the editor may unmount with the cleared policy —
        // the screen's own contract is what must be clean.)
        const modelsView = { props: sectionState(screen) };
        expect(modelsView.props.manualModelText).toBe('');
        expect(modelsView.props.editorError).toBeNull();
        // The page's guard stays truthful: retirement left no unsaved Account A work.
        expect(modelsView.props.manualDraft.dirtyRef.current).toBe(false);
    });

    it('keeps the typed manual-model buffer while the same Account lifetime stays current', async () => {
        await accountLifetimeController.install('account-a');
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('same-account-model');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(screen.findByType(FieldTextInput).props.value).toBe('same-account-model');
        expect(sectionState(screen).manualDraft.dirtyRef.current).toBe(true);
    });

    it('contains a single-model visibility transport failure in the same inline recovery owner', async () => {
        nextCatalogWriteReply = { dispatchThenFail: true };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onSetVisibility?.(
                { scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'manual-a' },
                true,
            );
        });

        await reviewUnknownCatalogWrite(screen);
        expect(stored.catalog.modelVisibilityByRef).toEqual({
            [serializeModelVisibilityRefV1({ scope: 'allAgents', providerConnectionId: connectionId, modelId: 'manual-a' })]: 'hidden',
        });
    });

    it('contains a manual-add transport failure in the same inline recovery owner', async () => {
        nextCatalogWriteReply = { dispatchThenFail: true };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await openManualEditor(screen);
        await act(async () => {
            screen.findByType(FieldTextInput).props.onChangeText?.('new-model');
        });
        await act(async () => { await screen.findByType(InlineAddExpander).props.onSave?.(); });

        await reviewUnknownCatalogWrite(screen);
        expect(stored.catalog.manualModelsByConnectionId[connectionId]?.map(model => model.id)).toEqual(['manual-a', 'new-model']);
    });

    it('contains a manual-remove transport failure in the same inline recovery owner', async () => {
        nextCatalogWriteReply = { dispatchThenFail: true };
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onRemoveManualModel?.('pc_a', 'manual-a');
        });

        await reviewUnknownCatalogWrite(screen);
        expect(stored.catalog.manualModelsByConnectionId).toEqual({});
    });

    it('contains an explicit catalog-refresh transport failure in the same inline recovery owner', async () => {
        probeProviderConnection.mockRejectedValueOnce(new Error('transport failed'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await screen.pressByTestIdAsync('provider-model-catalog-refresh');

        expect(alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('provider-error:agent_error')).not.toBeNull());
        const recovery = screen.findByTestId('provider-error-action:agent_error');
        expect(recovery).not.toBeNull();
        await act(async () => { await recovery?.props.onPress?.(); });
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/providers/pc_a');
        expect(probeProviderConnection).toHaveBeenCalledOnce();
    });

    it('contains a typed model-load transport failure in the same inline recovery owner', async () => {
        loadModel.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a', machineId: 'machine-a',
            }),
        });
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
        });
        await waitForHomeGovernance(() => expect(sectionState(screen).error).toMatchObject({ code: 'provider_endpoint_unavailable' }));
        expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).not.toBeNull();

        expect(alert).not.toHaveBeenCalled();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.retry');
    });

    it('reviews an ambiguous model load on the current catalog without retaining load replay', async () => {
        loadModel.mockRejectedValueOnce(new Error('load acknowledgement lost while daemon work continues'));
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a');
            await vi.waitFor(() => expect(modelsRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
            ).not.toBeNull());
        });

        const view = { props: sectionState(screen) };
        expect(view.props.errorRetry).toBeUndefined();
        expect(view.props.errorLoadModel).toBeUndefined();
        expect(view.props.errorReviewCurrentState).toEqual(expect.any(Function));
        expect(loadModel).toHaveBeenCalledOnce();
        const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
        expect(reviewAction).not.toBeNull();

        await act(async () => {
            await reviewAction?.props.onPress?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(3));
        });
        expect(loadModel).toHaveBeenCalledOnce();
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('retries only catalog refresh after an acknowledged settings mutation', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        state.error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_a', machineId: 'machine-a',
        });

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onResetVisibility?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error-action:provider_endpoint_unavailable'),
            ).not.toBeNull());
        });
        const view = { props: sectionState(screen) };
        expect(view.props.errorRetry).toEqual(expect.any(Function));
        expect(view.props.errorLoadModel).toBeUndefined();
        expect(view.props.errorReviewCurrentState).toBeUndefined();
        expect(stored.writes).toBe(1);
        expect(catalogMutations()).toHaveLength(1);
        const retryRefreshAction = screen.findByTestId('provider-error-action:provider_endpoint_unavailable');
        expect(retryRefreshAction).not.toBeNull();

        await act(async () => {
            await retryRefreshAction?.props.onPress?.();
            await vi.waitFor(() => expect(modelsRequestCount).toBe(3));
        });
        expect(stored.writes).toBe(1);
        expect(catalogMutations()).toHaveLength(1);
    });

    it('applies show-only as one exact atomic bulk mutation without a caller-owned confirmation', async () => {
        state.models = [
            ...state.models,
            { id: 'manual-a-other', name: 'Other model', source: 'static', stale: false, loadState: 'unknown', visibility: 'visible' },
        ];
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => {
            await vi.waitFor(() => expect(renderedModelRowCount(screen)).toBe(2));
        });
        const exactRef = { scope: 'allAgents' as const, providerConnectionId: connectionId, modelId: 'manual-a' };

        confirm.mockResolvedValueOnce(false);
        await act(async () => {
            screen.findByType(ProviderModelManager).props.onShowOnly?.(exactRef);
            await vi.waitFor(() => expect(stored.writes).toBe(1));
            await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        });
        expect(catalogMutations()).toEqual([{
            expectedRevision: 1, content: { t: 'plain', v: stored.catalog },
            referencedSavedSecretIds: [], savedSecretRevisions: [],
        }]);
        expect(stored.catalog.modelVisibilityByRef).toEqual({
            [serializeModelVisibilityRefV1({ ...exactRef, modelId: 'manual-a-other' })]: 'hidden',
        });
        expect(confirm).not.toHaveBeenCalled();
    });

    it('delegates one exact Load action through the contained load hook', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await act(async () => { await screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'manual-a'); });
        await waitForHomeGovernance(() => expect(loadModel).toHaveBeenCalledWith('pc_a', 'manual-a'));
    });

    it('refreshes the provider catalog explicitly and retains the current list while refreshing', async () => {
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        expect(screen.findByTestId('provider-model-catalog-refresh')).not.toBeNull();
        await screen.pressByTestIdAsync('provider-model-catalog-refresh');
        await act(async () => { await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce()); });
        expect(probeProviderConnection).toHaveBeenCalledWith({
            machineId: 'machine-a', serverId: 'srv_provider_models', connectionId: 'pc_a',
        });
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.findByType(ProviderModelManager).props.groups[0].rows).toHaveLength(1);
    });

    it('does not publish a manual catalog refresh after the selected target changes', async () => {
        const deferred = createDeferred<Readonly<{
            status: 'success'; models: readonly []; requestFingerprint: string;
        }>>();
        probeProviderConnection.mockReturnValueOnce(deferred.promise);
        const screen = await renderScreen(<ModelsSectionHost connectionId="pc_a" />);
        await screen.pressByTestIdAsync('provider-model-catalog-refresh');
        await waitForHomeGovernance(() => expect(probeProviderConnection).toHaveBeenCalledOnce());
        await act(async () => {
            await administrationTarget.controller.setMachines([
                { machineId: 'machine-a', displayName: 'Mac' },
                { machineId: 'machine-b', displayName: 'Linux' },
            ]);
            await administrationTarget.controller.select('machine-b');
            await flushHookEffects();
        });
        // Target selection owns a normal catalog load. Isolate publication by
        // the still-pending manual probe from that expected request.
        refresh.mockClear();
        await act(async () => {
            deferred.resolve({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:old-target' });
        });
        await vi.waitFor(() => expect(
            sectionState(screen).refreshingCatalog,
        ).toBe(false));

        expect(refresh).not.toHaveBeenCalled();
    });
});
