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
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { hrefForDestinationRef, resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { ModalProvider, useModal } from '@/modal/ModalProvider';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowRunRecentSummaryFixture as recent } from '@/dev/testkit/fixtures/workflowRunFixtures';

const execute = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const machineRpcAck = vi.hoisted(() => vi.fn());
const nativeAlert = vi.hoisted(() => vi.fn<typeof import('react-native')['Alert']['alert']>());
const windowSize = vi.hoisted(() => ({ width: 800, height: 900 }));
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
// Native Alert is the platform boundary. The real manager owns confirmation
// settlement and the real provider retains any custom modal custody.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }, { Alert: { alert: nativeAlert }, Dimensions: { get: () => windowSize }, useWindowDimensions: () => windowSize }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows', router: { push: routerPush } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native recycler is a system boundary; real Collection row rendering stays below it.
vi.mock('@legendapp/list/react-native', async (original) => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
let httpBoundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
let automationDefinitionResponse: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | null = null;
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
const searchRuntime = { open: () => {}, buildCommands: () => [] };
let modals: ReturnType<typeof useModal>['state']['modals'] = [];
let answeredNativeConfirmations = 0;
function ObserveModals() { modals = useModal().state.modals; return null; }
function Wrapper({ children }: React.PropsWithChildren) {
    return <ModalProvider><ObserveModals /><InjectedAuthProvider credentials={httpBoundary?.credentials ?? null}>
        <UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider>
    </InjectedAuthProvider></ModalProvider>;
}
async function confirmDeletion(accepted = true) {
    await vi.waitFor(() => expect(nativeAlert.mock.calls.length).toBeGreaterThan(answeredNativeConfirmations));
    const buttons = nativeAlert.mock.calls[answeredNativeConfirmations++]?.[2];
    const confirm = buttons?.find(button => (accepted ? button.style !== 'cancel' : button.style === 'cancel')
        && typeof button.onPress === 'function');
    expect(confirm?.onPress).toBeTypeOf('function');
    await act(async () => { confirm?.onPress?.(); });
}
async function deleteWithConsent(definitionId: string) {
    const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
    const deletion = deleteWorkflowDefinition({ definitionId });
    await confirmDeletion();
    return await deletion;
}
let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
let singleton: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
let fixtureHome = 0;
beforeEach(async () => {
    installShippedNativeFrameScheduler();
    nativeAlert.mockReset();
    answeredNativeConfirmations = 0;
    modals = [];
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
    const { writeCollectionSpaceSelectionV1 } = await import('@/sync/domains/session/listing/sessionListSpaces');
    const defaultSpace = resolveCollectionSpacesV1(storage.getState().settings.collectionSpacesV1, 'workflow')[0]!;
    expect(await writeCollectionSpaceSelectionV1({ scope: { serverId: home.id, accountId: 'account-a' },
        entityKind: 'workflow', spaceId: defaultSpace.id, isCurrent: () => true,
        readSettings: () => storage.getState().settings })).toEqual({ ok: true });
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
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { createWorkflowActionHttpTransport } = await import('@/dev/testkit/fixtures/workflowActionHttpTransport');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
        const projection = createDeferred<unknown>();
        const admitted = createDeferred<void>();
        machineRpcAck.mockImplementation(async () => { admitted.resolve(); return projection.promise; });
        const machine = createMachineFixture({ id: 'delete-discovery-machine', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: {} });
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
        expect(initial.getCurrent().definitions.map(row => row.definitionId)).toEqual([removedId, survivorId]);
        expect(initial.getCurrent().loadingMore).toBe(true);
        await admitted.promise;
        await initial.unmount();
        const deletion = deleteWorkflowDefinition({ definitionId: removedId });
        await vi.waitFor(() => expect(nativeAlert).toHaveBeenCalled());
        await confirmDeletion();
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
    it('beside the Workflows column asks which to open and never repeats the column list or its space header (R8-7)', async () => {
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
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:idle')).not.toBeNull());
        // The column beside this page is the one list and the one space header; main never draws a second copy.
        expect(screen.findHostByTestId(`workflows-home:row:${definitionId}`)).toBeNull();
        expect(screen.findHostByTestId('workflows-home:search')).toBeNull();
        expect(screen.findAllHostsByTestId('workflows-home-space-title-swipe')).toHaveLength(0);
        // One primary: New workflow opens the blank draft.
        await screen.pressByTestIdAsync('workflows-home:idle:new');
        expect(routerPush).toHaveBeenCalledWith('/workflows/new');
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
        expect(removedRow()).not.toBeNull();
        const scope = storage.getState().profileScope!;
        await act(async () => { publishHomeAccountChange(scope.serverId); });
        expect(listReads).toBe(2);
        if (unmounted) await screen.unmount();
        // The editor uses this same writer; no library-row removal callback runs.
        await act(async () => { await deleteWithConsent(removedId); });
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
        await confirmDeletion();
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
    it('keeps a deleting workflow busy until acknowledgement, then presents a deletion receipt', async () => {
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
        const menu = row().findByType(ContextMenu);
        await act(async () => { menu.props.onSelect('delete'); await Promise.resolve(); });
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete')).toEqual([]);
        expect(modals).toEqual([]); // This ordinary iOS confirmation belongs to native Alert.
        await confirmDeletion();
        await vi.waitFor(() => expect({
            confirmations: nativeAlert.mock.calls.length,
            deletions: execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete').length,
        }).toEqual({ confirmations: 1, deletions: 1 }));
        await deletionAdmitted;
        expect(row().props.busy).toBe(true);
        expect(menu.props.items?.find((item: { id: string }) => item.id === 'delete')?.destructive).toBe(true);
        expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).not.toBeNull();
        expect(row().findByType(ContextMenu).props.disabled).toBe(true);
        await act(async () => {
            deleted.add(ids[0]!);
            settleDelete({ ok: true, result: { definitionId: '10000000-0000-4000-8000-000000000001', deleted: true } });
            await Promise.resolve(); await Promise.resolve();
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        });
        // A prior completion must not masquerade as the next confirmed deletion's outcome.
        deletion = new Promise(resolve => { settleDelete = resolve; });
        await act(async () => { row(ids[1]).findByType(ContextMenu).props.onSelect('delete'); await Promise.resolve(); });
        await confirmDeletion();
        expect(row(ids[1]).props.busy).toBe(true);
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
        await act(async () => {
            deleted.add(ids[1]!);
            settleDelete({ ok: true, result: { definitionId: ids[1], deleted: true } });
        });
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        expect(nativeAlert).toHaveBeenCalledTimes(2);
    });
    it('shows one loading status rather than selectable placeholder workflows before the library is known', async () => {
        execute.mockImplementation(() => new Promise(() => {}));
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('workflows-home:loading')).not.toBeNull();
        expect(screen.findAll(node => node.props.accessibilityRole === 'checkbox')).toHaveLength(0);
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
        await act(async () => { row().findByType(ContextMenu).props.onSelect('delete'); });
        await confirmDeletion(false);
        await vi.waitFor(() => expect(screen.findAllByType(Collection)[0]!.props.selection.focusRequest).toEqual({ key: definitionId }));
        expect(row().props.busy).toBe(false);
        expect(execute.mock.calls.filter(call => call[0] === 'workflow.definition.delete')).toEqual([]);
        expect(nativeAlert).toHaveBeenCalledOnce();
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
        // A phone tab like the others: the Home line, Activity and the Settings avatar above its large title.
        expect(screen.findHostByTestId('main-tab-nav-row')).not.toBeNull();
        expect(screen.findHostByTestId('main-header-settings-avatar')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).not.toBeNull());
        // One overflow: the title bar carries no page-actions `⋯` of raw buttons beside the column's own.
        expect(screen.findHostByTestId('page-header-actions.trigger')).toBeNull();
        expect(screen.findHostByTestId('workflows-home:new')).toBeNull();
        // Q7/FIN naming: one New workflow entry retains each existing start as an option.
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
        expect(addMenu).toBeDefined();
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['new']);
        expect(addMenu.props.items[0].submenu.items.map((item: { id: string }) => item.id)).toEqual(['blank', 'trigger', 'agent', 'example', 'import']);
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
            // The page header keeps its title and purpose; Import, Create with an agent and New workflow are not stacked under it.
            expect(screen.findHostByTestId('workflows-home:new')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:import')).toBeNull();
            expect(screen.findHostByTestId('workflows-home:agent')).toBeNull();
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu');
            expect(addMenu?.props.items.map((item: { id: string }) => item.id)).toEqual(['new']);
            expect(addMenu?.props.items[0].submenu.items.map((item: { id: string }) => item.id)).toEqual(['blank', 'trigger', 'agent', 'example', 'import']);
        } finally {
            windowSize.width = 800;
        }
    });
    it('keeps the full library home, Runs switch and account triggers on a phone destination', async () => {
        const { AutomationDefinitionDetailSchema, AutomationDefinitionListResponseSchema,
            AutomationStoredWorkflowDefinitionRecipeV2Schema, validateWorkflowDefinition } = await import('@happier-dev/protocol');
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
        automationDefinitionResponse = async (url) => url.pathname === '/v3/automations'
            ? Response.json(list) : url.pathname === '/v3/automations/digest' ? Response.json(detail) : undefined;
        execute.mockImplementation(async (actionId: string) => {
            if (actionId === 'workflow.definition.list') return { ok: true, result: { definitions: [] } };
            if (actionId === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
            return { ok: false, errorCode: 'unexpected', error: 'unexpected' };
        });
        const screen = await renderScreen(<WorkflowsDestinationIndex />, { wrapper: Wrapper,
            // Native refs supply geometry; the real Popover owns placement and portal rendering.
            createNodeMock: () => ({ measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(40, 40, 120, 40) }),
        });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.findByTestId('workflows-home:firstVisit')).toBeNull();
        expect(screen.findByTestId('workflow-builtins:builtin:plan-with-a-panel')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:view:runs')).not.toBeNull();
        expect(screen.findByTestId('workflows-home:row:account-trigger:digest')).not.toBeNull();
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('workflows.triggers.summary.everyDayAt(time=9:00 AM)');
        });
        expect(screen.findByTestId('workflows-column:trigger:digest-switch')).toBeNull();
        await screen.pressByTestIdAsync('workflows-home:row:account-trigger:digest');
        await vi.waitFor(() => expect(screen.findByTestId('workflows-column-trigger-popover')).not.toBeNull());
        expect(screen.findByTestId('workflows-column:add')).toBeNull();
        await screen.pressByTestIdAsync('workflows-column:more');
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
        expect(screen.findByTestId('workflows-column:add:trigger')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:more:settings')).not.toBeNull();
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
        await reportCollectionLayout(screen, 'workflow-examples:cards');
        for (const example of WORKFLOW_STARTER_EXAMPLES_V1) {
            expect(screen.findByTestId(`workflow-examples:${example.key}:use`)).not.toBeNull();
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
        const { ContextMenu } = await import('@happier-dev/plugin-ui');
        expect(saved.findByType(ContextMenu).props.triggerIcon).toBe('more');
        // A built-in row is a quiet destination: its page holds Run now / Choose a session… (lab `nav-N1`).
        expect(screen.findAllHostsByTestId('workflow-builtins:builtin:plan-with-a-panel:run')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-builtins:builtin:plan-with-a-panel');
        expect(routerPush.mock.calls).toEqual([['/workflows/builtin%3Aplan-with-a-panel']]);
    });
});

describe('workflow library summaries and filter', () => {
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

    it('opens a phone-sized page on its name, then the switch, then the scope line with its spaces, then search (R8)', async () => {
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
            const ids: string[] = [];
            screen.tree.root.findAll((node) => {
                if (typeof node.type === 'string' && typeof node.props?.testID === 'string') ids.push(node.props.testID);
                return false;
            });
            const at = (id: string) => ids.findIndex((candidate) => candidate === id || candidate.startsWith(id));
            expect(at('workflows-column:header')).toBeGreaterThanOrEqual(0);
            expect(at('workflows-column:header')).toBeLessThan(at('workflows-column:view'));
            expect(at('workflows-column:view')).toBeLessThan(at('workflows-home-space-title'));
            // One name on the page: the home under the column does not head itself a second time.
            expect(screen.findHostByTestId('workflows-home:header')).toBeNull();
            // The strip shares the scope line; only the search takes a line of its own.
            const line = screen.findHostByTestId('workflows-home:scope-line');
            expect(line?.findAll((node) => typeof node.type === 'string' && String(node.props?.testID ?? '').startsWith('workflows-home-space-strip')).length).toBeGreaterThan(0);
            expect(line?.findAll((node) => node.props?.testID === 'workflows-home:search')).toHaveLength(0);
            // Actions sit on the name's line; the switch has its row to itself.
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            expect(screen.findAllByType(DropdownMenu).some((menu) => menu.props.testID === 'workflows-column:add:menu')).toBe(true);
            expect(screen.findHostByTestId('workflows-column:header')?.findAll((node) => node.props?.testID === 'workflows-column:add:menu').length).toBeGreaterThan(0);
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
        const { formatTriggerSetSummary } = await import('../triggers/formatTriggerSummary');
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
        await act(async () => { await deleteWithConsent('10000000-0000-4000-8000-000000000004'); });
        expect(await action.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { offeredViews: ['all'] } });
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).toBeNull();
    });

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
});
