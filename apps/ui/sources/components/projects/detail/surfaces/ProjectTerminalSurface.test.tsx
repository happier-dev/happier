import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { readSessionTerminalWorkspaceForScope, registerSessionTerminalSplitMeasurements, setSessionTerminalPendingActionApproval } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildProjectPaneScopeId } from '../projectPaneScope';
import { ProjectTerminalSurface } from './ProjectTerminalSurface';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { buildProjectTerminalKey } from '../projectTerminalScope';
import { buildProjectAccountRowPhysicalKeyV1, PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import { ProjectCommandOutputHost, useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { readVisibleSessionTerminalTabsForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

// Machine RPC is the external boundary; operation validation, Actions, pane admission and rendering stay real.
const outputRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: outputRpc }));

afterEach(() => { standardCleanup(); vi.useRealTimers(); outputRpc.mockReset(); });

async function invoke(input: Parameters<typeof invokeSessionTerminalAction>[0]) {
    const outcome: { result?: Awaited<ReturnType<typeof invokeSessionTerminalAction>> } = {};
    await act(async () => { outcome.result = await invokeSessionTerminalAction(input); });
    return outcome.result!;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative'); return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock();
});
// Xterm is the external renderer boundary. The real pane/controller remains mounted;
// no layout-ready event is emitted, so this presentation test does not request a PTY.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef((_props, _ref) => React.createElement('XtermBoundary')),
}));

function ActiveProjectPane(props: React.PropsWithChildren<{ scopeId: string }>) {
    const { dispatch } = useAppPaneContext();
    React.useEffect(() => { dispatch({ type: 'activateScope', scopeId: props.scopeId }); }, [dispatch, props.scopeId]);
    return <>{props.children}</>;
}

describe('Project terminal through the incumbent pane workspace', () => {
    it('docks actual worker output from a subdirectory and retains its checkout across hide/reopen', async () => {
        const serverId = 'srv_output_checkout';
        const source = { id: 'source-ref', serverId, machineId: 'source-machine', rootPath: '/source', projectKey: 'project', createdAtMs: 1 };
        const worker = { ...source, id: 'worker-ref', machineId: 'worker-machine', rootPath: '/worker' };
        const unrelated = { ...worker, id: 'other-project', projectKey: 'other', rootPath: '/other' };
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://output-checkout.test', accountId: 'bob', serverIdentityId: serverId }],
            route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [source, worker, unrelated] })) : undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({
                status: 'ready', workspaceRefs: [source, worker, unrelated],
            }));
            const scopeId = buildProjectPaneScopeId(source.id, serverId);
            const workspace = { serverId, workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath };
            const screen = await renderScreen(<AppPaneProvider><ActiveProjectPane scopeId={scopeId}><ProjectTerminalSurface scopeId={scopeId}
                workspaceRefId={source.id} machineId={source.machineId} rootPath={source.rootPath} serverId={serverId} workspace={workspace} /></ActiveProjectPane></AppPaneProvider>);
            const opener = await renderHook(useProjectCommandOutputOpener, { wrapper: ({ children }) =>
                <ProjectCommandOutputHost scopeId={scopeId}>{children}</ProjectCommandOutputHost> });
            const operation: ActionOperationProjection = { serverId, observation: 'available', isUnavailableProjection: false,
                snapshot: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'worker-run', revision: 1, actionId: 'projects.script.run', state: 'running',
                    scope: { accountId: 'bob', machineId: worker.machineId }, title: 'Check', createdAt: 1, startedAt: 1, cancellation: 'supported',
                    domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: worker.machineId,
                        workspaceRefId: worker.id, cwd: '/worker/packages/check', terminalId: 'worker-pty' } }) };
            let current = operation.snapshot;
            outputRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
                expect(request.method).toBe(ACTION_OPERATION_RPC_METHODS_V2.get);
                expect(request.payload).toEqual({ operationId: operation.snapshot.operationId });
                return { kind: 'found', operation: current };
            });
            const staleOperation = { ...operation, snapshot: { ...operation.snapshot,
                domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId, machineId: source.machineId,
                    workspaceRefId: source.id, cwd: source.rootPath, terminalId: 'source-pty' } } };
            let opened = false;
            await act(async () => { opened = await opener.getCurrent().open(staleOperation, { title: 'Check', fallbackToDetail: false }); });
            expect(opened, JSON.stringify({ opensInTerminal: opener.getCurrent().opensInTerminal,
                rpc: outputRpc.mock.calls.map(([request]) => ({ method: request.method, machineId: request.machineId })),
                profileScope: storage.getState().profileScope,
                rowsStatus: storage.getState().projectAccountRows?.status,
                paths: home.requests.map(request => request.path),
            })).toBe(true);
            const output = screen.findAllByType(WorkspaceEmbeddedTerminalPane).find(node => node.props.attachedTerminalId === 'worker-pty');
            expect(output?.props).toMatchObject({ machineId: worker.machineId, workspaceRefId: worker.id,
                rootPath: '/worker/packages/check', workspace: { serverId, workspaceId: worker.id, machineId: worker.machineId, rootPath: worker.rootPath } });
            const tabs = readVisibleSessionTerminalTabsForScope(scopeId);
            expect(tabs).toHaveLength(1);
            const outputMember = tabs[0]!.terminals[0]!;
            expect(await invoke({ actionId: 'session.terminals.open_in_details', input: { scopeId, terminalId: outputMember.id } })).toMatchObject({ ok: true });
            expect(readVisibleSessionTerminalTabsForScope(scopeId)).toEqual([]);
            await act(async () => { opened = await opener.getCurrent().open(operation, { title: 'Check', fallbackToDetail: false }); });
            expect(opened).toBe(true);
            expect(readVisibleSessionTerminalTabsForScope(scopeId)[0]?.terminals[0]?.id).toBe(outputMember.id);
            const wrongProject = { ...operation, snapshot: { ...operation.snapshot,
                domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const,
                    serverId, machineId: worker.machineId, workspaceRefId: unrelated.id, cwd: unrelated.rootPath, terminalId: 'unrelated-pty' } } };
            current = wrongProject.snapshot;
            await act(async () => { opened = await opener.getCurrent().open(wrongProject, { title: 'Other', fallbackToDetail: false }); });
            expect(opened).toBe(false);
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1);
            await opener.unmount();
            await screen.unmount();
        } finally { await home.dispose(); }
    });
    it('uses pushed Machine presence and keeps its admitted terminal identity across disconnect/reconnect', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminal-expiry.test', accountId: 'bob' }],
            route: () => undefined });
        const previous = storage.getState();
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...workspace, id: workspace.workspaceId, createdAtMs: 1 }] });
            const machine = createMachineFixture({ id: workspace.machineId, activeAt: Date.now() });
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [machine.id]);
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            const screen = await renderScreen(<AppPaneProvider><WorkspaceEmbeddedTerminalPane scopeId="expiry-terminal"
                machineId={machine.id} serverId={serverId} rootPath={workspace.rootPath} workspace={workspace}
                attachedTerminalId={null} terminalKey="expiry-terminal" /></AppPaneProvider>);
            expect(screen.findByType(EmbeddedTerminalPane).props.controller.status).toBe('connecting');
            await act(async () => { vi.advanceTimersByTime(60_001); });
            expect(screen.findByType(EmbeddedTerminalPane).props.controller.status).toBe('connecting');
            await act(async () => { storage.getState().applyMachines([
                { ...machine, active: false, activeAt: Date.now() },
            ], false, { sourceServerId: serverId, sourceAccountId: 'bob' }); });
            expect(screen.findByType(EmbeddedTerminalPane).props.controller).toMatchObject({ status: 'error', error: 'terminal_machine_unreachable' });
            expect(screen.findByType(EmbeddedTerminalPane).props.nativeSurfaceKey).toBe('expiry-terminal');
            await act(async () => { storage.getState().applyMachines([
                { ...machine, active: true, activeAt: Date.now() + 1 },
            ], false, { sourceServerId: serverId, sourceAccountId: 'bob' }); });
            expect(screen.findByType(EmbeddedTerminalPane).props.controller.status).toBe('connecting');
            await screen.unmount();
        } finally { vi.useRealTimers(); storage.setState(previous); await home.dispose(); }
    });

    it('opens an admitted shell without a Session, then preserves labels, split identity and borrowed-view close', async () => {
        const serverIdentityId = 'srv_project_terminal_pane';
        const ref = { id: 'accepted', serverId: serverIdentityId, machineId: 'machine', rootPath: '/accepted', projectKey: 'project', createdAtMs: 1 };
        const checkout = { ...ref, id: 'selected-checkout', rootPath: '/accepted-worktree' };
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminal-pane.test', accountId: 'bob', serverIdentityId, settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'session.terminals.open': ['ui'] } },
        } }], route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [ref, checkout] })) : undefined });
        let retireMeasurements: (() => void) | undefined;
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            expect(serverId).toBe(serverIdentityId);
            const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({
                status: 'ready', workspaceRefs: [ref, checkout],
            }));
            const scopeId = buildProjectPaneScopeId(ref.id, serverId);
            const sessions = storage.getState().sessions;
            const screen = await renderScreen(<AppPaneProvider><ProjectTerminalSurface scopeId={scopeId}
                workspaceRefId={ref.id} machineId={ref.machineId} rootPath={ref.rootPath} serverId={serverId} /></AppPaneProvider>);
            // Even registered base-root props cannot replace a missing accepted checkout address.
            expect(screen.findByTestId('project-terminal-workspace-root')).toBeNull();
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs ?? []).toEqual([]);
            await screen.update(<AppPaneProvider><ProjectTerminalSurface scopeId={scopeId}
                workspaceRefId={ref.id} machineId={ref.machineId} rootPath={ref.rootPath} serverId={serverId}
                workspace={workspace} /></AppPaneProvider>);
            expect(screen.findByTestId('project-terminal-workspace-root'), JSON.stringify({
                content: screen.getTextContent(), profileScope: storage.getState().profileScope,
                rows: storage.getState().projectAccountRows,
                testIds: screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string').map(node => node.props.testID),
            })).not.toBeNull();
            await screen.pressByTestIdAsync('project-terminal-workspace-strip-new');
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1));
            // The genuine UI intent remains lazy until the renderer is ready;
            // it must not be mistaken for an external caller needing admission now.
            expect(home.requests.filter(request => request.path === '/v1/artifacts' && request.method === 'POST')).toEqual([]);
            const original = readSessionTerminalWorkspaceForScope(scopeId)!.tabs[0].terminals[0];
            expect(original.target).toMatchObject({ kind: 'workspace_shell', workspace });
            expect(storage.getState().sessions).toBe(sessions);
            const pendingActionApproval = { scope: { serverId, accountId: 'bob' }, artifactId: 'approval-own-open', actionId: 'machines.terminal.open' as const };
            act(() => { expect(setSessionTerminalPendingActionApproval(scopeId, original.id, pendingActionApproval)).toBe(true); });
            expect(await invoke({ actionId: 'session.terminals.rename', input: { scopeId, terminalId: original.id, title: 'Build shell' } })).toMatchObject({ ok: true });
            retireMeasurements = registerSessionTerminalSplitMeasurements(scopeId, () => ({ availableWidthPx: 1000, minimumTerminalWidthPx: 320 }));
            const split = await invoke({ actionId: 'session.terminals.split', input: { scopeId,
                target: { kind: 'terminal_view', machineId: ref.machineId, terminalId: 'task-pty', terminalKey: 'task-output', cwd: ref.rootPath } } });
            expect(split).toMatchObject({ ok: true });
            if (!('terminalId' in split) || !split.terminalId) throw new Error('Expected borrowed view');
            expect(await invoke({ actionId: 'session.terminals.detach', input: { scopeId, terminalId: original.id } })).toMatchObject({ ok: true });
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.flatMap(tab => tab.terminals).find(member => member.id === original.id))
                .toMatchObject({ title: 'Build shell', target: { workspace }, pendingActionApproval });
            act(() => { expect(setSessionTerminalPendingActionApproval(scopeId, original.id, null)).toBe(true); });
            expect(await invoke({ actionId: 'session.terminals.close', input: { scopeId, terminalId: split.terminalId } })).toMatchObject({ ok: true });
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.flatMap(tab => tab.terminals).map(member => member.id)).toEqual([original.id]);
            expect(home.requests.filter(request => request.path.includes('/rpc'))).toEqual([]);
            const key = buildProjectTerminalKey({ serverId, accountId: 'bob' }, workspace, original.id);
            replaceTerminalSurfaceState(key, { ...createEmptyTerminalSurfaceState(), terminalId: 'private-pty', output: 'private output' });
            act(() => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [], revisionsByPhysicalKey: {
                [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id: checkout.id })]: 1,
                [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id: ref.id })]: 1,
            } }); });
            await vi.waitFor(() => expect(screen.findByTestId('project-terminal-workspace-root')).toBeNull());
            expect(readTerminalSurfaceState(key)?.output).toBe('');
            await screen.unmount();
        } finally { retireMeasurements?.(); await home.dispose(); }
    });
});
