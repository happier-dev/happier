import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { type DaemonTerminalEnsureResponse, type DaemonTerminalStreamReadResponse } from '@happier-dev/protocol/daemon/terminal';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: boundary.confirm } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Unused HTTP boundary: fail loudly if sign-in ever invokes recipient-envelope work.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Sign-in unexpectedly reached the recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(boundary.rpc));
// Xterm's browser renderer is the system boundary; the controller, stream and sign-in store stay real.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', async () => {
    const React = await import('react');
    return { XtermTerminalView: React.forwardRef(function FixtureRenderer(props: { onReady: (cols: number, rows: number) => void }, ref) {
        React.useImperativeHandle(ref, () => ({ write: () => {}, clear: () => {} }), []);
        React.useEffect(() => { props.onReady(80, 24); }, [props.onReady]);
        return React.createElement('fixture-terminal');
    }) };
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storage');
const { AgentSignInTerminal } = await import('./AgentSignInTerminal');
const { useAgentSignIn } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
let serverId: string;

describe('Agent sign-in terminal lifecycle on web', () => {
    beforeEach(async () => {
        await home.reset();
        serverId = await home.addHome({ name: 'Sign-in terminal', serverUrl: 'https://fixture.invalid', accountId: 'fixture-account' });
        vi.useFakeTimers();
        boundary.rpc.mockReset();
        boundary.confirm.mockReset(); boundary.confirm.mockResolvedValue(true);
    });
    afterEach(() => { standardCleanup(); vi.useRealTimers(); });

    async function renderTerminal(props: React.ComponentProps<typeof AgentSignInTerminal>) {
        const owner = await renderHook(() => useAgentSignIn(props));
        // The form's explicit user intent starts the Action; the terminal only observes it.
        await act(async () => { void owner.getCurrent().start(); });
        return await renderScreen(<AgentSignInTerminal {...props} />);
    }

    function fixture(machineId: string, signedIn = true, machineOverrides: Parameters<typeof createMachineFixture>[0] = {}) {
        const ensure = createDeferred<DaemonTerminalEnsureResponse>();
        const stream = createDeferred<DaemonTerminalStreamReadResponse>();
        const laterStream = createDeferred<DaemonTerminalStreamReadResponse>();
        let streamRead = false;
        let acquiredTerminalId: string | null = null;
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), ...machineOverrides });
        getStorage().setState({ machines: { [machineId]: machine },
            machineListByServerId: { [serverId]: [machine] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        observeMachinePresenceForTest({ serverId, accountId: 'fixture-account' }, [machineId]);
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
            if (method === 'daemon.terminal.ensure') {
                const response = await ensure.promise;
                if (response.ok) acquiredTerminalId = response.terminalId;
                return response;
            }
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ) {
                if (streamRead) return laterStream.promise;
                streamRead = true;
                return stream.promise;
            }
            if (method === 'daemon.terminal.close') return { ok: true };
            if (method === 'daemon.terminal.list') return { ok: true, terminals: acquiredTerminalId ? [
                { terminalId: acquiredTerminalId, terminalKey: `provider-login:${machineId}:codex`, cwd: '/fixture', ended: false, exit: null },
            ] : [] };
            if (method === 'daemon.agents.signIn.status') return { status: signedIn ? 'signedIn' : 'signedOut', accountLabel: 'fixture@example.invalid', checkedAt: Date.now(),
                nativeLogin: 'login_terminal', connectedServices: [] };
            if (method === 'capabilities.detect') return { capabilities: {} };
            throw new Error(`Unexpected fixture RPC ${method}`);
        });
        return { ensure, stream, target: { serverId, machineId, agentId: 'codex', agentTitle: 'Codex', machineName: 'Fixture' } };
    }

    it('keeps Cancel mounted until a late acquisition is closed', async () => {
        const { ensure, target } = fixture('cancel-during-ensure');
        const onClose = vi.fn();
        const screen = await renderTerminal({ ...target, layout: 'pane', onClose });
        await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.terminal.ensure')).toBe(true));
        await screen.pressByTestIdAsync('agent-sign-in-terminal-close');
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => { ensure.resolve({ ok: true, terminalId: 'late-terminal', reused: false }); });
        await waitForHomeGovernance(() => expect(onClose).toHaveBeenCalledOnce());
        await screen.unmount();
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.terminal.close', payload: { terminalId: 'late-terminal' } }));
    });

    it('keeps the terminal open when Cancel approval is rejected', async () => {
        const { ensure, target } = fixture('rejected-terminal-close');
        ensure.resolve({ ok: true, terminalId: 'fixture-terminal', reused: false });
        const onClose = vi.fn();
        const screen = await renderTerminal({ ...target, layout: 'pane', onClose });
        expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null });
        // Cancel is direct by default. An explicit Account policy owns the
        // rejection path through its durable approval, rather than a leaf dialog.
        await home.requireUiApproval(serverId, 'machines.agents.signIn.cancel');
        await screen.pressByTestIdAsync('agent-sign-in-terminal-close');
        const artifact = await waitForHomeGovernance(() => {
            const pending = home.artifacts(serverId).list()[0];
            expect(pending).toBeDefined();
            return pending!;
        });
        expect(ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifact.id) ?? 'null')))
            .toMatchObject({ actionId: 'machines.agents.signIn.cancel', status: 'open',
                actionArgs: { machineId: target.machineId, agentId: target.agentId, terminalId: 'fixture-terminal' } });
        expect(await decideApprovalAsInbox(serverId, artifact.id, 'reject')).toMatchObject({ ok: true,
            result: { status: 'rejected' } });
        expect(onClose).not.toHaveBeenCalled();
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.terminal.close')).toBe(false);
        expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null });
        await screen.unmount();
    });

    it('keeps a known unreachable machine blocked after credentials resolve', async () => {
        const { ensure, target } = fixture('unreachable-terminal', false, { active: false, activeAt: 0 });
        ensure.resolve({ ok: true, terminalId: 'unreachable-login', reused: false });
        const screen = await renderTerminal({ ...target, layout: 'pane', onClose: () => {} });
        expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({
            phase: 'failed', failure: 'terminal_machine_unreachable',
        });
        await screen.unmount();
    });

    it('re-probes on the terminal exit before the next poll and shows the detected account', async () => {
        const { ensure, stream, target } = fixture('exit-status');
        ensure.resolve({ ok: true, terminalId: 'exit-terminal', reused: false });
        const screen = await renderTerminal({ ...target, layout: 'pane', onClose: () => {} });
        await waitForHomeGovernance(() => expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null }));
        await act(async () => { stream.resolve({ ok: true, terminalId: 'exit-terminal', events: [{ t: 'exit', seq: 0, exitCode: 0, signal: null }], nextCursor: 1, done: true }); });
        const view = screen.find((node) => node.props.session?.phase === 'signedIn');
        expect(view.props.accountLabel).toBe('fixture@example.invalid');
        await screen.unmount();
    });

    it('reports both unsuccessful process exits after restarting in the same presenter', async () => {
        const { ensure, stream, target } = fixture('restart-exits', false);
        const secondStream = createDeferred<DaemonTerminalStreamReadResponse>();
        const original = boundary.rpc.getMockImplementation()!;
        let acquisitions = 0;
        boundary.rpc.mockImplementation(async (request: { method: string; payload?: { terminalId?: string } }) => {
            if (request.method === 'daemon.terminal.ensure' && ++acquisitions > 1) {
                return { ok: true, terminalId: 'second-terminal', reused: false };
            }
            if (request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ && request.payload?.terminalId === 'second-terminal') return secondStream.promise;
            return original(request);
        });
        ensure.resolve({ ok: true, terminalId: 'first-terminal', reused: false });
        const onTerminalExit = vi.fn();
        const screen = await renderTerminal({ ...target, layout: 'pane', onClose: () => {}, onTerminalExit });
        await waitForHomeGovernance(() => expect(screen.find((node) => Boolean(node.props.session)).props.session.phase).toBe('waiting'));
        await act(async () => { stream.resolve({ ok: true, terminalId: 'first-terminal', events: [{ t: 'exit', seq: 0, exitCode: 1, signal: null }], nextCursor: 1, done: true }); });
        expect(screen.find((node) => Boolean(node.props.session)).props.session.phase).toBe('failed');
        await act(async () => { screen.find((node) => typeof node.props.controller?.requestRestart === 'function').props.controller.requestRestart(); });
        expect(screen.find((node) => Boolean(node.props.session)).props.session.phase).toBe('waiting');
        expect(onTerminalExit).toHaveBeenCalledTimes(1);
        await act(async () => { secondStream.resolve({ ok: true, terminalId: 'second-terminal', events: [{ t: 'exit', seq: 0, exitCode: 1, signal: null }], nextCursor: 1, done: true }); });
        expect(screen.find((node) => Boolean(node.props.session)).props.session.phase).toBe('failed');
        expect(onTerminalExit).toHaveBeenCalledTimes(2);
        await screen.unmount();
    });

    it('launches and discovers the auth URL while the phone terminal stays undisclosed', async () => {
        const { ensure, stream, target } = fixture('phone-undisclosed');
        ensure.resolve({ ok: true, terminalId: 'phone-terminal', reused: false });
        const screen = await renderTerminal({ ...target, layout: 'sheet', onClose: () => {} });
        expect(screen.findByTestId('agent-sign-in-terminal-xterm')).toBeNull();
        await waitForHomeGovernance(() => expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.terminal.ensure' })));
        await waitForHomeGovernance(() => expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null }));
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ }));
        await act(async () => {
            stream.resolve({ ok: true, terminalId: 'phone-terminal', events: [
                { t: 'url', seq: 0, kind: 'auth', url: 'https://fixture.invalid/auth' },
            ], nextCursor: 1, done: false });
        });
        expect(screen.findByTestId('agent-sign-in.openUrl')).not.toBeNull();
        await screen.unmount();
    });
});
