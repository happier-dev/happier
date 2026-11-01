import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineRpcTerminalStreamCarrier } from '@/sync/domains/terminal/stream/carrier';
import { useEmbeddedTerminalTransportHandlers } from './useEmbeddedTerminalTransportHandlers';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// The daemon is external; input batching, carrier serialization and RPC schemas remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.rpc,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('embedded terminal input delivery through the real carrier', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        boundary.rpc.mockReset().mockResolvedValue({ ok: true });
    });
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it.each(['notSent', 'outcomeUnknown'] as const)('keeps the input tail intact after a %s disconnect', async disposition => {
        const first = createDeferred<unknown>();
        boundary.rpc.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef: { current: ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null } = {
            current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }),
        };
        const onInputError = vi.fn(() => { terminalStreamCarrierRef.current = null; });
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, onInputError,
        }));

        act(() => hook.getCurrent().onInput('single'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        act(() => hook.getCurrent().onInput(' words\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        await act(async () => first.reject(markRpcRequestDisposition(new Error('disconnected'), disposition)));
        await flushHookEffects();

        // No suffix (especially Enter) may overtake input whose delivery failed.
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(onInputError).toHaveBeenCalledTimes(1);

        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        if (disposition === 'notSent') {
            expect(boundary.rpc.mock.calls.slice(1).map(([request]) => request.payload.event.text).join('')).toBe('single words\r');
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        } else {
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
            expect(hook.getCurrent().readInputRecovery()).toBe('single words\r');
            act(() => hook.getCurrent().discardInputRecovery());
            act(() => hook.getCurrent().onInput('checked\r'));
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(boundary.rpc.mock.calls.slice(1).map(([request]) => request.payload.event.text).join('')).toBe('checked\r');
        }
        await hook.unmount();
    });

    it('flushes input typed while disconnected when its carrier reconnects, without another keypress', async () => {
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef: { current: ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null } = { current: null };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('held\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(boundary.rpc).not.toHaveBeenCalled();
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: {
            terminalId: 'terminal', event: { t: 'text', text: 'held\r' },
        } }));
        await hook.unmount();
    });

    it('keeps initially buffered input for recovery if its process is replaced after a refused write', async () => {
        boundary.rpc.mockRejectedValueOnce(markRpcRequestDisposition(new Error('disconnected'), 'notSent'));
        const terminalIdRef: { current: string | null } = { current: null };
        const terminalStreamCarrierRef: { current: ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null } = { current: null };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('held\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        terminalIdRef.current = 'original';
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        terminalIdRef.current = 'replacement';
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        expect(hook.getCurrent().readInputRecovery()).toBe('held\r');
        await hook.unmount();
    });

    it('resumes a known-unsent batch when reconnect finishes before its refusal arrives', async () => {
        const first = createDeferred<unknown>();
        boundary.rpc.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('single words\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await act(async () => first.reject(markRpcRequestDisposition(new Error('disconnected'), 'notSent')));
        await flushHookEffects();
        expect(boundary.rpc.mock.calls.slice(1).map(([request]) => request.payload.event.text).join('')).toBe('single words\r');
        await hook.unmount();
    });
});
