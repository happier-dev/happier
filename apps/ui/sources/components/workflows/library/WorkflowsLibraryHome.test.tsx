import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WorkflowsLibraryHome } from './WorkflowsLibraryHome';
import { WorkflowsDestinationIndex } from './WorkflowsDestinationIndex';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { Modal } from '@/modal';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';

const execute = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const machineRpcAck = vi.hoisted(() => vi.fn());
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
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/workflows', router: { push: routerPush } }).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Native recycler is a system boundary; real Collection row rendering stays below it.
vi.mock('@legendapp/list/react-native', async (original) => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
let httpBoundary: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>> | null = null;
let automationDefinitionResponse: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | null = null;
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
let previous = storage.getState();
let previousAppliedSnapshot = getAppliedActiveServerSnapshot();
let previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
    previous = storage.getState();
    previousAppliedSnapshot = getAppliedActiveServerSnapshot();
    previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
    httpBoundary = await installWorkflowActionHttpBoundary({ fixtureResponse: (actionId, input) => execute(actionId, input),
        automationDefinitions: async (url, init) => automationDefinitionResponse?.(url, init) });
    const runtime = await import('@/sync/domains/server/serverRuntime');
    appliedSnapshot = runtime.getActiveServerSnapshot;
    const home = await runtime.upsertAndActivateServer({ serverUrl: 'http://listsum.test', name: 'Library' });
    publishAppliedActiveServerSnapshot(appliedSnapshot());
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ profileScope: { serverId: home.id, accountId: 'account-a' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { automations: true } },
        workflowRunListWindows: {}, workflowRunsById: {} });
    httpBoundary.prime();
});
afterEach(async () => {
    standardCleanup();
    (await import('./workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    execute.mockReset();
    machineRpcAck.mockReset();
    (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
    (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
    (await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs')).clearDaemonMergedProjectionCacheForTests();
    routerPush.mockClear();
    httpBoundary?.dispose();
    httpBoundary = null;
    automationDefinitionResponse = null;
    storage.setState(previous);
    publishAppliedActiveServerSnapshot(previousAppliedSnapshot, previousRuntimeAvailable);
});

describe('workflow library page anatomy', () => {
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
        await deleteWorkflowDefinition({ definitionId: removedId });
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
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
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
        await deleteWorkflowDefinition({ definitionId: removedId });
        expect(execute.mock.calls.map(call => call[0])).not.toContain('workflow.definition.list');
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        expect(screen.findHostByTestId('workflows-home:new')).not.toBeNull();
    });
    it.each([false, true])('applies a canonical delete outcome to the warm library while an older list is pending (unmounted=%s)', async (unmounted) => {
        const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
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
        await act(async () => { await deleteWorkflowDefinition({ definitionId: removedId }); });
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
        expect(row(ids[1]).props.busy).toBe(true);
        expect(screen.findHostByTestId('workflows-home:deleted')).toBeNull();
        await act(async () => {
            deleted.add(ids[1]!);
            settleDelete({ ok: true, result: { definitionId: ids[1], deleted: true } });
        });
        expect(screen.findHostByTestId('workflows-home:deleted')).not.toBeNull();
        expect(Modal.confirm).toHaveBeenCalled();
    });
    it('shows one loading status rather than selectable placeholder workflows before the library is known', async () => {
        execute.mockImplementation(() => new Promise(() => {}));
        const screen = await renderScreen(<WorkflowsLibraryHome />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('workflows-home:loading')).not.toBeNull();
        expect(screen.findAll(node => node.props.accessibilityRole === 'checkbox')).toHaveLength(0);
    });
    it('gives a phone one way to add (the column\'s "+" menu rows) and no second overflow in the title bar (DESIGN-9 N6)', async () => {
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
            pathname="/workflows" focused visible phone navigation={{ push: routerPush, replace: () => {}, back: () => {} }}>
            <WorkflowsDestinationIndex />
        </DestinationInstanceHost>, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.findHostByTestId('workspace-destination-header')).not.toBeNull();
        expect(screen.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000001')).not.toBeNull();
        // One overflow: the title bar carries no page-actions `⋯` of raw buttons beside the column's own.
        expect(screen.findHostByTestId('page-header-actions.trigger')).toBeNull();
        expect(screen.findHostByTestId('workflows-home:new')).toBeNull();
        // Creation is the column's "+" menu: the lab `nav-N1m` rows (title, subtitle, mark), New workflow first.
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const addMenu = screen.findAllByType(DropdownMenu).find((menu) => menu.props.testID === 'workflows-column:add:menu')!;
        expect(addMenu).toBeDefined();
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['new', 'agent', 'trigger', 'example', 'import']);
        expect(addMenu.props.items.every((item: { subtitle?: string; icon?: unknown }) => Boolean(item.subtitle) && item.icon !== undefined)).toBe(true);
        await act(async () => { addMenu.props.onSelect('new'); });
        expect(routerPush).toHaveBeenCalledWith('/workflows/new');
    });
    it('shares a Home wake refresh between mounted definition consumers', async () => {
        const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        function Consumer() { useWorkflowDefinitionLibrary(); return null; }
        execute.mockResolvedValue({ ok: true, result: { definitions: [] } });
        await renderScreen(<><Consumer /><Consumer /></>, { wrapper: Wrapper });
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list')).toHaveLength(1);
        execute.mockClear();
        await act(async () => { publishHomeAccountChange(appliedSnapshot().serverId); });
        // This boundary count measures duplicate network refreshes, not incidental internal calls.
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.definition.list')).toHaveLength(1);
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
        const screen = await renderScreen(<WorkflowsDestinationIndex />, { wrapper: Wrapper });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(screen.findByTestId('workflows-home:firstVisit')).not.toBeNull();
        expect(screen.findByTestId('workflow-builtins:builtin:plan-with-a-panel')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:view:runs')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:trigger:digest')).not.toBeNull();
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('workflows.triggers.summary.everyDayAt(time=9:00 AM)');
            expect(screen.getTextContent()).toContain('Morning digest');
        });
        expect(screen.findHostByTestId('workflows-column:trigger:digest-switch')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:add')).toBeNull();
        await screen.pressByTestIdAsync('workflows-column:more');
        await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
        expect(screen.findByTestId('workflows-column:add:trigger')).not.toBeNull();
        expect(screen.findByTestId('workflows-column:more:settings')).not.toBeNull();
        const { WORKFLOW_STARTER_EXAMPLES_V1 } = await import('@happier-dev/protocol/workflows/builtins/examples');
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
        expect(execute.mock.calls.filter(([actionId]) => actionId === 'workflow.run.list')).toHaveLength(1);
        expect(screen.findByTestId('workflows-home:firstVisit') !== null).toBe(!hasHistory);
        if (hasHistory) expect(screen.findByTestId('workflows-home:empty')).not.toBeNull();
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
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
        const { getBuiltinWorkflowCatalogV1 } = await import('@happier-dev/protocol');
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
        await screen.pressByTestIdAsync('workflow-builtins:builtin:plan-with-a-panel:run');
        expect(routerPush.mock.calls).toEqual([['/workflows/builtin%3Aplan-with-a-panel?intent=run']]);
    });
});

describe('workflow library summaries and filter', () => {
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
        expect(screen.tree.findHostByTestId('workflows-home:filter:triggered')).not.toBeNull();
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
        await screen.tree.pressByTestIdAsync('workflows-home:filter:triggered');
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000004')).not.toBeNull();
        await screen.tree.pressByTestIdAsync('workflows-home:filter:all');
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).not.toBeNull();
        await screen.tree.pressByTestIdAsync('workflows-home:filter:triggered');
        const { deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
        await act(async () => { await deleteWorkflowDefinition({ definitionId: '10000000-0000-4000-8000-000000000004' }); });
        expect(screen.tree.findHostByTestId('workflows-home:filter:triggered')).toBeNull();
        expect(screen.tree.findHostByTestId('workflows-home:row:10000000-0000-4000-8000-000000000003')).not.toBeNull();
    });
});
