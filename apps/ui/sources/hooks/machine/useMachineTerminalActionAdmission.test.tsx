import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { storage } from '@/sync/domains/state/storage';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { useMachineTerminalActionAdmission } from './useMachineTerminalActionAdmission';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { useMachineTerminalSession } from './useMachineTerminalSession';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EmbeddedTerminalPaneFrame } from '@/components/terminal/embedded/EmbeddedTerminalPaneFrame';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveSessionTerminalIdentity } from '@/components/sessions/terminal/sessionTerminalMode';
import { initializeSessionTerminalWorkspaceForScope, readSessionTerminalWorkspaceForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { SessionTerminalWorkspaceV1Schema } from '@happier-dev/protocol/terminal/workspace';
import { SessionBottomPanel } from '@/components/sessions/panes/bottom/SessionBottomPanel';
import { SessionTerminalPage } from '@/components/sessions/panes/terminal/SessionTerminalPage';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox, replayApprovedAsDaemon } from '@/dev/testkit/harness/approvalInbox';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

// The Home answers Machine list and batched row reads for the one Machine Bob owns.
function serveBobMachine(request: Readonly<{ path: string; method: string; body?: unknown }>): Response | undefined {
    const machine = createPlainMachineRowFixture({ id: 'machine', accountId: 'bob' });
    if (request.path === '/v1/machines') return Response.json([machine]);
    if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
        return createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? machine : null);
    }
    return undefined;
}

async function serveTerminalApprovalHome(serverUrl: string) {
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'bob', encryptionMode: 'plain' });
    const home = await serveActionHomes({ homes: [{ key: 'session', serverUrl, accountId: 'bob', currentAccount: true,
        settings: { actionsSettingsV1: { v: 1, actions: { 'machines.terminal.open': { approvalRequiredSurfaces: ['ui'] } } } } }],
        route: request => artifacts.handle(`${request.path}${request.url.search}`, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
            ?? serveBobMachine(request) });
    return { ...home, artifacts, async decline(count = 1) {
        await vi.waitFor(() => expect(artifacts.list()).toHaveLength(count));
        const result = await decideApprovalAsInbox(home.homes.session!.id, artifacts.list()[count - 1]!.id, 'cancel');
        expect(result.ok).toBe(true);
    } };
}

const viewport = vi.hoisted(() => ({ width: 1440, height: 940, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'web' }, useWindowDimensions: () => viewport,
}));
// xterm is the DOM renderer boundary; both real terminal leaves, controller,
// AppPane member, Action executor and human confirmation remain composed.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle, { onReady(cols: number, rows: number): void }>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ write: () => {}, clear: () => {},
            hasSelection: () => false, getSelectionText: () => '' }), []);
        React.useEffect(() => { props.onReady(80, 24); }, []);
        return React.createElement('xterm-boundary');
    }),
}));

// The confirmation dialog is the human-input boundary; the real Action policy
// and executor below it decide what declining means.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);

// The encrypted Machine RPC transport is the external daemon boundary; Actions,
// policy, Account currentness, request schemas and admission stay real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

describe('Project terminal admission through canonical Machine Actions', () => {
    it('does not connect while an Ask-first shell is awaiting consent', async () => {
        const home = await serveTerminalApprovalHome('https://terminal-consent.test');
        const acknowledgement = createDeferred<void>();
        home.artifacts.afterNextCreate(() => acknowledgement.promise);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        rpc.mockReset();
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
        const hook = await renderHook(() => useMachineTerminalSession({ terminalKey: 'consent-shell',
            serverId: home.homes.session!.id, machineId: 'machine', cwd: '/tmp', terminalRef }));
        try {
            await act(async () => hook.getCurrent().onReady(80, 24));
            await vi.waitFor(() => expect(home.artifacts.list()).toHaveLength(1));
            expect(hook.getCurrent().status).toBe('not-open');
            acknowledgement.resolve();
            await vi.waitFor(() => expect(hook.getCurrent().approvalPending).toBe(true));
            expect(hook.getCurrent().status).toBe('not-open');
            expect(rpc).not.toHaveBeenCalled();
            await home.decline();
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('not-open'));
        } finally { acknowledgement.resolve(); await hook.unmount(); await home.dispose(); }
    });
    it('opens an explicitly requested machine shell directly with default settings', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'session', serverUrl: 'https://terminal-direct.test', accountId: 'bob', currentAccount: true }],
            route: serveBobMachine });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            rpc.mockReset(); rpc.mockResolvedValue({ ok: true, terminalId: 'direct-shell', reused: false });
            vi.mocked(Modal.confirm).mockClear();
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: 'direct-shell',
                serverId: home.homes.session!.id, machineId: 'machine' }));
            try {
                const result = await hook.getCurrent().admit({ terminalKey: 'direct-shell', cwd: '/tmp' }, false, new AbortController().signal);
                expect(result).toMatchObject({ ok: true, terminalId: 'direct-shell' });
                expect(Modal.confirm).not.toHaveBeenCalled();
            } finally { await hook.unmount(); }
        } finally { await home.dispose(); }
    });
    it.each([false, true])('retains the daemon Project refusal through the real New terminal request and Details (approval: %s)', async (requiresApproval) => {
        const serverUrl = `https://terminal-project-refusal-${requiresApproval}.test`;
        const serverIdentityId = `srv_terminal_refusal_${requiresApproval}`;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'bob', encryptionMode: 'plain' });
        const home = await serveActionHomes({ homes: [{ key: 'session', serverUrl, serverIdentityId, accountId: 'bob', currentAccount: true,
            ...(requiresApproval ? { settings: { actionsSettingsV1: { v: 1, actions: {
                'machines.terminal.open': { approvalRequiredSurfaces: ['ui'] },
            } } } } : {}) }],
            route: request => artifacts.handle(`${request.path}${request.url.search}`, { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) })
                ?? serveBobMachine(request) ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const workspace = { serverId: home.homes.session!.id, workspaceId: 'accepted', machineId: 'machine', rootPath: '/project' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: workspace.workspaceId, serverId: workspace.serverId,
            machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }] });
        rpc.mockReset(); rpc.mockResolvedValue({ ok: false, errorCode: 'terminal_invalid_request', error: 'project_setup_consent_required' });
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
        const hook = await renderHook(() => useMachineTerminalSession({ terminalKey: 'new-project-shell', workspace,
            machineId: workspace.machineId, serverId: workspace.serverId, cwd: workspace.rootPath, terminalRef }));
        try {
            await act(async () => hook.getCurrent().onReady(80, 24));
            if (requiresApproval) {
                await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
                await replayApprovedAsDaemon({ serverId: workspace.serverId, machineId: workspace.machineId,
                    artifactId: artifacts.list()[0]!.id, decision: 'approve' });
            }
            await vi.waitFor(() => expect(rpc.mock.calls, JSON.stringify({ status: hook.getCurrent().status,
                error: hook.getCurrent().error })).toHaveLength(1));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', error: 'project_setup_consent_required' }));
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
                payload: { terminalKey: 'new-project-shell', workspace, cwd: workspace.rootPath, cols: 80, rows: 24 } }));
            const frame = await renderScreen(<EmbeddedTerminalPaneFrame title="Shell" controller={hook.getCurrent()}
                surface={null} chrome="toolbar" testIdPrefix="project-refusal" />);
            try {
                expect(frame.findByType(SurfaceStateCard).props).toMatchObject({
                    reason: t('terminalEmbedded.errors.projectSetupConsentRequired'),
                    diagnosticCode: 'project_setup_consent_required',
                });
            } finally { await frame.unmount(); }
        } finally { await hook.unmount(); await home.dispose(); }
    });
    it.each([false, true])('preserves one declined Open through real responsive leaves (phone-first: %s)', async (phoneFirst) => {
        const home = await serveTerminalApprovalHome(`https://terminal-responsive-cancel-${phoneFirst}.test`);
        const serverId = home.homes.session!.id;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const sessionId = `responsive-session-${phoneFirst}`;
        const scopeId = createSessionPaneScopeId(sessionId, serverId);
        const member = { id: `responsive-cancelled-member-${phoneFirst}`, target: { kind: 'machine_shell' as const, machineId: 'machine', cwd: '/tmp' } };
        const workspace = SessionTerminalWorkspaceV1Schema.parse({ v: 1, tabs: [{ id: member.id, terminals: [member],
            focusedTerminalId: member.id, root: { kind: 'leaf', terminalId: member.id } }], activeTabId: member.id, showList: false });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', active: true, activeAt: Date.now() })]);
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId })]);
        function ResponsiveTerminal() {
            const pane = useAppPaneScope(scopeId);
            React.useEffect(() => {
                initializeSessionTerminalWorkspaceForScope(scopeId, workspace);
                pane.openBottom({ tabId: 'terminal' });
            }, []);
            if (phoneFirst) return <>
                <SessionTerminalPage sessionId={sessionId} scopeId={scopeId} testIdPrefix="responsive-phone" />
                <SessionBottomPanel sessionId={sessionId} scopeId={scopeId} />
            </>;
            return viewport.width === 390
                ? <SessionTerminalPage sessionId={sessionId} scopeId={scopeId} testIdPrefix="responsive-phone" />
                : <SessionBottomPanel sessionId={sessionId} scopeId={scopeId} />;
        }
        rpc.mockReset(); rpc.mockResolvedValue({ ok: true, terminals: [] });
        vi.mocked(Modal.confirm).mockClear();
        viewport.width = phoneFirst ? 390 : 1440;
        const body = () => <AppPaneProvider><ResponsiveTerminal /></AppPaneProvider>;
        const screen = await renderScreen(body());
        try {
            // Native layout is the measurement boundary for the real desktop SplitCanvasHost.
            const measure = async () => {
                await act(async () => {
                    for (const host of screen.findAllHostsByTestId('split-canvas-host')) host.props.onLayout({
                        nativeEvent: { layout: { x: 0, y: 0, width: viewport.width, height: 400 } },
                    });
                    // react-test-renderer has no DOM measurements. Deliver the
                    // renderer's real readiness event to both mounted leaves.
                    for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) frame.props.controller.onReady(80, 24);
                });
                await flushHookEffects({ cycles: 4, turns: 2 });
            };
            await measure();
            await vi.waitFor(async () => {
                await measure();
                expect(home.artifacts.list().length,
                    JSON.stringify(screen.findAllByType(EmbeddedTerminalPaneFrame).map(frame => ({
                        status: frame.props.controller.status, error: frame.props.controller.error,
                    })))).toBeGreaterThan(0);
            });
            await measure();
            expect(screen.findAllByType(EmbeddedTerminalPaneFrame)).toHaveLength(phoneFirst ? 2 : 1);
            expect(home.artifacts.list()).toHaveLength(1);
            for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) {
                expect(frame.props.controller.status).not.toBe('connecting');
            }
            await home.decline();
            const expectNotOpen = async () => vi.waitFor(() => {
                const frames = screen.findAllByType(EmbeddedTerminalPaneFrame);
                expect(frames).toHaveLength(phoneFirst ? 2 : 1);
                for (const frame of frames) expect(frame.props.controller.status).toBe('not-open');
            });
            await expectNotOpen();
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0]?.terminals[0]?.openCancelled).toBe(true);
            for (const width of [390, 1440]) {
                viewport.width = width;
                await screen.update(body());
                await measure();
                await expectNotOpen();
                expect(home.artifacts.list()).toHaveLength(1);
            }
            await act(async () => {
                for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) frame.props.controller.retryConnect();
            });
            await home.decline(2);
            await measure();
            expect(home.artifacts.list()).toHaveLength(2);
            await expectNotOpen();
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
        } finally {
            vi.mocked(Modal.confirm).mockResolvedValue(false);
            viewport.width = 1440; await screen.unmount(); await home.dispose();
        }
    });
    it('returns a cancelled outcome when the person declines opening a shell, without issuing a process', async () => {
        const home = await serveTerminalApprovalHome('https://terminal-declined.test');
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            rpc.mockReset();
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: 'declined-shell',
                serverId: home.homes.session!.id, machineId: 'machine' }));
            try {
                const waiting = hook.getCurrent().admit({ terminalKey: 'declined-shell', cwd: '/tmp' }, false, new AbortController().signal);
                await home.decline();
                const result = await waiting;
                expect(result).toMatchObject({ ok: false, cancelled: true });
                expect(rpc).not.toHaveBeenCalled();
            } finally { await hook.unmount(); }
        } finally { await home.dispose(); }
    });
    it('keeps a declined shell not open and offers Open through the real terminal controller and frame', async () => {
        const home = await serveTerminalApprovalHome('https://terminal-declined-frame.test');
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            rpc.mockReset();
            const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
            vi.mocked(Modal.confirm).mockClear();
            const hook = await renderHook(() => useMachineTerminalSession({ terminalKey: 'declined-frame',
                machineId: 'machine', serverId: home.homes.session!.id, cwd: '/tmp', terminalRef }));
            try {
                await act(async () => hook.getCurrent().onReady(80, 24));
                await home.decline();
                await vi.waitFor(() => expect(hook.getCurrent().status).not.toBe('connecting'));
                expect(hook.getCurrent()).toMatchObject({ status: 'not-open', error: null, terminalId: null });
                const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
                    title: 'Shell', controller: hook.getCurrent(), surface: null, testIdPrefix: 'declined', chrome: 'none',
                }));
                expect(screen.findByType(SurfaceStateCard).props).toMatchObject({ kind: 'empty',
                    action: { label: t('common.open'), onPress: hook.getCurrent().retryConnect },
                });
                expect(home.artifacts.list()).toHaveLength(1);
                await act(async () => screen.findByType(SurfaceStateCard).props.action.onPress());
                await home.decline(2);
                await vi.waitFor(() => expect(hook.getCurrent().status).toBe('not-open'));
                expect(rpc).not.toHaveBeenCalled();
                await screen.unmount();
            } finally { await hook.unmount(); }
        } finally { await home.dispose(); }
    });
    it('keeps a declined member not open across leaf remounts until its Open action is pressed', async () => {
        const home = await serveTerminalApprovalHome('https://terminal-member-cancel.test');
        const host = await renderScreen(<AppPaneProvider>{null}</AppPaneProvider>);
        let leaf: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useMachineTerminalSession>>>> | undefined;
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.session!.id;
            const scopeId = createSessionPaneScopeId('session', serverId);
            const member = { id: 'cancelled-member', target: { kind: 'machine_shell' as const, machineId: 'machine', cwd: '/tmp' } };
            const workspace = SessionTerminalWorkspaceV1Schema.parse({ v: 1, tabs: [{ id: member.id, terminals: [member],
                focusedTerminalId: member.id, root: { kind: 'leaf', terminalId: member.id } }], activeTabId: member.id, showList: false });
            await act(async () => { expect(initializeSessionTerminalWorkspaceForScope(scopeId, workspace)).toBe(true); });
            const terminalKey = resolveSessionTerminalIdentity({ sessionId: 'session', scopeId, terminal: member }).terminalKey;
            rpc.mockReset(); rpc.mockResolvedValue({ ok: true, terminals: [] });
            vi.mocked(Modal.confirm).mockClear();
            const mountLeaf = async () => {
                const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
                const mounted = await renderHook(() => useMachineTerminalSession({ terminalKey, scopeId, memberId: member.id,
                    machineId: 'machine', serverId, sessionId: 'session', cwd: '/tmp', terminalRef }));
                await act(async () => mounted.getCurrent().onReady(80, 24));
                if (!readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0]?.terminals[0]?.openCancelled) await home.decline();
                await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0]?.terminals[0]?.openCancelled).toBe(true));
                await vi.waitFor(() => expect(mounted.getCurrent().status).toBe('not-open'));
                return mounted;
            };
            leaf = await mountLeaf();
            expect(home.artifacts.list()).toHaveLength(1);
            // The AppPane member outlives both responsive leaf replacements.
            // Round-trip the real stored reader as well as preserving the mounted owner.
            const retained = readSessionTerminalWorkspaceForScope(scopeId)!;
            expect(readSessionTerminalWorkspace(JSON.parse(JSON.stringify(retained)))).toEqual(retained);
            SessionTerminalWorkspaceV1Schema.parse(retained);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const { SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS } = await import('@happier-dev/protocol/actions/sessionTerminalActionFamily');
            const listed = await createDefaultActionExecutor().execute('session.terminals.list', { scopeId }, { surface: 'ui', serverId });
            expect(listed.ok).toBe(true);
            if (!listed.ok) throw new Error('Expected the retained member through the real list Action');
            expect(SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS['session.terminals.list'].parse(listed.result))
                .toMatchObject({ ok: true, workspace: { tabs: [{ terminals: [{ id: member.id, openCancelled: true }] }] } });
            for (const chrome of ['none', 'toolbar'] as const) {
                await leaf.unmount();
                leaf = await mountLeaf();
                const frame = await renderScreen(<EmbeddedTerminalPaneFrame title="Shell" controller={leaf.getCurrent()}
                    surface={null} chrome={chrome} testIdPrefix="cancelled-member" />);
                expect(frame.findByType(SurfaceStateCard).props).toMatchObject({ kind: 'empty', action: { label: t('common.open') } });
                expect(home.artifacts.list()).toHaveLength(1);
                await frame.unmount();
            }
            await act(async () => leaf!.getCurrent().retryConnect());
            await home.decline(2);
            await vi.waitFor(() => expect(leaf!.getCurrent().status).toBe('not-open'));
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
        } finally { await leaf?.unmount(); await host.unmount(); await home.dispose(); }
    });
    it('requires the same Machine Action admission for a Session package-script process', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'session', serverUrl: 'https://session-terminal-admission.test', accountId: 'bob',
            settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } } } }],
            route: serveBobMachine });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            rpc.mockReset(); rpc.mockResolvedValue({ ok: true, terminalId: 'script-pty', reused: false });
            const serverId = home.homes.session!.id;
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: 'session-script', serverId, machineId: 'machine' }));
            const launch = { kind: 'package_script' as const, runTargetId: 'dev-target' };
            const result = await hook.getCurrent().admit({ terminalKey: 'session-script', cwd: '/session', launch, sessionId: 'session' }, false, new AbortController().signal);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, terminalId: 'script-pty' });
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
                payload: expect.objectContaining({ launch, sessionId: 'session', terminalKey: 'session-script' }) }));
            await hook.unmount();
        } finally { await home.dispose(); }
    });
    it('clears active requester bytes and stops attachment when the applied Home retires', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminal-retire.test', accountId: 'bob' }], route: () => undefined });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const workspace = { serverId: home.homes.project!.id, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
            const terminalKey = 'bob-private-terminal';
            replaceTerminalSurfaceState(terminalKey, { ...createEmptyTerminalSurfaceState(), terminalId: 'pty', output: 'private requester output' });
            const read = createDeferred<unknown>();
            rpc.mockReset(); rpc.mockImplementation(() => read.promise);
            const renderer = { write: vi.fn(), clear: vi.fn() };
            const terminalRef = { current: renderer };
            const hook = await renderHook(() => useMachineTerminalSession({ terminalKey, workspace,
                machineId: workspace.machineId, serverId: workspace.serverId, cwd: workspace.rootPath,
                attachedTerminalId: 'pty', readOnly: true, terminalRef }));
            expect(readTerminalSurfaceState(terminalKey)?.output).toBe('private requester output');
            await act(async () => { storage.getState().activateProfileScope({ serverId: workspace.serverId, accountId: 'cara' }); });
            await vi.waitFor(() => expect(readTerminalSurfaceState(terminalKey)?.output).toBe(''));
            expect(hook.getCurrent()).toMatchObject({ status: 'error', error: 'terminal_forbidden' });
            expect(renderer.clear).toHaveBeenCalled();
            read.resolve({ ok: false, errorCode: 'terminal_forbidden', error: 'Denied' });
            await hook.unmount();
        } finally { await home.dispose(); }
    });
    it('opens one admitted requester shell and rejects retired Account interest before another open', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-admission.test', accountId: 'bob',
            settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } } } }],
            route: serveBobMachine });
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            const workspace = { serverId, workspaceId: 'accepted', machineId: 'machine', rootPath: '/accepted' };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: workspace.workspaceId, serverId,
                machineId: workspace.machineId, rootPath: workspace.rootPath, createdAtMs: 1 }] });
            rpc.mockReset(); rpc.mockResolvedValue({ ok: true, terminalId: 'requester-pty', reused: false });
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: 'qualified-bob', workspace }));
            const admitted = await hook.getCurrent().admit({ terminalKey: 'qualified-bob', workspace, cwd: workspace.rootPath }, false, new AbortController().signal);
            expect(admitted, JSON.stringify(admitted))
                .toMatchObject({ ok: true, terminalId: 'requester-pty' });
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
                payload: expect.objectContaining({ workspace, terminalKey: 'qualified-bob' }) }));
            storage.getState().activateProfileScope({ serverId, accountId: 'cara' });
            expect(await hook.getCurrent().admit({ terminalKey: 'qualified-bob', workspace }, false, new AbortController().signal))
                .toMatchObject({ ok: false, errorCode: 'terminal_access_denied' });
            expect(rpc).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally { await home.dispose(); }
    });
});
