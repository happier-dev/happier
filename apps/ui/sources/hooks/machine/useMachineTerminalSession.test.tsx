import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import type { machineTerminalEnsure, machineTerminalStreamRead } from '@/sync/ops/machineTerminal';

import { useMachineTerminalSession } from './useMachineTerminalSession';

// The daemon RPC transport is the boundary; the reader, cache and renderer projection stay real.
const rpc = vi.hoisted(() => ({
    ensure: vi.fn<typeof machineTerminalEnsure>(),
    restart: vi.fn<typeof machineTerminalEnsure>(),
    read: vi.fn<typeof machineTerminalStreamRead>(),
    close: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
}));
vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalEnsure: rpc.ensure,
    machineTerminalRestart: rpc.restart,
    machineTerminalStreamRead: rpc.read,
    machineTerminalClose: rpc.close,
    machineTerminalInput: rpc.input,
    machineTerminalResize: rpc.resize,
}));

type EnsureResult = Awaited<ReturnType<typeof machineTerminalEnsure>>;
let nextKey = 0;
function terminalArgs() {
    return {
        machineId: 'machine-1',
        cwd: '/repo',
        terminalKey: `terminal-lifecycle-${++nextKey}`,
        terminalRef: { current: null as EmbeddedTerminalRendererHandle | null },
    };
}
async function ready(hook: { getCurrent: () => { onReady: (cols: number, rows: number) => void } }) {
    await act(async () => hook.getCurrent().onReady(80, 24));
    await flushHookEffects();
}

describe('useMachineTerminalSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rpc.ensure.mockReset().mockResolvedValue({ ok: true, terminalId: 'terminal-1', reused: true });
        rpc.restart.mockReset().mockResolvedValue({ ok: true, terminalId: 'terminal-2', reused: false });
        // A pending network long-poll keeps the real reader alive without artificial timers.
        rpc.read.mockReset().mockImplementation(() => new Promise(() => {}));
    });

    it('keeps the stable terminal key on a typed session-attach request', async () => {
        const args = terminalArgs();
        const launch = { kind: 'session_attach', sessionId: 'session-1' } as const;
        const hook = await renderHook(() => useMachineTerminalSession({ ...args, cwd: null, launch }));
        await ready(hook);
        expect(rpc.ensure).toHaveBeenCalledWith('machine-1', expect.objectContaining({ terminalKey: args.terminalKey, launch }));
        await hook.unmount();
    });

    it('shares the live connection and failure state with every pane without duplicating the reader', async () => {
        const ensure = createDeferred<EnsureResult>();
        const read = createDeferred<Awaited<ReturnType<typeof machineTerminalStreamRead>>>();
        rpc.ensure.mockReturnValueOnce(ensure.promise);
        rpc.read.mockReturnValueOnce(read.promise);
        const args = terminalArgs();
        const owner = await renderHook(() => useMachineTerminalSession(args));
        await ready(owner);
        const followerArgs = { ...args, terminalRef: { current: null } };
        const follower = await renderHook(() => useMachineTerminalSession(followerArgs));
        await ready(follower);
        await act(async () => ensure.resolve({ ok: true, terminalId: 'terminal-1', reused: false }));
        await flushHookEffects();
        expect([owner.getCurrent().status, follower.getCurrent().status]).toEqual(['connected', 'connected']);
        expect(rpc.ensure).toHaveBeenCalledTimes(1);
        expect(rpc.read).toHaveBeenCalledTimes(1);
        await act(async () => read.resolve({ ok: false, errorCode: 'terminal_spawn_failed', error: 'Terminal failed' }));
        await flushHookEffects();
        expect([owner.getCurrent().error, follower.getCurrent().error]).toEqual(['terminal_spawn_failed', 'terminal_spawn_failed']);
        expect(rpc.ensure).toHaveBeenCalledTimes(1);
        await owner.unmount();
        await follower.unmount();
    });

    it('does not let an unready renderer block another ready pane', async () => {
        const args = terminalArgs();
        const hidden = await renderHook(() => useMachineTerminalSession(args));
        const visibleArgs = { ...args, terminalRef: { current: null } };
        const visible = await renderHook(() => useMachineTerminalSession(visibleArgs));
        await ready(visible);
        expect(visible.getCurrent().status).toBe('connected');
        expect(rpc.ensure).toHaveBeenCalledTimes(1);
        await hidden.unmount();
        await visible.unmount();
    });

    it('lets a follower retry a stalled owner and ignores the superseded response', async () => {
        const stalled = createDeferred<EnsureResult>();
        rpc.ensure.mockReturnValueOnce(stalled.promise);
        const args = terminalArgs();
        const owner = await renderHook(() => useMachineTerminalSession(args));
        await ready(owner);
        const followerArgs = { ...args, terminalRef: { current: null } };
        const follower = await renderHook(() => useMachineTerminalSession(followerArgs));
        await ready(follower);
        await act(async () => follower.getCurrent().retryConnect());
        await flushHookEffects();
        expect(follower.getCurrent().status).toBe('connected');
        expect(rpc.ensure).toHaveBeenCalledTimes(2);
        await act(async () => stalled.resolve({ ok: false, errorCode: 'terminal_disabled', error: 'Obsolete failure' }));
        await flushHookEffects();
        expect([owner.getCurrent().status, follower.getCurrent().status]).toEqual(['connected', 'connected']);
        expect(rpc.restart).not.toHaveBeenCalled();
        await owner.unmount();
        await follower.unmount();
    });

    it('releases an inactive reader and resumes from cached output without closing the PTY', async () => {
        const args = terminalArgs();
        const read = createDeferred<Awaited<ReturnType<typeof machineTerminalStreamRead>>>();
        rpc.read.mockReturnValueOnce(read.promise);
        const hook = await renderHook(({ active }) => useMachineTerminalSession({ ...args, active }), { initialProps: { active: true } });
        await ready(hook);
        await hook.rerender({ active: false });
        await act(async () => read.resolve({ ok: true, terminalId: 'terminal-1', nextCursor: 4, events: [{ t: 'data', data: 'late' }], done: false }));
        await flushHookEffects();
        expect(rpc.read).toHaveBeenCalledTimes(1);
        const visibleArgs = { ...args, terminalRef: { current: null } };
        const visible = await renderHook(() => useMachineTerminalSession(visibleArgs));
        await ready(visible);
        expect(visible.getCurrent().status).toBe('connected');
        expect(rpc.ensure).toHaveBeenCalledTimes(2);
        expect(rpc.close).not.toHaveBeenCalled();
        expect(rpc.restart).not.toHaveBeenCalled();
        await hook.unmount();
        await visible.unmount();
    });

    it.each([
        { name: 'validation failure', machineId: null, failure: null, error: 'terminal_missing_machine_target' },
        { name: 'RPC failure', machineId: 'machine-1', failure: new Error('rpc exploded'), error: 'rpc exploded' },
    ])('allows a newly opened pane to recover after $name', async ({ machineId, failure, error }) => {
        const args = terminalArgs();
        if (failure) rpc.ensure.mockRejectedValueOnce(failure);
        const failed = await renderHook(() => useMachineTerminalSession({ ...args, machineId }));
        await ready(failed);
        expect(failed.getCurrent().error).toBe(error);
        const nextArgs = { ...args, terminalRef: { current: null } };
        const next = await renderHook(() => useMachineTerminalSession(nextArgs));
        await ready(next);
        expect(next.getCurrent().status).toBe('connected');
        await failed.unmount();
        await next.unmount();
    });
});
