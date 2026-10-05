import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import type { DaemonTerminalEnsureResponse, DaemonTerminalStreamReadResponse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
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
vi.mock('@/sync/domains/server/serverProfiles', async (original) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(original, { profiles: [{ id: 'fixture-server', serverUrl: 'https://fixture.invalid' }] });
});
vi.mock('@/auth/storage/tokenStorage', async (original) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal: original, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64')}.signature`,
            encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
    } });
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(boundary.rpc));
vi.mock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false }));
// Xterm's browser renderer is the system boundary; the controller, stream and sign-in store stay real.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', async () => {
    const React = await import('react');
    return { XtermTerminalView: React.forwardRef(function FixtureRenderer(props: { onReady: (cols: number, rows: number) => void }, ref) {
        React.useImperativeHandle(ref, () => ({ write: () => {}, clear: () => {} }), []);
        React.useEffect(() => { props.onReady(80, 24); }, [props.onReady]);
        return React.createElement('fixture-terminal');
    }) };
});

import { getStorage } from '@/sync/domains/state/storage';
import { AgentSignInTerminal } from './AgentSignInTerminal';

describe('Agent sign-in terminal lifecycle on web', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        boundary.rpc.mockReset();
    });
    afterEach(() => { standardCleanup(); vi.useRealTimers(); });

    function fixture(machineId: string, signedIn = true) {
        const ensure = createDeferred<DaemonTerminalEnsureResponse>();
        const stream = createDeferred<DaemonTerminalStreamReadResponse>();
        const laterStream = createDeferred<DaemonTerminalStreamReadResponse>();
        let streamRead = false;
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
        getStorage().setState({ machines: { [machineId]: machine } });
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
            if (method === 'daemon.terminal.ensure') return ensure.promise;
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ) {
                if (streamRead) return laterStream.promise;
                streamRead = true;
                return stream.promise;
            }
            if (method === 'daemon.terminal.close') return { ok: true };
            if (method === 'daemon.terminal.list') return { ok: true, terminals: [
                { terminalId: machineId === 'restart-exits' ? 'first-terminal' : 'fixture-terminal', terminalKey: `provider-login:${machineId}:codex`, cwd: '/fixture', ended: false, exit: null },
            ] };
            if (method === 'daemon.agents.signIn.status') return { status: signedIn ? 'signedIn' : 'signedOut', accountLabel: 'fixture@example.invalid', checkedAt: Date.now(),
                nativeLogin: 'login_terminal', connectedServices: [] };
            if (method === 'capabilities.detect') return { capabilities: {} };
            throw new Error(`Unexpected fixture RPC ${method}`);
        });
        return { ensure, stream, target: { serverId: 'fixture-server', machineId, agentId: 'codex', agentTitle: 'Codex', machineName: 'Fixture' } };
    }

    it('closes a terminal whose ensure completes after Cancel and presenter unmount', async () => {
        const { ensure, target } = fixture('cancel-during-ensure');
        const onClose = vi.fn();
        const screen = await renderScreen(<AgentSignInTerminal {...target} layout="pane" onClose={onClose} />);
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === 'daemon.terminal.ensure')).toBe(true);
        await screen.pressByTestIdAsync('agent-sign-in-terminal-close');
        expect(onClose).toHaveBeenCalled();
        await screen.unmount();
        await act(async () => { ensure.resolve({ ok: true, terminalId: 'late-terminal', reused: false }); });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.terminal.close', payload: { terminalId: 'late-terminal' } }));
        expect(boundary.rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)).toBe(false);
    });

    it('re-probes on the terminal exit before the next poll and shows the detected account', async () => {
        const { ensure, stream, target } = fixture('exit-status');
        ensure.resolve({ ok: true, terminalId: 'exit-terminal', reused: false });
        const screen = await renderScreen(<AgentSignInTerminal {...target} layout="pane" onClose={() => {}} />);
        expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null });
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
        const screen = await renderScreen(<AgentSignInTerminal {...target} layout="pane" onClose={() => {}} onTerminalExit={onTerminalExit} />);
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
        const screen = await renderScreen(<AgentSignInTerminal {...target} layout="sheet" onClose={() => {}} />);
        expect(screen.findByTestId('agent-sign-in-terminal-xterm')).toBeNull();
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.terminal.ensure' }));
        expect(screen.find((node) => Boolean(node.props.session)).props.session).toMatchObject({ phase: 'waiting', failure: null });
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
