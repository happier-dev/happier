import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { observeMachinePresenceForTest, publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
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
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { SessionTerminalWorkspaceView } from '@/components/sessions/terminal/strip/SessionTerminalWorkspaceView';
import { SessionTerminalPageView } from '@/components/sessions/panes/terminal/SessionTerminalPage';
import { useProjectRouteSurfaceSync } from '../useProjectRouteSurfaceSync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

// Machine RPC is the external boundary; operation validation, Actions, pane admission and rendering stay real.
const outputRpc = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ width: 1440 }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: outputRpc }));
// The person's confirmation is an external boundary; close admission and the Action remain real.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { confirm: async () => true },
}).module);

afterEach(() => { standardCleanup(); vi.useRealTimers(); outputRpc.mockReset(); viewport.width = 1440; });

async function invoke(input: Parameters<typeof invokeSessionTerminalAction>[0]) {
    const outcome: { result?: Awaited<ReturnType<typeof invokeSessionTerminalAction>> } = {};
    await act(async () => { outcome.result = await invokeSessionTerminalAction(input); });
    return outcome.result!;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: viewport.width, height: 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ Dimensions: { get: dimensions }, useWindowDimensions: dimensions });
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/projects/accepted/terminal',
}).module);
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

function serveCensusHome(serverId: string, refs: readonly WorkspaceRefV1[], machine?: ReturnType<typeof createMachineFixture>) {
    return serveActionHomes({ homes: [{ key: 'project', serverUrl: `https://${serverId}.test`, accountId: 'bob', serverIdentityId: serverId,
        settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'session.terminals.open': ['ui'] } } } }],
        route: request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
            ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: refs }))
            : request.path === '/v1/machines'
            ? Response.json([createPlainMachineRowFixture({ id: 'machine', accountId: 'bob', machine })])
            : request.path === '/v1/machines/read-batch' && request.method === 'POST'
            ? createMachineReadBatchResponseFixture(request.body, id => id === 'machine'
                ? createPlainMachineRowFixture({ id, accountId: 'bob', machine }) : null)
            : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
}

function RoutedProjectTerminal(props: Readonly<{ scopeId: string; workspace: WorkspaceAddressV1; workspaceRef: WorkspaceRefV1; phone: boolean }>) {
    const { dispatch } = useAppPaneContext();
    useProjectRouteSurfaceSync({ scopeId: props.scopeId, workspaceRef: props.workspaceRef, activeRootPath: props.workspace.rootPath,
        isFocused: true, surface: props.phone ? 'terminal' : 'overview' });
    React.useLayoutEffect(() => {
        if (!props.phone) dispatch({ type: 'openRight', scopeId: props.scopeId, tabId: 'terminal' });
    }, [dispatch, props.phone, props.scopeId]);
    return <ProjectTerminalSurface scopeId={props.scopeId} workspaceRefId={props.workspaceRef.id} workspace={props.workspace}
        machineId={props.workspace.machineId} serverId={props.workspace.serverId} rootPath={props.workspace.rootPath}
        presentation={props.phone ? 'page' : 'right'} />;
}

describe('Project terminal through the incumbent pane workspace', () => {
    it('discloses the actual Machine placement before opening a Project Shell', async () => {
        const serverId = 'srv_project_terminal_trust';
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const ref = { id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 };
        const home = await serveCensusHome(serverId, [ref]);
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: [ref] }));
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [workspace.machineId]);
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            outputRpc.mockResolvedValue({ ok: true, terminals: [], machineShell: { ok: true, cwd: workspace.rootPath } });
            screen = await renderScreen(<AppPaneProvider><RoutedProjectTerminal scopeId={scopeId} workspace={workspace} workspaceRef={ref} phone={false} /></AppPaneProvider>);
            await vi.waitFor(() => expect(screen!.findAllByType(SessionTerminalWorkspaceView)).toHaveLength(1));
            const base = storage.getState().machineListByServerId[serverId]?.find(machine => machine.id === workspace.machineId);
            expect(base).toBeDefined();
            for (const [agentIsolation, detailKey] of [
                [{ enabled: false }, 'machines.sharing.fallback.lead'],
                [{ enabled: true }, 'machines.sharing.trustedOsDetail'],
                [{ enabled: true, memberProvisioning: 'linuxUsersV1' }, 'machines.sharing.memberUsersDetail'],
            ] as const) {
                await act(async () => storage.getState().applyMachines([
                    { ...base!, metadata: { ...base!.metadata!, platform: 'linux', agentIsolation } },
                ], true, { sourceServerId: serverId }));
                const notice = screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.notice;
                expect.soft(notice.detail).toContain(t(detailKey, { machine: getMachineDisplayName(base!) ?? workspace.machineId }));
            }
        } finally { await screen?.unmount(); await home.dispose(); }
    });
    it.each(['running', 'missing'])('keeps desktop-created Shell Close, phone renderer and each New intent usable when the native Shell is %s', async nativeState => {
        vi.mocked(Modal.confirm).mockClear();
        const serverId = `srv_polish_controls_${nativeState}`;
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const ref = { id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 };
        const home = await serveCensusHome(serverId, [ref]);
        const native = new Map<string, string>();
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: [ref] }));
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [workspace.machineId]);
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            outputRpc.mockImplementation(async (request: { method: string; payload: { terminalId?: string } }) => {
                if (request.method === RPC_METHODS.DAEMON_TERMINAL_LIST) return { ok: true, terminals: [...native]
                    .map(([memberId, terminalId]) => ({ terminalId, terminalKey: buildProjectTerminalKey({ serverId, accountId: 'bob' }, workspace, memberId),
                        cwd: workspace.rootPath, ended: false, exit: null })), machineShell: { ok: true, cwd: workspace.rootPath } };
                if (request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE) {
                    for (const [id, terminalId] of native) if (terminalId === request.payload.terminalId) native.delete(id);
                    return { ok: true };
                }
                throw new Error(`Unexpected RPC ${request.method}`);
            });
            const tree = (phone: boolean) => <AppPaneProvider><RoutedProjectTerminal scopeId={scopeId} workspace={workspace} workspaceRef={ref} phone={phone} /></AppPaneProvider>;
            const screen = await renderScreen(tree(false));
            await vi.waitFor(() => expect(screen.findAllByType(SessionTerminalWorkspaceView)).toHaveLength(1));
            await act(async () => screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.onNewShell());
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1));
            const desktopId = readSessionTerminalWorkspaceForScope(scopeId)!.tabs[0]!.terminals[0]!.id;
            if (nativeState === 'running') native.set(desktopId, 'native-desktop-created');
            viewport.width = 390;
            await screen.update(tree(true));
            await vi.waitFor(() => expect(screen.findAllByType(SessionTerminalPageView)[0]?.props.renderTerminals).toBe(true));
            await vi.waitFor(() => expect(screen.findAllByType(WorkspaceEmbeddedTerminalPane).some(node => node.props.terminalInstanceId === desktopId)).toBe(true));
            await act(async () => screen.findAllByType(SessionTerminalPageView)[0]!.props.onAction('session.terminals.open', { target: { kind: 'workspace_shell' } }));
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(2));
            const phoneId = readSessionTerminalWorkspaceForScope(scopeId)!.activeTabId!;
            expect(phoneId).not.toBe(desktopId);
            await act(async () => screen.findAllByType(SessionTerminalPageView)[0]!.props.onAction('session.terminals.close_tab', { tabId: desktopId }));
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.map(tab => tab.id)).toEqual([phoneId]));
            expect(outputRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)
                .map(([request]) => request.payload)).toEqual(nativeState === 'running' ? [{ terminalId: 'native-desktop-created' }] : []);
            expect(Modal.confirm).toHaveBeenCalledTimes(nativeState === 'running' ? 1 : 0);
            viewport.width = 1440;
            await screen.update(tree(false));
            await act(async () => screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.onCloseTab(phoneId));
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(0));
            expect(outputRpc.mock.calls.every(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST
                || request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(true);
            await screen.unmount();
        } finally { await home.dispose(); }
    });

    it.each(['selecting a running Shell', 'creating a new Shell', 'closing a recovered tab'])('lists this Project\'s running Shells on the Machine and preserves their original members when %s', async intent => {
        const serverId = 'srv_pf56_recover';
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const sibling = { ...workspace, workspaceId: 'same-project-checkout', rootPath: '/accepted-sibling' };
        const otherProject = { ...workspace, workspaceId: 'other-project', rootPath: '/other-project' };
        const refs = [workspace, sibling, otherProject].map((address, index) => ({ id: address.workspaceId, serverId,
            machineId: address.machineId, rootPath: address.rootPath, projectKey: index === 2 ? 'other' : 'project', createdAtMs: 1 }));
        const home = await serveCensusHome(serverId, refs);
        const previous = storage.getState();
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: refs }));
            const machine = createMachineFixture({ id: workspace.machineId, activeAt: Date.now() });
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [machine.id]);
            const key = (accountId: string, memberId: string, checkout = workspace) => buildProjectTerminalKey({ serverId, accountId }, checkout, memberId);
            outputRpc.mockImplementation(async (request: { method: string; payload: { workspace?: { rootPath: string } } }) => {
                if (intent === 'closing a recovered tab' && request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE) return { ok: true };
                if (request.method !== RPC_METHODS.DAEMON_TERMINAL_LIST) throw new Error(`Unexpected RPC ${request.method}`);
                const terminals = [
                    { terminalId: 'native-desktop', terminalKey: key('bob', 'old-desktop'), cwd: workspace.rootPath, ended: false, exit: null },
                    { terminalId: 'native-ended', terminalKey: key('bob', 'ended'), cwd: workspace.rootPath, ended: true, exit: null },
                    { terminalId: 'native-other-account', terminalKey: key('alice', 'private'), cwd: workspace.rootPath, ended: false, exit: null },
                    { terminalId: 'native-sibling', terminalKey: key('bob', 'sibling-shell', sibling), cwd: sibling.rootPath, ended: false, exit: null },
                    { terminalId: 'native-other-project', terminalKey: key('bob', 'unrelated', otherProject), cwd: otherProject.rootPath, ended: false, exit: null },
                ];
                return { ok: true, terminals: request.payload.workspace
                    ? terminals.filter(terminal => terminal.cwd === request.payload.workspace?.rootPath) : terminals,
                    machineShell: { ok: true, cwd: workspace.rootPath } };
            });
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            const screen = await renderScreen(<AppPaneProvider><ActiveProjectPane scopeId={scopeId}><ProjectTerminalSurface
                scopeId={scopeId} workspaceRefId={workspace.workspaceId} machineId={workspace.machineId}
                rootPath={workspace.rootPath} serverId={serverId} workspace={workspace} /></ActiveProjectPane></AppPaneProvider>);
            await vi.waitFor(() => expect(screen.findByTestId('project-terminal-workspace-list-row-old-desktop'), JSON.stringify({
                rpc: outputRpc.mock.calls.map(([request]) => request.method), text: screen.getTextContent(),
                rows: readCurrentProjectAccountRows(storage.getState())?.status,
            })).not.toBeNull());
            expect(screen.findByTestId('project-terminal-workspace-list-row-sibling-shell')).not.toBeNull();
            expect(screen.findByTestId('project-terminal-workspace-list-row-ended')).toBeNull();
            expect(screen.findByTestId('project-terminal-workspace-list-row-private')).toBeNull();
            expect(screen.findByTestId('project-terminal-workspace-list-row-unrelated')).toBeNull();
            expect(readSessionTerminalWorkspaceForScope(scopeId, EMPTY_TERMINAL_WORKSPACE)?.tabs ?? []).toEqual([]);
            if (intent === 'closing a recovered tab') {
                await act(async () => screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.onCloseTab('sibling-shell'));
                await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId, EMPTY_TERMINAL_WORKSPACE)?.tabs
                    .flatMap(tab => tab.terminals.map(member => member.id))).toEqual(['old-desktop']));
                expect(readSessionTerminalWorkspaceForScope(scopeId)?.activeTabId).toBe('old-desktop');
                expect(outputRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)
                    .map(([request]) => request.payload)).toEqual([{ terminalId: 'native-sibling' }]);
            } else if (intent === 'creating a new Shell') {
                await act(async () => screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.onNewShell());
                await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs
                    .some(tab => tab.terminals.some(member => !['old-desktop', 'sibling-shell'].includes(member.id)))).toBe(true));
            } else {
                await act(async () => screen.findByTestId('project-terminal-workspace-list-row-sibling-shell')!.props.onPress());
            }
            const recovered = readSessionTerminalWorkspaceForScope(scopeId);
            const members = recovered?.tabs.flatMap(tab => tab.terminals);
            expect(members).toEqual(intent === 'closing a recovered tab' ? [
                expect.objectContaining({ id: 'old-desktop', target: { kind: 'workspace_shell', workspace } }),
            ] : expect.arrayContaining([
                expect.objectContaining({ id: 'old-desktop', target: { kind: 'workspace_shell', workspace } }),
                expect.objectContaining({ id: 'sibling-shell', target: { kind: 'workspace_shell', workspace: sibling } }),
            ]));
            expect(members).toHaveLength(intent === 'creating a new Shell' ? 3 : intent === 'closing a recovered tab' ? 1 : 2);
            const active = recovered?.tabs.find(tab => tab.id === recovered.activeTabId);
            if (intent === 'creating a new Shell') {
                expect(active?.terminals[0]).toMatchObject({ target: { kind: 'workspace_shell', workspace } });
                expect(['old-desktop', 'sibling-shell']).not.toContain(active?.focusedTerminalId);
                expect(active?.focusedTerminalId).toBe(active?.terminals[0]?.id);
            } else if (intent !== 'closing a recovered tab') {
                expect(recovered?.activeTabId).toBe('sibling-shell');
                expect(active?.focusedTerminalId).toBe('sibling-shell');
            }
            expect(outputRpc.mock.calls.every(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST
                || intent === 'closing a recovered tab' && request.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toBe(true);
            await screen.unmount();
        } finally { storage.setState(previous); await home.dispose(); }
    });

    it.each([
        ['refused', { ok: false, errorCode: 'terminal_forbidden', error: 'terminal_forbidden' }],
        ['malformed', { ok: true, terminals: [{ terminalId: 'invalid-without-key' }] }],
    ])('shows unavailable instead of ordinary empty after a %s running-Shell census', async (kind, response) => {
        const serverId = `srv_census_${kind}`;
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const refs = [{ id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }];
        const home = await serveCensusHome(serverId, refs);
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: refs }));
            const machine = createMachineFixture({ id: workspace.machineId, activeAt: Date.now() });
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [machine.id]);
            outputRpc.mockResolvedValue(response);
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            const screen = await renderScreen(<AppPaneProvider><ActiveProjectPane scopeId={scopeId}><ProjectTerminalSurface
                scopeId={scopeId} workspaceRefId={workspace.workspaceId} machineId={workspace.machineId}
                rootPath={workspace.rootPath} serverId={serverId} workspace={workspace} /></ActiveProjectPane></AppPaneProvider>);
            await vi.waitFor(() => expect(outputRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST)).toBe(true));
            await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'unavailable')).toBe(true));
            expect(readSessionTerminalWorkspaceForScope(scopeId, EMPTY_TERMINAL_WORKSPACE)?.tabs ?? []).toEqual([]);
            await screen.unmount();
        } finally { await home.dispose(); }
    });

    it.each(['pending', 'refused'])('does not offer New terminal while running-Shell discovery is %s', async kind => {
        const serverId = `srv_census_new_${kind}`;
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const refs = [{ id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }];
        const home = await serveCensusHome(serverId, refs);
        const census = createDeferred<{ ok: true; terminals: [] }>();
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: refs }));
            const machine = createMachineFixture({ id: workspace.machineId, activeAt: Date.now() });
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [machine.id]);
            outputRpc.mockImplementation(async () => kind === 'pending' ? census.promise
                : { ok: false, errorCode: 'terminal_forbidden', error: 'terminal_forbidden' });
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            const screen = await renderScreen(<AppPaneProvider><ActiveProjectPane scopeId={scopeId}><ProjectTerminalSurface
                scopeId={scopeId} workspaceRefId={workspace.workspaceId} machineId={workspace.machineId}
                rootPath={workspace.rootPath} serverId={serverId} workspace={workspace} /></ActiveProjectPane></AppPaneProvider>);
            await vi.waitFor(() => expect(outputRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST)).toBe(true));
            const expectedKind = kind === 'pending' ? 'loading' : 'unavailable';
            await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === expectedKind)).toBe(true));
            const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.kind === expectedKind)!;
            expect(card.props.action).toBeUndefined();
            expect(outputRpc.mock.calls.every(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST)).toBe(true);
            await screen.unmount();
        } finally { census.resolve({ ok: true, terminals: [] }); await home.dispose(); }
    });

    it.each([
        { kind: 'offline', active: false, response: { ok: false, errorCode: 'terminal_unavailable', error: 'offline' } },
        { kind: 'unsupported', active: true, response: { ok: true, terminals: [] } },
        { kind: 'refused', active: true, response: { ok: false, errorCode: 'terminal_forbidden', error: 'terminal_forbidden' } },
        { kind: 'cwd-denied', active: true, response: { ok: true, terminals: [], machineShell: { ok: false, errorCode: 'terminal_cwd_denied', error: 'terminal_cwd_denied' } } },
        { kind: 'online', active: true, response: { ok: true, terminals: [], machineShell: { ok: true, cwd: '/accepted' } } },
    ] as const)('uses typed Shell availability for an empty Project pane: $kind', async ({ kind, active, response }) => {
        const serverId = `srv_shell_state_${kind}`;
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const refs = [{ id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }];
        const machine = createMachineFixture({ id: workspace.machineId, active, activeAt: active ? Date.now() : 1 });
        const home = await serveCensusHome(serverId, refs, machine);
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs: refs }));
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
            publishMachineActivityForTest([machine]);
            observeMachinePresenceForTest({ serverId, accountId: 'bob' }, [machine.id]);
            outputRpc.mockResolvedValue(response);
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            const screen = await renderScreen(<AppPaneProvider><ActiveProjectPane scopeId={scopeId}><ProjectTerminalSurface
                scopeId={scopeId} workspaceRefId={workspace.workspaceId} machineId={workspace.machineId}
                rootPath={workspace.rootPath} serverId={serverId} workspace={workspace} /></ActiveProjectPane></AppPaneProvider>);
            await vi.waitFor(() => expect(outputRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST)).toBe(true));
            if (kind === 'online') {
                await vi.waitFor(() => expect(screen.findAllByType(SessionTerminalWorkspaceView)).toHaveLength(1));
                expect(screen.findAllByType(SessionTerminalWorkspaceView)[0]!.props.emptyAction).toBeTypeOf('function');
            } else {
                await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'unavailable')).toBe(true));
                const card = screen.findAllByType(SurfaceStateCard).find(node => node.props.kind === 'unavailable')!;
                expect(card.props.title).toBe(kind === 'offline'
                    ? t('terminalWorkspace.states.offline', { machine: getMachineDisplayName(machine) ?? workspace.machineId })
                    : kind === 'refused' ? t('machines.terminals.denied')
                    : kind === 'cwd-denied' ? t('terminalEmbedded.errors.cwdDenied')
                    : t('machines.terminals.unavailable'));
                if (kind === 'refused' || kind === 'cwd-denied') {
                    expect(card.props.diagnosticCode).toBe(kind === 'refused' ? 'terminal_forbidden' : 'terminal_cwd_denied');
                }
                expect(card.props.action).toBeUndefined();
            }
            await screen.unmount();
        } finally { await home.dispose(); }
    });

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
    it('keeps its rows, key rail and seated Find bar above a floating tab bar by the bar\'s measured height', async () => {
        const serverId = 'srv_project_terminal_clearance';
        const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
        const workspaceRefs = [{ id: workspace.workspaceId, serverId, machineId: workspace.machineId,
            rootPath: workspace.rootPath, projectKey: 'project', createdAtMs: 1 }];
        const home = await serveCensusHome(serverId, workspaceRefs);
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({ status: 'ready', workspaceRefs }));
            outputRpc.mockResolvedValue({ ok: true, terminals: [], machineShell: { ok: true, cwd: workspace.rootPath } });
            const scopeId = buildProjectPaneScopeId(workspace.workspaceId, serverId);
            // The bottom space the surface reserves under its terminal workspace: every ancestor's bottom padding.
            const reservedBelowTerminal = async (chromeHeight: number) => {
                await vi.waitFor(() => expect(home.requests.some(request => request.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`)).toBe(true));
                const screen = await renderScreen(<SessionCockpitBottomChromeHeightContext.Provider value={chromeHeight}>
                    <AppPaneProvider><ProjectTerminalSurface scopeId={scopeId} workspaceRefId={workspace.workspaceId}
                        machineId={workspace.machineId} rootPath={workspace.rootPath} serverId={serverId} workspace={workspace} /></AppPaneProvider>
                </SessionCockpitBottomChromeHeightContext.Provider>);
                await vi.waitFor(() => expect(screen.findByTestId('project-terminal-workspace-root'), screen.getTextContent()).not.toBeNull());
                let node = screen.findByTestId('project-terminal-workspace-root')?.parent ?? null;
                let reserved = 0;
                for (; node; node = node.parent) {
                    if (typeof node.type === 'string') reserved += Number(StyleSheet.flatten(node.props.style)?.paddingBottom ?? 0);
                }
                await screen.unmount();
                return reserved;
            };
            expect(await reservedBelowTerminal(84)).toBe(84);
            expect(await reservedBelowTerminal(0)).toBe(0);
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
        const home = await serveCensusHome(serverIdentityId, [ref, checkout]);
        let retireMeasurements: (() => void) | undefined;
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            expect(serverId).toBe(serverIdentityId);
            const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
            await vi.waitFor(() => expect(readCurrentProjectAccountRows(storage.getState())).toMatchObject({
                status: 'ready', workspaceRefs: [ref, checkout],
            }));
            outputRpc.mockResolvedValue({ ok: true, terminals: [], machineShell: { ok: true, cwd: workspace.rootPath } });
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
            await vi.waitFor(() => expect(screen.findByTestId('project-terminal-workspace-root'), JSON.stringify({
                content: screen.getTextContent(), profileScope: storage.getState().profileScope,
                rows: storage.getState().projectAccountRows,
                testIds: screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string').map(node => node.props.testID),
            })).not.toBeNull());
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
