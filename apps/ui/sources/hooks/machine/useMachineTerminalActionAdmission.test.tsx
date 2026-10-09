import { describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook } from '@/dev/testkit';
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

// The encrypted Machine RPC transport is the external daemon boundary; Actions,
// policy, Account currentness, request schemas and admission stay real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

describe('Project terminal admission through canonical Machine Actions', () => {
    it('requires the same Machine Action admission for a Session package-script process', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'session', serverUrl: 'https://session-terminal-admission.test', accountId: 'bob',
            settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } } } }], route: () => undefined });
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
        } finally { home.dispose(); }
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
        } finally { home.dispose(); }
    });
    it('opens one admitted requester shell and rejects retired Account interest before another open', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-admission.test', accountId: 'bob',
            settings: { actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } } } }], route: () => undefined });
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
        } finally { home.dispose(); }
    });
});
