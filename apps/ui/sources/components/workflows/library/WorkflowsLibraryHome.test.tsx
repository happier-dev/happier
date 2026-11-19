import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WorkflowsLibraryHome } from './WorkflowsLibraryHome';
import { WorkflowsDestinationIndex } from './WorkflowsDestinationIndex';
// The authoring pane loads this real graph lazily; charge source collection to
// collection rather than the first pane-identity interaction's test clock.
import '@/components/sessions/panes/SessionInPane';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { renderPaneMainColumnConsumer } from '@/dev/testkit/harness/paneMainColumnHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { hrefForDestinationRef, resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { ModalProvider } from '@/modal/ModalProvider';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowRunRecentSummaryFixture as recent } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';

const execute = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const machineRpcAck = vi.hoisted(() => vi.fn());
const windowSize = vi.hoisted(() => ({ width: 800, height: 900 }));
const rowCosts = vi.hoisted(() => new Map<string, {
    read(): { renders: number; commits: number }; reset(): void;
}>());
// Physical Socket.IO ACKs only; the scoped RPC, daemon projection and Action owners remain real.
vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    return { ...actual, io: () => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, payload) => event === SOCKET_RPC_EVENTS.CALL
            ? machineRpcAck(payload) : { v: 1, ok: true, admittedSessionIds: [] });
        return socket;
    } };
});
// The real manager and app dialog own cancellable confirmation settlement.
vi.mock('react-native', async () => {
    const native = await (await import('@/dev/testkit/mocks/reactNative'))
        .createReactNativeNativeMock({ platformOS: 'ios' }, { Dimensions: { get: () => windowSize },
            useWindowDimensions: () => windowSize });
    const ReactRuntime = await import('react');
    const { createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
    // The platform pressable is the row's effect boundary; Collection and its row hooks stay real.
    const Pressable = ReactRuntime.forwardRef<React.ComponentRef<typeof native.Pressable>, React.ComponentProps<typeof native.Pressable>>((props, ref) => {
        const counter = ReactRuntime.useMemo(() => {
            const counter = createRenderCommitCounter();
            if (typeof props.testID === 'string') rowCosts.set(props.testID, counter);
            return counter;
        }, [props.testID]);
        useRenderCommitCounter(counter);
        return ReactRuntime.createElement(native.Pressable, { ...props, ref });
    });
    return { ...native, Pressable };
});
// Native layout boundary: react-test-renderer has no host layout, so the page's real tracker places the windowed
// Library at the top of its viewport and it mounts what that viewport reaches, as a user sees it.
vi.mock('@/components/widgets/nearViewport', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/widgets/nearViewport')>();
    return { ...original, createScrollViewNearViewportTracker: (...args: Parameters<typeof original.createScrollViewNearViewportTracker>) => ({
        ...original.createScrollViewNearViewportTracker(...args), measureSpan: async () => ({ top: 0 }),
    }) };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows', router: { push: routerPush } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native recycler is a system boundary; real Collection row rendering stays below it.
vi.mock('@legendapp/list/react-native', async (original) => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
let httpBoundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
let automationDefinitionResponse: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | null = null;
let machineRows: readonly FetchedMachineRow[] = [];
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <ModalProvider><InjectedAuthProvider credentials={httpBoundary?.credentials ?? null}>
        <UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider>
    </InjectedAuthProvider></ModalProvider>;
}
async function confirmDeletion(screen: Awaited<ReturnType<typeof renderScreen>>, accepted = true) {
    const testID = accepted ? 'actions.confirmation-review.decision-approve' : 'actions.confirmation-review.decision-reject';
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(screen.findHostByTestId(testID)).not.toBeNull();
    });
    await screen.pressByTestIdAsync(testID);
}
async function deleteWithConsent(definitionId: string) {
    // A cold editor still has the application's confirmation host after its list unmounts.
    const screen = await renderScreen(<></>, { wrapper: Wrapper });
    try {
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const deletion = deleteWorkflowDefinition({ definitionId });
        await confirmDeletion(screen);
        return await deletion;
    } finally { await screen.unmount(); }
}

let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
let fixtureHome = 0;
beforeEach(async () => {
    machineRows = [];
    installShippedNativeFrameScheduler();
    previous = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    singleton = await loadSyncSingletonForTests();
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    // Each HTTP fixture is a distinct Home: admitted Account/collection state
    // lives beyond a React store restore and must not alias the next fixture.
    const home = await runtime.upsertAndActivateServer({ serverUrl: `http://listsum-${++fixtureHome}.test`, name: 'Library' });
    httpBoundary = await installWorkflowActionHttpBoundary({
        fixtureResponse: (actionId, input) => execute(actionId, input),
        machineRows: () => machineRows,
        automationDefinitions: async (url, init) => automationDefinitionResponse?.(url, init) });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer(httpBoundary.credentials);
    // Core acquisition owns readiness and applies Account settings. Settle it before
    // controlled settings/Library fixtures, so its initial wake cannot race the scenario.
    const { sync } = await import('@/sync/sync');
    expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
    await sync.resumeSync('server-reachable');
    publishAppliedActiveServerSnapshot(appliedSnapshot());
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' },
        settingsScope: { serverId: home.id, accountId: 'account-a' }, settingsVersion: 1,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowRunListWindows: {}, workflowRunsById: {} });
    const { resolveCollectionSpacesV1 } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
    const { selectCollectionSpace } = await import('@/sync/domains/session/listing/sessionListSpaces');
    const defaultSpace = resolveCollectionSpacesV1(storage.getState().settings.collectionSpacesV1, 'workflow')[0]!;
    expect(await selectCollectionSpace({ serverId: home.id, accountId: 'account-a' }, 'workflow', defaultSpace.id)).toBeUndefined();
    httpBoundary.prime();
});
afterEach(async () => {
    await standardCleanup();
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    machineRpcAck.mockReset();
    (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
    (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
    (await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs')).clearDaemonMergedProjectionCacheForTests();
    routerPush.mockClear();
    await httpBoundary?.dispose();
    httpBoundary = null;
    singleton?.dispose();
    singleton = undefined;
    automationDefinitionResponse = null;
    windowSize.width = 800;
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('workflow library page anatomy', () => {
    it('switches the same workflow library from the table to cards without reading workflow bodies', async () => {
        const previousWidth = windowSize.width;
        windowSize.width = 1440;
        const definitionId = '10000000-0000-4000-8000-000000000082';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Release notes' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'Unexpected fixture request' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        try {
            const { HostCollection } = await import('@happier-dev/plugin-ui');
            const library = () => screen.findAllByType(HostCollection).find(node => node.props.testID === 'workflows-home:collection')!;
            await vi.waitFor(() => expect(library().props.model.keys).toEqual([definitionId]));
            expect(library().props.presentation).toBe('table');
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const action = createDefaultActionExecutor();
            const scope = storage.getState().profileScope!;
            const context = { surface: 'agent' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
            const workflowReads = () => execute.mock.calls.map(([id]) => id)
                .filter(id => id === 'workflow.definition.list' || id === 'workflow.run.summaries' || id === 'workflow.definition.get');
            await vi.waitFor(() => expect(workflowReads()).toContain('workflow.run.summaries'));
            const initialReads = workflowReads();
            expect(initialReads).not.toContain('workflow.definition.get');
            await act(async () => {
                expect(await action.execute('settings.set', {
                    anchor: 'appearance.collectionDisplay', value: { kind: 'workflow', presentation: 'grid' },
                }, context)).toMatchObject({ ok: true });
            });
            expect(library().props.presentation).toBe('grid');
            expect(library().props.model.keys).toEqual([definitionId]);
            await screen.pressByTestIdAsync('workflows-home:presentation:table');
            await vi.waitFor(() => expect(library().props.presentation).toBe('table'));
            expect(library().props.model.keys).toEqual([definitionId]);
            expect(workflowReads()).toEqual(initialReads);
        } finally {
            windowSize.width = previousWidth;
            await screen.unmount();
        }
    });

    it('returns focus to the moved New action after the last workflow is deleted on a wide page', async () => {
        const { WorkflowsColumn } = await import('../column/WorkflowsColumn');
        const definitionId = '10000000-0000-4000-8000-000000000081';
        const previousWidth = windowSize.width;
        windowSize.width = 1440;
        let deleted = false;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: deleted ? [] : [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Last visible workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.definition.delete') {
                deleted = true;
                return { ok: true, result: { definitionId, deleted: true } };
            }
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'Unexpected fixture request' };
        });
        const focused: string[] = [];
        // Host refs are the native focus boundary; column, library, deletion and focus-return owners stay real.
        const screen = await renderScreen(<WorkflowsColumn surface="page" definitionsContent={<WorkflowsLibraryHome />} />, {
            wrapper: Wrapper,
            createNodeMock: element => ({ focus: () => { if (typeof element.props.testID === 'string') focused.push(element.props.testID); } }),
        });
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).not.toBeNull());
            focused.length = 0;
            const { ContextMenu } = await import('@happier-dev/plugin-ui');
            const row = screen.findAll(node => node.props.testID === `workflows-home:row:${definitionId}`
                && Array.isArray(node.props.secondaryActions))[0]!;
            await act(async () => { row.findByType(ContextMenu).props.onSelect('delete'); });
            await vi.waitFor(async () => {
                if (screen.findHostByTestId('actions.confirmation-review.decision-approve')) await confirmDeletion(screen);
                expect(deleted).toBe(true);
            });
            await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).toBeNull());
            await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull());
            expect(screen.findHostByTestId('workflows-home:new')).not.toBeNull();
            await vi.waitFor(() => expect(focused).toContain('workflows-home:new'));
        } finally {
            await screen.unmount();
            windowSize.width = previousWidth;
        }
    });
    it('retains unknown trigger facts when only scheduler enrichment is unavailable', async () => {
        const { WorkflowDefinitionListResultV1Schema } = await import('@happier-dev/protocol/workflows/actionsV1');
        const { workflowLibraryRowFilterFacts } = await import('./useWorkflowLibraryView');
        const definition = WorkflowDefinitionListResultV1Schema.parse({ definitions: [{
            kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000054',
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Unavailable trigger summary' },
            contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null, triggerSummaryErrorCode: 'storage_unavailable',
        }] }).definitions[0]!;
        expect(workflowLibraryRowFilterFacts({ key: definition.definitionId, group: 'library', definition }, null).triggered).toBeUndefined();
        expect(workflowLibraryRowFilterFacts({ key: definition.definitionId, group: 'library',
            definition: { ...definition, triggerSummaryErrorCode: undefined } }, null).triggered).toBe(false);
    });
    it('keeps readable rows and shows unavailable summaries when the selected trigger query fails', async () => {
        const definitionId = '10000000-0000-4000-8000-000000000053';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Readable workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        automationDefinitionResponse = async (url, init) => url.pathname === '/v3/automations/query' && init?.method === 'POST'
            ? Response.json({ error: 'storage_unavailable' }, { status: 404 }) : undefined;
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).not.toBeNull());
        const { t } = await import('@/text');
        const row = screen.findHostByTestId(`workflows-home:row:${definitionId}`)!;
        expect(row.findAll(node => typeof node.type === 'string' && node.children.some(child =>
            typeof child === 'string' && child.includes(t('common.unavailable')))).length).toBeGreaterThan(0);
        expect(screen.findHostByTestId('workflows-home:error')).toBeNull();
    });
    it('keeps pane consumers asleep across unrelated publications and local navigation in a 100-row library', async () => {
        windowSize.width = 1200;
        storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: true }, { source: 'ui' });
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: Array.from({ length: 100 }, (_, index) => ({
                kind: 'workflow-definition.v1', definitionId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Saved workflow ${index}` },
                ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            })) } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const destination = (unavailable: boolean) => <AppPaneProvider>
            <DestinationInstanceHost tabId="pane-library" ref={{ kind: 'workflows', params: {
                authoringSessionId: 'missing-authoring-session', ...(unavailable ? { automationUnavailable: '1' } : {}),
            } }} pathname="/workflows" focused visible
                navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
                <WorkflowsDestinationIndex />
            </DestinationInstanceHost>
        </AppPaneProvider>;
        const screen = await renderScreen(destination(false), { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000000')).not.toBeNull());
        const descriptor = () => screen.findByType(AppPaneScopeHost).props.mainColumn;
        const consumer = await renderPaneMainColumnConsumer(descriptor());
        expect(consumer.read().current?.identity.name).toBe('workflows.title');
        consumer.reset();
        await act(async () => { storage.setState({ socketStatus: 'disconnected' }); });
        await consumer.publish(descriptor());
        expect(consumer.read().executions).toBe(0);
        await screen.update(destination(true));
        expect(screen.findHostByTestId('retired-automation-unavailable')).not.toBeNull();
        await consumer.publish(descriptor());
        expect(consumer.read().executions).toBe(0);
        windowSize.width = 800;
    });
    it.each(['library', 'column'] as const)('retains the library and creates a distinct draft for each %s Import entrance', async entrance => {
        const { WorkflowsColumnActions } = await import('../column/WorkflowsColumnActions');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            workflows: true, friends: false, inbox: false, externalSessions: false,
        } });
        let current: WorkspaceNavigationContextValue | null = null;
        let libraryId: string | undefined;
        const navigation = (): WorkspaceNavigationContextValue => {
            if (!current) throw new Error('Workspace owner not mounted');
            return current;
        };
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{owner => {
            current = owner;
            libraryId ??= owner.state.groups[owner.state.focusedGroupId].activeTabId;
            const tab = owner.state.tabs[libraryId];
            return <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/workflows"
                focused={owner.state.groups[owner.state.focusedGroupId].activeTabId === tab.id} visible
                navigation={owner.navigationForTab(tab.id)}>
                {entrance === 'library' ? <WorkflowsLibraryHome /> : <WorkflowsColumnActions canCreate />}
            </DestinationInstanceHost>;
        }}</WorkspaceProvider>, { wrapper: Wrapper });
        const activeTab = () => {
            const state = navigation().state;
            return state.tabs[state.groups[state.focusedGroupId].activeTabId];
        };
        // Workspace hydration admits navigation independently of the mounted controls.
        await vi.waitFor(() => expect(navigation().active).toBe(true));
        const library = activeTab();
        const enter = async () => {
            if (entrance === 'column') {
                const menu = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'workflows-column:add:menu');
                if (!menu) throw new Error('Import menu missing');
                await act(async () => menu.props.onSelect('import'));
            } else {
                const id = await vi.waitFor(() => {
                    const id = ['workflows-home:import', 'workflows-home:firstVisit:import']
                        .find(id => screen.findHostByTestId(id) !== null);
                    if (!id) throw new Error('Import button missing');
                    return id;
                });
                await screen.pressByTestIdAsync(id);
            }
        };
        await enter();
        const first = activeTab();
        expect(first.id).not.toBe(library.id);
        expect(hrefForDestinationRef(catalog, first.target)).toBe('/workflows/new?importJson=1');
        await act(async () => { navigation().openHref('/workflows'); });
        expect(activeTab().id).toBe(library.id);
        await enter();
        expect(activeTab().id).not.toBe(first.id);
        expect(navigation().state.tabs[first.id]).toBe(first);
        expect(navigation().state.tabs[library.id]).toMatchObject({ target: library.target });
    });

    it('retires the busy plugin discovery split after a zero-reader deletion acknowledgement', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { createMachineFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { createWorkflowActionHttpTransport } = await import('@/dev/testkit/fixtures/workflowActionHttpTransport');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
        const projection = createDeferred<unknown>();
        const admitted = createDeferred<void>();
        machineRpcAck.mockImplementation(async () => { admitted.resolve(); return projection.promise; });
        const machine = createMachineFixture({ id: 'delete-discovery-machine', activeAt: Date.now() });
        machineRows = [createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })];
        // Admit the real plain Machine content into Sync's bound RPC projection;
        // a display-only Machine fixture lacks its content mode and cannot authorize RPC.
        const { sync } = await import('@/sync/sync');
        await sync.refreshMachines();
        expect(storage.getState().machines[machine.id]?.storageMode).toBe('plain');
        const removedId = '10000000-0000-4000-8000-000000000001';
        const survivorId = '10000000-0000-4000-8000-000000000002';
        const rows = [removedId, survivorId].map(definitionId => ({
            kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: definitionId }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available',
            stepCount: 1, triggers: [], nextRunAt: null,
        }));
        let deleted = false;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: deleted ? [rows[1]] : rows } };
            if (actionId === 'workflow.definition.delete') {
                deleted = true;
                return { ok: true, result: { definitionId: removedId, deleted: true } };
            }
            return { ok: false, error: 'Unexpected fixture request' };
        });
        const initial = await renderHook(() => useWorkflowDefinitionLibrary());
        await vi.waitFor(() => {
            expect(initial.getCurrent().definitions.map(row => row.definitionId)).toEqual([removedId, survivorId]);
            expect(initial.getCurrent().loadingMore).toBe(true);
        });
        await admitted.promise;
        await initial.unmount();
        const confirmation = await renderScreen(<></>, { wrapper: Wrapper });
        const deletion = deleteWorkflowDefinition({ definitionId: removedId });
        await confirmDeletion(confirmation);
        await deletion;
        await act(async () => { projection.resolve({ ok: false, error: 'Daemon unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }); await projection.promise; });
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.list')).toHaveLength(1);
        // Keep the next genuine HTTP list pending while observing retained state on remount.
        const refresh = createDeferred<Response>();
        const transport = createWorkflowActionHttpTransport({ fixtureResponse: (actionId, input) => execute(actionId, input), accountId: () => 'account-a' });
        setRuntimeFetch((input, init) => new URL(String(input)).pathname === '/v1/artifacts' ? refresh.promise : transport.fetch(input, init));
        const returned = await renderHook(() => useWorkflowDefinitionLibrary());
        expect(returned.getCurrent().loadingMore).toBe(false);
        expect(returned.getCurrent().hasMore).toBe(true);
        expect(returned.getCurrent().definitions.map(row => row.definitionId)).toEqual([survivorId]);
        expect(returned.getCurrent().deletedDefinitionId).toBe(removedId);
        await act(async () => { refresh.resolve(new Response(JSON.stringify({ error: 'Library unavailable' }), { status: 404 })); await refresh.promise; });
        expect(returned.getCurrent().status).toBe('failed');
        expect(returned.getCurrent().loadingMore).toBe(false);
        await returned.unmount();
    });
    it('measures 500 library rows while one summary changes and unrelated arrivals stay quiet', async () => {
        const { WorkflowDefinitionListResultV1Schema } = await import('@happier-dev/protocol/workflows/actionsV1');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const definitions = WorkflowDefinitionListResultV1Schema.parse({ definitions: Array.from({ length: 500 }, (_, index) => ({
            kind: 'workflow-definition.v1', definitionId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Budget workflow ${index}` },
            ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
        })) }).definitions;
        const changedId = definitions[0]!.definitionId;
        let changed = false;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: {
                summaries: definitions.map(row => ({ sourceArtifactId: row.definitionId, lastRun: null, recent: [],
                    needsYouCount: changed && row.definitionId === changedId ? 1 : 0,
                    needsYouRunId: changed && row.definitionId === changedId ? 'budget-attention-run' : null })),
                remainingSourceArtifactIds: [],
            } };
            return { ok: false, errorCode: 'unexpected', error: 'Unexpected fixture request' };
        });
        rowCosts.clear();
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${changedId}`)).not.toBeNull());
        const rows = () => [...rowCosts].filter(([id]) => /^workflows-home:row:10000000-0000-4000-8000-\d{12}$/.test(id));
        await vi.waitFor(() => expect(execute.mock.calls.some(([id]) => id === 'workflow.run.summaries')).toBe(true));
        await act(async () => {});
        // 500 definitions, windowed: only the rows near the page's viewport mount.
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().length).toBeLessThan(100);
        const reset = () => { for (const [, counter] of rows()) counter.reset(); };
        reset(); execute.mockClear();
        const serverId = storage.getState().profileScope!.serverId;
        await act(async () => { publishHomeAccountChange(serverId, ['unrelated-budget-session'], { changeKinds: ['session'] }); });
        expect(execute.mock.calls).toHaveLength(0);
        expect(rows().reduce((sum, [, counter]) => sum + counter.read().renders, 0)).toBe(0);
        changed = true;
        await act(async () => { publishHomeAccountChange(serverId, ['workflow-run:budget-attention-run'], { changeKinds: ['account'] }); });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${changedId}:needsYou`)).not.toBeNull());
        const measurement = { rows: rows().length,
            changedRowRenders: rowCosts.get(`workflows-home:row:${changedId}`)?.read().renders,
            unrelatedRowRenders: rows().filter(([id]) => !id.startsWith(`workflows-home:row:${changedId}`))
                .reduce((sum, [, counter]) => sum + counter.read().renders, 0),
            reads: execute.mock.calls.filter(([id]) => id === 'workflow.run.summaries').length };
        console.info('FIN-FLOWBUDGET Library arrival', measurement);
        expect(measurement.reads).toBe(1);
        expect(measurement.changedRowRenders).toBe(1);
        expect(measurement.unrelatedRowRenders).toBe(0);
    });

    it('publishes readable rows despite a generic Home wake while queuing the authoritative follow-up', async () => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const firstPage = createDeferred<unknown>();
        const followUp = createDeferred<unknown>();
        const definitionId = '10000000-0000-4000-8000-000000000001';
        const row = { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: 'Readable while refresh waits' }, ownerAccountId: 'account-a', access: 'owner',
            contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null };
        let reads = 0;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return ++reads === 1 ? firstPage.promise : followUp.promise;
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => { publishHomeAccountChange(storage.getState().profileScope!.serverId); });
        await act(async () => { firstPage.resolve({ ok: true, result: { definitions: [row] } }); await firstPage.promise; });
        expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).not.toBeNull();
        expect(reads).toBe(2);
        await act(async () => { followUp.resolve({ ok: true, result: { definitions: [row] } }); await followUp.promise; });
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
    });
    it('projects a cold editor delete acknowledgement without demanding a library read', async () => {
        const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const removedId = '10000000-0000-4000-8000-000000000001';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.get') return { ok: true, result: { definitionId: removedId,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Cold editor workflow' }, access: 'owner',
                definition: createWorkflowDefinitionFixture() } };
            if (actionId === 'workflow.definition.delete') return { ok: true, result: { definitionId: removedId, deleted: true } };
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        await deleteWithConsent(removedId);
        expect(execute.mock.calls.map(call => call[0])).not.toContain('workflow.definition.list');
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        expect(screen.findHostByTestId('workflows-home:new')).not.toBeNull();
    });
    it.each([false, true])('applies a canonical delete outcome to the warm library while an older list is pending (unmounted=%s)', async (unmounted) => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const beforeId = '10000000-0000-4000-8000-000000000003';
        const removedId = '10000000-0000-4000-8000-000000000001';
        const neighborId = '10000000-0000-4000-8000-000000000002';
        const rows = [beforeId, removedId, neighborId].map(definitionId => ({
            kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title: definitionId === removedId ? 'Delete from editor' : 'Surviving workflow' },
            ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
        }));
        const staleRead = createDeferred<unknown>();
        let deleted = false;
        let listReads = 0;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') {
                if (++listReads === 2) return staleRead.promise;
                return { ok: true, result: { definitions: deleted ? rows.filter(row => row.definitionId !== removedId) : rows } };
            }
            if (actionId === 'workflow.definition.delete') {
                deleted = true;
                return { ok: true, result: { definitionId: removedId, deleted: true } };
            }
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        let screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        const removedRow = () => screen.findHostByTestId(`workflows-home:row:${removedId}`);
        await vi.waitFor(() => expect(removedRow()).not.toBeNull());
        const scope = storage.getState().profileScope!;
        await act(async () => { publishHomeAccountChange(scope.serverId); });
        expect(listReads).toBe(2);
        if (unmounted) await screen.unmount();
        // The editor uses this same writer; no library-row removal callback runs.
        await deleteWithConsent(removedId);
        if (unmounted) {
            await act(async () => { staleRead.resolve({ ok: true, result: { definitions: rows } }); await staleRead.promise; });
            expect(listReads).toBe(2);
            screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        }
        expect(removedRow()).toBeNull();
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        const { Collection } = await import('@happier-dev/plugin-ui');
        expect(screen.findAllByType(Collection)[0]!.props.selection.focusRequest).toEqual({ key: unmounted ? beforeId : neighborId });
        const resurrected: boolean[] = [];
        const { useWorkflowDefinitionLibrary: useLibrary } = await import('./workflowLibraryReads');
        function DeletionObserver() {
            const library = useLibrary();
            resurrected.push(library.definitions.some(row => row.definitionId === removedId));
            return null;
        }
        const observer = await renderScreen(<DeletionObserver />);
        await act(async () => { staleRead.resolve({ ok: true, result: { definitions: rows } }); await staleRead.promise; });
        expect(resurrected).not.toContain(true);
        expect(removedRow()).toBeNull();
        await observer.unmount();
        await screen.unmount();
        const returned = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(returned.findHostByTestId('workflows-home:deleted')).toBeNull();
        expect(returned.findAllByType(Collection)[0]!.props.selection?.focusRequest).toBeUndefined();
    });
    it.each(['pending', 'receipt', 'pending after runtime reactivation'] as const)('retires the prior Account deletion %s in a kept Library', async (phase) => {
        let deleted = false;
        let settleDelete!: (value: unknown) => void;
        const deletion = new Promise(resolve => { settleDelete = resolve; });
        let admitDelete!: () => void;
        const deletionAdmitted = new Promise<void>(resolve => { admitDelete = resolve; });
        execute.mockImplementation(async (actionId: string) => {
            const accountId = storage.getState().profileScope?.accountId;
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
                .filter(id => !deleted || id !== '10000000-0000-4000-8000-000000000001').map(definitionId => ({
                    kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: `${accountId} ${definitionId}` }, ownerAccountId: 'account-a',
                    access: accountId === 'account-a' ? 'owner' : 'view',
                    contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
                })) } };
            if (actionId === 'workflow.definition.delete') { admitDelete(); return deletion; }
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}><WorkflowsLibraryHome /></WorkspaceProvider>, { wrapper: Wrapper });
        const { ContextMenu, Collection } = await import('@happier-dev/plugin-ui');
        const row = (id: string) => screen.findAll(node => node.props.testID === `workflows-home:row:${id}` && Array.isArray(node.props.secondaryActions))[0]!;
        await vi.waitFor(() => expect(row('10000000-0000-4000-8000-000000000001')).toBeDefined());
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const beforeReactivation = captureActiveServerAccountScopeLifetime();
        if (phase === 'pending after runtime reactivation') {
            await act(async () => {
                publishAppliedActiveServerRuntimeAvailability(false);
                publishAppliedActiveServerSnapshot(appliedSnapshot());
            });
        }
        const admittedLifetime = captureActiveServerAccountScopeLifetime();
        let observedRetirement = false;
        const retirementObservation = admittedLifetime?.onRetire(() => { observedRetirement = true; });
        await act(async () => { row('10000000-0000-4000-8000-000000000001').findByType(ContextMenu).props.onSelect('delete'); await Promise.resolve(); });
        await confirmDeletion(screen);
        await deletionAdmitted;
        expect(row('10000000-0000-4000-8000-000000000001').props.busy).toBe(true);
        if (phase === 'receipt') {
            await act(async () => {
                deleted = true;
                settleDelete({ ok: true, result: { definitionId: '10000000-0000-4000-8000-000000000001', deleted: true } });
                await Promise.resolve(); await Promise.resolve();
            });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
            });
        }
        await act(async () => {
            storage.getState().activateProfileScope({ serverId: appliedSnapshot().serverId, accountId: 'account-b' });
            await Promise.resolve(); await Promise.resolve();
        });
        if (phase === 'pending after runtime reactivation') {
            expect(beforeReactivation).not.toBe(admittedLifetime);
            expect(beforeReactivation?.isCurrent()).toBe(false);
        }
        expect(admittedLifetime?.isCurrent()).toBe(false);
        expect(observedRetirement).toBe(true);
        expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('account-b');
        retirementObservation?.dispose();
        expect(screen.getTextContent()).not.toContain('account-a 10000000-0000-4000-8000-000000000002');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        await act(async () => {
            storage.setState({
                settingsScope: { serverId: appliedSnapshot().serverId, accountId: 'account-b' },
                settingsVersion: 1,
                settings: settingsDefaults,
            });
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.getTextContent()).toContain('account-b 10000000-0000-4000-8000-000000000002');
        });
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
        expect(row('10000000-0000-4000-8000-000000000002').props.busy).toBe(false);
        expect(screen.findAllByType(Collection)[0]!.props.selection?.focusRequest).toBeUndefined();
        if (phase !== 'receipt') {
            expect(row('10000000-0000-4000-8000-000000000001').props.busy).toBe(false);
            await act(async () => {
                settleDelete({ ok: false, errorCode: 'workflow_not_found', error: 'Deletion unavailable' });
                await Promise.resolve(); await Promise.resolve();
            });
            expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
            expect(row('10000000-0000-4000-8000-000000000001').props.busy).toBe(false);
        }
    });
    it('keeps a deleting workflow busy until acknowledgement, then names its temporary deletion receipt', async () => {
        const deleted = new Set<string>();
        const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
        let settleDelete!: (value: unknown) => void;
        let deletion = new Promise(resolve => { settleDelete = resolve; });
        let admitDelete!: () => void;
        const deletionAdmitted = new Promise<void>(resolve => { admitDelete = resolve; });
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ids.filter(id => !deleted.has(id)).map(definitionId => ({
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            })) } };
            if (actionId === 'workflow.definition.delete') { admitDelete(); return deletion; }
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, friends: false, inbox: false, externalSessions: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}><WorkflowsLibraryHome /></WorkspaceProvider>, { wrapper: Wrapper });
        const { ContextMenu } = await import('@happier-dev/plugin-ui');
        const row = (id = ids[0]) => screen.findAll(node => node.props.testID === `workflows-home:row:${id}` && Array.isArray(node.props.secondaryActions))[0]!;
        await vi.waitFor(() => expect(row()).toBeDefined());
        const menu = row().findByType(ContextMenu);
        await act(async () => { menu.props.onSelect('delete'); await Promise.resolve(); });
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete')).toEqual([]);
        await confirmDeletion(screen);
        await vi.waitFor(() => expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete')).toHaveLength(1));
        await deletionAdmitted;
        expect(row().props.busy).toBe(true);
        expect(menu.props.items?.find((item: { id: string }) => item.id === 'delete')?.destructive).toBe(true);
        expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).not.toBeNull();
        expect(row().findByType(ContextMenu).props.disabled).toBe(true);
        // The committed feed can reach the list before this caller receives its delete response.
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => {
            deleted.add(ids[0]!);
            publishHomeAccountChange(storage.getState().profileScope!.serverId, undefined, { workflowDefinitionsAffect: true });
        });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${ids[0]}`)).toBeNull());
        await act(async () => {
            settleDelete({ ok: true, result: { definitionId: '10000000-0000-4000-8000-000000000001', deleted: true } });
            await Promise.resolve(); await Promise.resolve();
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        });
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'workflows-home:deleted')?.props.reason)
            .toBe('Saved workflow');
        // The deletion socket may arrive after this caller's named acknowledgement.
        await act(async () => publishHomeAccountChange(storage.getState().profileScope!.serverId, [ids[0]!], {
            source: 'socket', changeKinds: ['artifact'], deletedWorkflowDefinitionIds: [ids[0]!],
        }));
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'workflows-home:deleted')?.props.reason)
            .toBe('Saved workflow');
        // A prior completion must not masquerade as the next confirmed deletion's outcome.
        deletion = new Promise(resolve => { settleDelete = resolve; });
        await act(async () => { row(ids[1]).findByType(ContextMenu).props.onSelect('delete'); await Promise.resolve(); });
        await confirmDeletion(screen);
        expect(row(ids[1]).props.busy).toBe(true);
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
        await act(async () => {
            deleted.add(ids[1]!);
            settleDelete({ ok: true, result: { definitionId: ids[1], deleted: true } });
        });
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'workflows-home:deleted')?.props.reason)
            .toBe('Saved workflow');
        // Both deletions used the real Action/HTTP path. Let the reader's acknowledgement expire
        // without dismissing it from the test or leaving the page.
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull(), { timeout: 10_000 });
    });
    it('shows one loading status rather than selectable placeholder workflows before the library is known', async () => {
        execute.mockImplementation(() => new Promise(() => {}));
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('workflows-home:loading')).not.toBeNull();
        // The filter chips are real controls and stay put; only a placeholder workflow row would be wrong.
        expect(screen.findAll(node => node.props.accessibilityRole === 'checkbox'
            && !String(node.props.testID).includes('-quick-filter:'))).toHaveLength(0);
    });
    it('keeps the workflow and stays quiet when the executor deletion confirmation is cancelled', async () => {
        const definitionId = '10000000-0000-4000-8000-000000000051';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Keep this workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        const { ContextMenu, Collection } = await import('@happier-dev/plugin-ui');
        const row = () => screen.findAll(node => node.props.testID === `workflows-home:row:${definitionId}`
            && Array.isArray(node.props.secondaryActions))[0]!;
        await vi.waitFor(() => expect(row()).toBeDefined());
        await act(async () => { row().findByType(ContextMenu).props.onSelect('delete'); });
        await confirmDeletion(screen, false);
        await vi.waitFor(() => expect(screen.findAllByType(Collection)[0]!.props.selection.focusRequest).toEqual({ key: definitionId }));
        expect(row().props.busy).toBe(false);
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete')).toEqual([]);
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
    });
    it('gives a phone one way to add (the column\'s "+" menu rows) and no second overflow in the title bar (DESIGN-9 N6)', async () => {
        windowSize.width = 390;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000001', revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<DestinationInstanceHost tabId="workflows" ref={{ kind: 'workflows', params: {} }}
            pathname="/workflows" focused visible phone navigation={{ push: routerPush, pushRetainingCurrent: routerPush, replace: () => {}, back: () => {} }}>
            <WorkflowsDestinationIndex />
        </DestinationInstanceHost>, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        // The canonical Workflows root opts out of native chrome; its page owns identity.
        expect(screen.findHostByTestId('workspace-destination-header')).toBeNull();
        // A phone tab like the others: the Home line, Activity and the account avatar above its large title.
        expect(screen.findHostByTestId('main-tab-nav-row')).not.toBeNull();
        expect(screen.findHostByTestId('main-header-account-avatar')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).not.toBeNull());
        // One overflow: the title bar carries no page-actions `⋯` of raw buttons beside the column's own.
        expect(screen.findHostByTestId('page-header-actions.trigger')).toBeNull();
        expect(screen.findHostByTestId('workflows-home:new')).toBeNull();
        // Every workflow start is directly available from the same creation menu.
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
        expect(addMenu).toBeDefined();
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['blank', 'trigger', 'agent', 'example', 'import']);
        await act(async () => { addMenu.props.onSelect('blank'); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/new');
    });
    it('gives a phone-sized web window the same one way to add when no navigation bar shows the title (lab P1)', async () => {
        windowSize.width = 390;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000041', revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        try {
            const screen = await renderScreen(<DestinationInstanceHost tabId="workflows" ref={{ kind: 'workflows', params: {} }}
                pathname="/workflows" focused visible navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
                <WorkflowsDestinationIndex />
            </DestinationInstanceHost>, { wrapper: Wrapper });
            await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000041')).not.toBeNull());
            // Import, Create with an agent and New workflow are not stacked under the page's name.
            expect(screen.findHostByTestId('workflows-home:new')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:import')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:agent')).toBeNull();
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu');
            expect(addMenu?.props.items.map((item: { id: string }) => item.id)).toEqual(['blank', 'trigger', 'agent', 'example', 'import']);
        } finally {
            windowSize.width = 800;
        }
    });
    it('uses one phone main-screen header for the library title, scope and search', async () => {
        windowSize.width = 390;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000051', revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        try {
            const screen = await renderScreen(<DestinationInstanceHost tabId="workflows" ref={{ kind: 'workflows', params: {} }}
                pathname="/workflows" focused visible navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
                <WorkflowsDestinationIndex />
            </DestinationInstanceHost>, { wrapper: Wrapper });
            await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000051')).not.toBeNull());
            // The main-screen header lends the library its title, scope and search (b07a8cd698d).
            const header = screen.findHostByTestId('workflows-column:header');
            expect(header).not.toBeNull();
            expect(header?.findAll(node => typeof node.type === 'string' && String(node.props.testID ?? '').startsWith('workflows-column-space-title')).length).toBeGreaterThan(0);
            expect(screen.findHostByTestId('workflows-column:view:definitions')).not.toBeNull();
            expect(screen.findHostByTestId('workflows-home:header')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:scope-line')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:search')).toBeNull();
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            expect(screen.findAllByType(DropdownMenu).some(menu => menu.props.testID === 'workflows-column:add:menu')).toBe(true);
        } finally {
            windowSize.width = 800;
        }
    });
    it.each(['phone', 'beside column'] as const)('keeps Account-only Workflows out of first-visit on %s', async (surface) => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const accountQueryAdmitted = createDeferred<void>();
        const accountQuery = createDeferred<Response>();
        const [{ AutomationDefinitionDetailSchema, AutomationDefinitionListResponseSchema}, { AutomationStoredWorkflowDefinitionRecipeV2Schema}, { validateWorkflowDefinition}] = await Promise.all([import('@happier-dev/protocol/automations/automationApiV3'), import('@happier-dev/protocol/automations/automationWorkflowRecipeV2'), import('@happier-dev/protocol/workflows/workflowValidationV1')]);
        const { createWorkflowDefinitionFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const inlineDefinition = createWorkflowDefinitionFixture({
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
            blocks: [{ kind: 'step', id: 'first', document: { text: 'Morning digest', references: [], attachments: [] },
                input: [], result: { kind: 'text' } }],
        });
        expect(validateWorkflowDefinition(inlineDefinition).valid).toBe(true);
        const detail = AutomationDefinitionDetailSchema.parse({ id: 'digest', name: 'Morning digest', description: null, enabled: true,
            workflowDefinitionId: null, scopeSessionId: null, targetType: null, existingSessionId: null,
            templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
            assignments: [{ machineId: 'm1', enabled: true, priority: 0, updatedAt: 1 }],
            executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                    inlineDefinition } },
                triggerEvidence: null }),
            triggers: [{ id: 't1', revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'schedule',
                triggerDefinitionEnvelope: null, nextRunAt: null,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } }],
        });
        const { executionRecipe: _privateRecipe, triggers, ...listItem } = detail;
        const list = AutomationDefinitionListResponseSchema.parse({ automations: [{ ...listItem,
            triggers: triggers.map(({ triggerDefinitionEnvelope: _privateEnvelope, ...trigger }) => trigger) }], nextCursor: null });
        automationDefinitionResponse = async (url, init) => {
            if (url.pathname === '/v3/automations/query' && init?.method === 'POST') {
                const { AutomationDefinitionDetailsRequestSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
                const query = AutomationDefinitionDetailsRequestSchema.parse(JSON.parse(String(init.body)));
                if (query.scope !== 'account_inline') return Response.json({ automations: [], nextCursor: null });
                accountQueryAdmitted.resolve();
                return accountQuery.promise;
            }
            return url.pathname === '/v3/automations' ? Response.json(list)
                : url.pathname === '/v3/automations/digest' ? Response.json(detail) : undefined;
        };
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { WorkflowsColumn } = await import('../column/WorkflowsColumn');
        const besideColumn = surface === 'beside column';
        if (besideColumn) windowSize.width = 1440;
        const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: besideColumn, columnVisible: besideColumn }}>
            {besideColumn ? <WorkflowsColumn surface="plane" /> : null}
            <WorkflowsDestinationIndex />
        </AppShellColumnContext.Provider>, { wrapper: Wrapper,
            // Native refs supply geometry; the real Popover owns placement and portal rendering.
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 40, 120, 40) }),
        });
        await accountQueryAdmitted.promise;
        expect(screen.findByTestId('workflows-column:view:runs')).not.toBeNull();
        // An Account Workflow is a Library row: until that read settles this is not yet a first visit.
        expect(screen.findByTestId('workflows-home:firstVisit')).toBeNull();
        expect(screen.findByTestId('workflows-home:empty')).toBeNull();
        await act(async () => { accountQuery.resolve(Response.json({ automations: [detail], nextCursor: null })); });
        if (besideColumn) {
            await vi.waitFor(() => expect(screen.findByTestId('workflows-column:library:account-trigger:digest')).not.toBeNull());
            expect(screen.findByTestId('workflows-home:firstVisit')).toBeNull();
            expect(screen.findByTestId('workflows-home:idle')).toBeNull();
            expect(screen.findByTestId('workflows-home:row:account-trigger:digest')).not.toBeNull();
            expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(0);
            return;
        }
        await vi.waitFor(() => expect(screen.findByTestId('workflows-home:row:account-trigger:digest')).not.toBeNull());
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('workflows.triggers.summary.everyDayAt(time=09:00)');
        });
        expect(screen.findByTestId('workflows-home:firstVisit')).toBeNull();
        expect(screen.findByTestId('workflow-builtins:builtin:plan-with-a-panel')).not.toBeNull();
        // One Library row: no separate trigger group and no switch of its own; its press opens its settings.
        expect(screen.findByTestId('workflows-column:group:triggers')).toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest-switch')).toBeNull();
        await screen.pressByTestIdAsync('workflows-home:row:account-trigger:digest');
        await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull());
        expect(screen.findByTestId('workflows-column:add')).toBeNull();
        await screen.pressByTestIdAsync('workflows-column:more');
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
        expect(screen.findByTestId('workflows-column:more:settings')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:add:trigger')).not.toBeNull();
        // A returning Library keeps the examples one compact row away.
        await reportCollectionLayout(screen, 'workflow-examples:cards');
        expect(screen.findAll(node => /^workflow-examples:.+:use$/.test(String(node.props?.testID ?? ''))).length).toBeGreaterThan(0);
    });
    it('shows the library overview beside the Workflows column (FIN-COMPOSE F10)', async () => {
        windowSize.width = 1440;
        const definitionId = '10000000-0000-4000-8000-000000000071';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Saved workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            if (actionId === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const screen = await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
            <WorkflowsDestinationIndex />
        </AppShellColumnContext.Provider>, { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).not.toBeNull());
        expect(screen.findHostByTestId('workflows-home:idle')).toBeNull();
        // F5 (owner 2026-11-12): the page's toolbar owns the one scope and search beside the column.
        expect(screen.findHostByTestId('workflows-home:search')).not.toBeNull();
        // ov-B (list-detail lab; LAB-PARITY-ALL-1114 → QA-SHELL-1114): the column already lists Built-in, so the page
        // beside it does not repeat that list.
        expect(screen.findAll((node) => node.props.testID === 'workflows-home:builtins')).toHaveLength(0);
        expect(screen.findHostByTestId('workflows-home:scope-line')).not.toBeNull();
        // One primary: New workflow opens the blank draft.
        await screen.pressByTestIdAsync('workflows-home:new');
        expect(routerPush).toHaveBeenCalledWith('/workflows/new');
    });
    it('shows the settled empty library while its first-visit history is pending', async () => {
        let finishHistory!: () => void;
        const history = new Promise<void>(resolve => { finishHistory = resolve; });
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.list') {
                await history;
                return { ok: true, result: { runs: [], metadataByRunId: {} } };
            }
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        try {
            await vi.waitFor(() => expect(execute.mock.calls.some(([id]) => id === 'workflow.run.list')).toBe(true));
            await vi.waitFor(() => expect(screen.findByTestId('workflows-home:empty')).not.toBeNull());
            expect(screen.findByTestId('workflows-home:loading')).toBeNull();
        } finally {
            await act(async () => finishHistory());
            await screen.unmount();
        }
    });

    it.each([false, true])('reads history for an empty library and distinguishes a first visit (has history: %s)', async (hasHistory) => {
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: {
                runs: hasHistory ? [createWorkflowRunSummaryFixture({ id: 'old-run', state: 'succeeded' })] : [], metadataByRunId: {},
            } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await vi.waitFor(() => expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('workflows-home:firstVisit') !== null).toBe(!hasHistory));
        if (hasHistory) await vi.waitFor(() => expect(screen.findByTestId('workflows-home:empty')).not.toBeNull());
        if (!hasHistory) {
            // Lab nav-N3: a first look at a few examples drawn as maps, the whole catalog one press away.
            const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
            const { Collection } = await import('@happier-dev/plugin-ui');
            const cards = screen.findAllByType(Collection).find(collection => collection.props.testID === 'workflow-examples:cards');
            expect(cards?.props.model.keys).toEqual(WORKFLOW_STARTER_EXAMPLES_V1.slice(0, 4).map(example => example.key));
            expect(cards?.props.anatomy.card?.body).toBeDefined();
            expect(screen.findByTestId('workflow-examples:more')).not.toBeNull();
        }
    });
    it('keeps a saved row retained in the window while it is carried, and releases it after', async () => {
        const definitionId = '10000000-0000-4000-8000-000000000011';
        execute.mockImplementation(async (actionId: string) => actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Carried workflow' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null,
            }] } }
            : { ok: true, result: { definitions: [], summaries: [], remainingSourceArtifactIds: [] } });
        const { Collection } = await import('@happier-dev/plugin-ui');
        const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop/entityDragDropHooks');
        // The realm runtime is a module value; its source id is otherwise private to the row.
        const runtime = useEntityDragDropRuntime();
        const registerSource = vi.spyOn(runtime, 'registerSource');
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        const collection = () => screen.findAllByType(Collection)[0]!;
        await vi.waitFor(() => expect(collection().props.model.keys).toContain(definitionId));
        await vi.waitFor(() => expect(registerSource.mock.calls.some(([source]) => {
            const item = source.getItem();
            return item?.kind === 'workflow' && item.workflowId === definitionId;
        })).toBe(true));
        expect(collection().props.retainedRowKeys).toBeUndefined();
        const source = registerSource.mock.calls.map(([candidate]) => candidate).find(candidate => {
            const item = candidate.getItem();
            return item?.kind === 'workflow' && item.workflowId === definitionId;
        })!;
        registerSource.mockRestore();
        let carry: ReturnType<typeof runtime.begin> = null;
        await act(async () => { carry = runtime.begin(source.id, 'pointer'); });
        expect(carry).not.toBeNull();
        await vi.waitFor(() => expect(collection().props.retainedRowKeys).toEqual([definitionId]));
        await act(async () => { carry?.cancel('test'); });
        await vi.waitFor(() => expect(collection().props.retainedRowKeys).toBeUndefined());
        await screen.unmount();
    });

    it('lays saved rows on one page sheet like the sections below, and marks built-ins by purpose with their step count', async () => {
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ['10000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000007'].map((definitionId) => (
                { kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: definitionId }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 1, triggers: [], nextRunAt: null })) } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000007')).not.toBeNull());
        // A populated library needs summaries, not a history-window read just to rule out first visit.
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(0);
        // A sheet's hairline sits between its rows and never after the group's last one.
        const divider = (definitionId: string) => screen.findAll((node) => node.props.testID === `workflows-home:row:${definitionId}`
            && Array.isArray(node.props.secondaryActions))[0]?.props.showDivider;
        expect(divider('10000000-0000-4000-8000-000000000005')).toBe(true);
        expect(divider('10000000-0000-4000-8000-000000000006')).toBe(true);
        expect(divider('10000000-0000-4000-8000-000000000007')).toBe(false);
        const { t } = await import('@/text');
        // Built-in takes the library's row anatomy from the same shared Collection, its mark as the row glyph,
        // never a page-local sheet of icon rows beside the library's rows (PHONE-ROWS-HUNT-1113).
        const { HostCollection } = await import('@happier-dev/plugin-ui');
        expect(screen.findAll((node) => node.type === HostCollection && node.props.testID === 'workflows-home:builtins')).toHaveLength(1);
        const plan = screen.tree.findHostByTestId('workflow-builtins:builtin:plan-with-a-panel');
        expect(plan).not.toBeNull();
        const planCopy = plan!.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join('\n').replace(/\u00a0/g, ' ');
        const { getBuiltinWorkflowCatalogV1} = await import('@happier-dev/protocol/workflows/builtins/catalog');
        const { countWorkflowStepsV1 } = await import('@happier-dev/protocol/workflows/workflowDefinitionEditV1');
        const planEntry = getBuiltinWorkflowCatalogV1().find((entry) => entry.id === 'builtin:plan-with-a-panel')!;
        expect(planCopy).toContain(t('workflows.examples.stepCount', { count: countWorkflowStepsV1(planEntry.definition.blocks) }));
        const marks = (id: string) => screen.findAll((node) => node.props.testID === `workflow-builtins:${id}`)[0]
            ?.findAll((node) => typeof node.props.name === 'string').map((node) => node.props.name) ?? [];
        expect(marks('builtin:plan-with-a-panel')).toContain('list-checks');
        expect(marks('builtin:review-and-converge')).toContain('shield-check');
        expect(marks('builtin:keep-going')).toContain('target');
        const saved = screen.findAll((node) => node.props.testID === 'workflows-home:row:10000000-0000-4000-8000-000000000005'
            && Array.isArray(node.props.secondaryActions))[0]!;
        expect(saved.findAll((node) => node.props.name === 'caret-right')).toHaveLength(0);
        // Every saved row would carry the same workflow glyph, so none does; built-ins keep their purpose marks (LIST-ICONS-1108).
        expect(saved.findAll((node) => node.props.name === 'tree-structure')).toHaveLength(0);
        const { ContextMenu } = await import('@happier-dev/plugin-ui');
        expect(saved.findByType(ContextMenu).props.triggerIcon).toBe('more');
        // A built-in row is a quiet destination: its page holds Run now / Choose a session… (lab `nav-N1`).
        expect(screen.findAllHostsByTestId('workflow-builtins:builtin:plan-with-a-panel:run')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-builtins:builtin:plan-with-a-panel');
        expect(routerPush.mock.calls).toEqual([['/workflows/builtin%3Aplan-with-a-panel']]);
    });
});

describe('workflow library summaries and filter', () => {
    it('binds the Account catalog and device Workflow selection to the mounted filter without a second read', async () => {
        const { CollectionSpacesV1Schema } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const scope = storage.getState().profileScope!;
        const catalog = CollectionSpacesV1Schema.parse({ v: 1, spaces: [{ entityKind: 'workflow', id: 'scheduled', name: 'Scheduled releases',
            icon: { kind: 'icon', name: 'list' }, filter: { view: 'triggered' }, includeNeedsYouEverywhere: false }] });
        const ids = ['10000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000062'];
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ids.map((definitionId, index) => ({
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: index === 0 ? 'Scheduled release' : 'Manual release' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 1, nextRunAt: null,
                triggers: index === 0 ? [{ kind: 'schedule', schedule: { kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null } }] : [],
            })) } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        await act(async () => {
            expect(await action.execute('settings.invoke', { anchor: 'workflow.list.spaces', input: {
                kind: 'collection_space', entityKind: 'workflow', mutation: { op: 'create', space: catalog.spaces[0] },
            } }, context)).toMatchObject({ ok: true, result: { status: 'completed' } });
            expect(await action.execute('settings.set', { anchor: 'workflow.list.selectedSpace', value: { spaceId: 'scheduled' } }, context))
                .toMatchObject({ ok: true });
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${ids[0]}`)).not.toBeNull());
        expect(await action.execute('workflow.library.view.get', {}, { surface: 'agent', serverId: scope.serverId }))
            .toMatchObject({ ok: true, result: { selectedSpaceId: 'scheduled', filters: { view: 'triggered' } } });
        expect(screen.findHostByTestId(`workflows-home:row:${ids[1]}`)).toBeNull();
        const readCount = execute.mock.calls.filter(call => call[0] === 'workflow.definition.list').length;
        await act(async () => {
            expect(await action.execute('settings.set', { anchor: 'workflow.list.selectedSpace', value: { spaceId: 'all-workflows' } }, context))
                .toMatchObject({ ok: true });
        });
        expect(screen.findHostByTestId(`workflows-home:row:${ids[1]}`)).not.toBeNull();
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.list')).toHaveLength(readCount);
    });

    it('uses admitted Library Actions for the displayed membership, query and unavailable views', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().profileScope!.serverId };
        expect(await action.execute('workflow.library.view.get', {}, context))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        const ids = ['10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000022'];
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: ids.map((definitionId, index) => ({
                kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: index === 0 ? 'Release notes' : 'Dependency review' }, ownerAccountId: 'account-a', access: 'owner',
                contentStatus: 'available', stepCount: 2, nextRunAt: null,
                triggers: index === 0 ? [{ kind: 'schedule', schedule: { kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null } }] : [],
            })) } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { remainingSourceArtifactIds: [], summaries: ids.map((sourceArtifactId, index) => ({
                sourceArtifactId, recent: [recent({ runId: `run-${index}`, state: index === 0 ? 'succeeded' : 'running' })],
                lastRun: null, needsYouCount: 0, needsYouRunId: null,
            })) } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol/workflows/builtins/catalog');
        const builtinIds = getBuiltinWorkflowCatalogV1().map(entry => entry.id);
        await vi.waitFor(async () => expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { offeredViews: ['all', 'triggered', 'running'] } }));
        // Built-ins are filter rows like the others (R8-7); the home has no view pills of its own.
        expect(screen.findAll(node => /^workflows-home:filter:/.test(String(node.props?.testID ?? '')))).toHaveLength(0);
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { view: 'all', searchQuery: '', offeredViews: ['all', 'triggered', 'running'], visibleKeys: [...ids, ...builtinIds] } });
        const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
        expect(await invokeScopeAction('workflow.library.view.get', {}, { ...context, runtimeAccountId: 'account-b' }))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        expect(await invokeScopeAction('workflow.library.view.set', { searchQuery: 'foreign' }, { serverId: 'another-home' }))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { filters: { view: 'triggered' } }, context)).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId(`workflows-home:row:${ids[0]}`)).not.toBeNull();
        expect(screen.findHostByTestId(`workflows-home:row:${ids[1]}`)).toBeNull();
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { filters: { view: 'running' }, searchQuery: '  DEPENDENCY  ' }, context)).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId(`workflows-home:row:${ids[0]}`)).toBeNull();
        expect(screen.findHostByTestId(`workflows-home:row:${ids[1]}`)).not.toBeNull();
        expect(screen.findHostByTestId('workflows-home:search')!.props.value).toBe('  DEPENDENCY  ');
        expect(await action.execute('workflow.library.view.set', { filters: { extensions: {
            'test.retired/stage': { kind: 'boolean', value: true },
        } } }, context)).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { filters: { view: 'running' }, visibleKeys: [ids[1]] } });
        await act(async () => { await action.execute('workflow.library.view.set', { filters: { view: 'all' } }, context); });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { view: 'all', searchQuery: '  DEPENDENCY  ', visibleKeys: [ids[1]] } });
        await act(async () => {
            expect(await action.execute('workflow.library.view.reset', {}, context)).toEqual({ ok: true, result: { ok: true } });
        });
        expect(screen.findHostByTestId(`workflows-home:row:${ids[0]}`)).not.toBeNull();
        expect(screen.findHostByTestId(`workflows-home:row:${ids[1]}`)).not.toBeNull();
        await screen.unmount();
        expect(await action.execute('workflow.library.view.set', { searchQuery: 'late' }, context))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        execute.mockImplementation(async (actionId: string) => actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [] } } : { ok: true, result: { runs: [], metadataByRunId: {} } });
        (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => {
            expect(await action.execute('workflow.library.view.set', { filters: { view: 'running' }, searchQuery: 'atomic' }, context))
                .toEqual({ ok: true, result: { ok: true } });
        });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { view: 'running', filters: { view: 'running' }, searchQuery: 'atomic', offeredViews: ['all'], visibleKeys: [] } });
    });

    it('retires Library Actions on retained destination blur and Account lifetime replacement', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().profileScope!.serverId };
        execute.mockImplementation(async (actionId: string) => actionId === 'workflow.definition.list'
            ? { ok: true, result: { definitions: [] } } : { ok: true, result: { runs: [], metadataByRunId: {} } });
        const destination = (focused: boolean) => <DestinationInstanceHost tabId="workflows" ref={{ kind: 'workflows', params: {} }}
            pathname="/workflows" focused={focused} visible={focused} navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
            <WorkflowsLibraryHome />
        </DestinationInstanceHost>;
        const screen = await renderScreen(destination(false), { wrapper: Wrapper });
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list'
            || actionId === 'workflow.run.summaries')).toHaveLength(0);
        await screen.update(destination(true));
        await vi.waitFor(() => expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list'))
            .toHaveLength(1));
        await act(async () => { await action.execute('workflow.library.view.set', { searchQuery: 'retained' }, context); });
        await screen.update(destination(false));
        expect(await action.execute('workflow.library.view.get', {}, context))
            .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        await screen.update(destination(true));
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { searchQuery: 'retained' } });
        // Runtime retirement can occur before React has rendered a replacement Account.
        const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            expect(await invokeScopeAction('workflow.library.view.set', { searchQuery: 'stale' }, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
        });
        const scope = storage.getState().profileScope!;
        await act(async () => {
            storage.setState({ profileScope: { ...scope, accountId: 'account-b' } });
            await httpBoundary!.refreshAccount();
        });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { view: 'all', searchQuery: '' } });
        await act(async () => {
            storage.setState({ profileScope: scope });
            await httpBoundary!.refreshAccount();
        });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { view: 'all', searchQuery: '' } });
    });

    it.each(['succeeded', 'interrupted', 'paused'] as const)('offers Running from the shared summaries without treating a %s run as working', async (inactiveState) => {
        const row = (definitionId: string, title: string) => ({ kind: 'workflow-definition.v1', definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
            metadata: { title }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 2, triggers: [], nextRunAt: null });
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [
                row('10000000-0000-4000-8000-000000000011', 'Release notes'), row('10000000-0000-4000-8000-000000000012', 'Dependency review')] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { remainingSourceArtifactIds: [], summaries: [
                { sourceArtifactId: '10000000-0000-4000-8000-000000000011', recent: [recent({ runId: 'run-live', state: 'running', attentionRequired: true, invocationAttentionRequired: true })],
                    lastRun: { ...recent({ runId: 'run-live', state: 'running', attentionRequired: true, invocationAttentionRequired: true }), createdAt: '2026-10-11T08:00:00.000Z', startedAt: '2026-10-11T08:00:00.000Z', finishedAt: null }, needsYouCount: 1, needsYouRunId: 'run-live' },
                { sourceArtifactId: '10000000-0000-4000-8000-000000000012', recent: [recent({ runId: 'run-done', state: inactiveState })],
                    lastRun: { ...recent({ runId: 'run-done', state: inactiveState }), createdAt: '2026-10-10T08:00:00.000Z', startedAt: '2026-10-10T08:00:00.000Z', finishedAt: inactiveState === 'succeeded' ? '2026-10-10T08:05:00.000Z' : null }, needsYouCount: 0, needsYouRunId: null },
            ] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().profileScope!.serverId };
        // No saved workflow has a trigger, so that view stays away; Running is offered on its own.
        await vi.waitFor(async () => expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { offeredViews: ['all', 'running'] } }));
        await act(async () => { await action.execute('workflow.library.view.set', { filters: { view: 'running' } }, context); });
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000011')).not.toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000012')).toBeNull();
        await screen.pressByTestIdAsync('workflows-home:row:10000000-0000-4000-8000-000000000011:needsYou');
        expect(routerPush).toHaveBeenLastCalledWith(`/workflows/runs/run-live?serverId=${encodeURIComponent(httpBoundary!.serverId)}`);
    });

    it.each([[390, false], [800, true]] as const)('lays a row out for a %ipx window whether or not navigation chrome shows a title (run strip: %s)', async (width, showsStrip) => {
        windowSize.width = width;
        const id = '10000000-0000-4000-8000-000000000031';
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [{
                kind: 'workflow-definition.v1', definitionId: id, revision: { headerVersion: 1, bodyVersion: 1 },
                metadata: { title: 'Release notes' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available',
                stepCount: 2, triggers: [], nextRunAt: null }] } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { remainingSourceArtifactIds: [], summaries: [{
                sourceArtifactId: id, recent: [recent({ runId: 'run-1', state: 'succeeded' })], lastRun: null, needsYouCount: 0, needsYouRunId: null }] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        try {
            // No NavigationTitleChromeProvider: a fresh narrow load without phone chrome is still a phone-sized window.
            const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
            await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${id}`)).not.toBeNull());
            // Definition and summary transport reads settle separately; the row may paint first.
            await vi.waitFor(() => expect(screen.findHostByTestId(`workflows-home:row:${id}:strip`) !== null).toBe(showsStrip));
        } finally {
            windowSize.width = 800;
        }
    });

    it('paints count and shared trigger wording, and filters attached triggers without losing manual workflows', async () => {
        let deletedDefinitionId: string | undefined;
        automationDefinitionResponse = async (url, init) => init?.method === 'DELETE'
            && url.pathname === '/v3/automations/automation-10000000-0000-4000-8000-000000000004'
            ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : undefined;
        execute.mockImplementation(async (actionId: string, input: { definitionId?: string }) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [
                { kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000003', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Manual work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 3, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000004', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Timed work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'available', stepCount: 2, nextRunAt: 1_900_000_000_000,
                    triggers: [{ kind: 'schedule', schedule: { kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: null } }] },
                { kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000008', revision: { headerVersion: 1, bodyVersion: 1 },
                    metadata: { title: 'Unreadable work' }, ownerAccountId: 'account-a', access: 'owner', contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header', stepCount: null, triggers: [], nextRunAt: null },
                { kind: 'workflow-definition.v1', definitionId: '10000000-0000-4000-8000-000000000009', revision: null, metadata: null,
                    ownerAccountId: 'account-a', access: 'owner', contentStatus: 'unavailable', contentUnavailableReason: 'invalid_header',
                    stepCount: null, triggers: [], nextRunAt: null },
            ].filter(row => row.definitionId !== deletedDefinitionId) } };
            if (actionId === 'workflow.definition.delete') {
                deletedDefinitionId = input.definitionId;
                return { ok: true, result: { definitionId: input.definitionId, deleted: true } };
            }
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            if (actionId === 'workflow.run.summaries') return { ok: true, result: { summaries: [], remainingSourceArtifactIds: [] } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        const { formatTriggerSetSummary, formatNextScheduledRun } = await import('../triggers/formatTriggerSummary');
        const { t } = await import('@/text');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const action = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: storage.getState().profileScope!.serverId };
        const setView = async (view: 'all' | 'triggered') => {
            await act(async () => { await action.execute('workflow.library.view.set', { filters: { view } }, context); });
        };
        await vi.waitFor(async () => expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true,
            result: { offeredViews: ['all', 'triggered'] } }));
        const manual = screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003');
        expect(manual).not.toBeNull();
        const copy = manual!.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children).join('\n');
        expect(copy).toContain(t('workflows.examples.stepCount', { count: 3 }));
        expect(copy).toContain(formatTriggerSetSummary([]));
        expect(copy).not.toContain(formatNextScheduledRun(1_900_000_000_000));
        const timed = screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000004');
        expect(timed).not.toBeNull();
        expect(timed!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n'))
            .toContain(formatNextScheduledRun(1_900_000_000_000));
        const unreadable = screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000008');
        expect(unreadable).not.toBeNull();
        const unavailableCopy = unreadable!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(unavailableCopy).toContain(t('common.unavailable'));
        expect(unavailableCopy).toContain(t('workflows.contentReasons.invalidHeader'));
        expect(unavailableCopy).not.toContain(t('workflows.examples.stepCount', { count: 0 }));
        const malformed = screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000009');
        expect(malformed).not.toBeNull();
        const malformedCopy = malformed!.findAll(node => typeof node.props.children === 'string').map(node => node.props.children).join('\n');
        expect(malformedCopy).toContain(t('common.unavailable'));
        expect(malformedCopy).toContain(t('workflows.contentReasons.invalidHeader'));
        for (const definitionId of ['10000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000009']) {
            const overflow = screen.findAll(node => node.props.testID === `workflows-home:row:${definitionId}`
                && Array.isArray(node.props.secondaryActions))[0];
            expect(overflow).toBeDefined();
            expect(overflow!.props.secondaryActions.find((action: { id: string }) => action.id === 'run')).toMatchObject({ disabled: true });
            await act(async () => { overflow!.props.onSecondaryAction('run'); });
        }
        expect(routerPush).not.toHaveBeenCalled();
        await setView('triggered');
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000004')).not.toBeNull();
        await setView('all');
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).not.toBeNull();
        await setView('triggered');
        await deleteWithConsent('10000000-0000-4000-8000-000000000004');
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { offeredViews: ['all'] } });
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).toBeNull();
    });
});
