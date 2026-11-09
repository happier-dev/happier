import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineRpcTerminalStreamCarrier } from '@/sync/domains/terminal/stream/carrier';
import { useEmbeddedTerminalTransportHandlers } from './useEmbeddedTerminalTransportHandlers';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// The daemon is external; input batching, carrier serialization and RPC schemas remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: boundary.rpc,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// This native rendering package is external and never renders in the hook-only journey.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected native Markdown render'); },
}));

// Keep cold transforms outside the lifecycle test's fake-clock phase.
const { useMachineTerminalSession } = await import('@/hooks/machine/useMachineTerminalSession');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('embedded terminal input delivery through the real carrier', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        boundary.rpc.mockReset().mockResolvedValue({ ok: true });
    });
    afterEach(async () => {
        await standardCleanup();
        vi.useRealTimers();
    });

    it('reconnects the real session on explicit Discard when an uncertain write left no carrier', async () => {
        vi.useRealTimers();
        const homes = await serveActionHomes({
            homes: [{ key: 'primary', serverUrl: 'https://pf56-recovery.test', serverIdentityId: 'srv_pf56_recovery',
                accountId: 'terminal-account', currentAccount: true,
                settings: { featureToggles: { 'terminal.embeddedPty': true } } }],
            route: request => request.path === '/v1/machines'
                ? Response.json([createPlainMachineRowFixture({ id: 'machine', accountId: 'terminal-account' })])
                : request.path === '/v1/machines/read-batch' && request.method === 'POST'
                ? createMachineReadBatchResponseFixture(request.body, id => id === 'machine'
                    ? createPlainMachineRowFixture({ id, accountId: 'terminal-account' }) : null)
                : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse({ features: { terminal: {
                    embeddedPty: { enabled: true }, transport: { byteStream: { enabled: true } },
                } } }))
                : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined,
        });
        onTestFinished(() => homes.dispose());
        const serverId = homes.homes.primary!.id;
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        await getServerFeaturesSnapshot({ serverId, force: true });
        vi.useFakeTimers();
        const heldRead = createDeferred<unknown>();
        const clear = createDeferred<unknown>();
        let inputCalls = 0;
        boundary.rpc.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) return heldRead.promise;
            if (request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT) {
                inputCalls += 1;
                if (inputCalls === 1) return Promise.reject(markRpcRequestDisposition(
                    Object.assign(new Error('unclassified input failure'), { code: 'terminal_input_failed' }), 'outcomeUnknown'));
                if (inputCalls === 2) return clear.promise;
                return Promise.resolve({ ok: true });
            }
            throw new Error(`Unexpected recovery RPC: ${request.method}`);
        });
        const terminalRef = { current: { write: () => true, clear: () => {} } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId, cwd: '/repo', terminalKey: 'pf56-explicit-input-recovery',
            terminalRef, attachedTerminalId: 'terminal',
        }));
        await flushHookEffects();
        expect(hook.getCurrent().status).toBe('connected');
        act(() => hook.getCurrent().onInput('uncertain\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', inputRecoveryAvailable: true });
        expect(inputCalls).toBe(1);

        act(() => hook.getCurrent().discardInputRecovery());
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ status: 'connected', inputRecoveryAvailable: true });
        expect(inputCalls).toBe(2);
        act(() => {
            hook.getCurrent().onInput('whole command');
            hook.getCurrent().onInput('\r');
        });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(inputCalls).toBe(2);
        await act(async () => clear.resolve({ ok: true }));
        await flushHookEffects();
        expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT)
            .map(([request]) => request.payload.event)).toEqual([
                { t: 'text', text: 'uncertain\r' },
                { t: 'text', text: '\u0001\u000b' },
                { t: 'text', text: 'whole command' },
                { t: 'text', text: '\r' },
            ]);
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        await hook.unmount();
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
            await flushHookEffects();
            act(() => hook.getCurrent().onInput('checked\r'));
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(boundary.rpc.mock.calls.slice(1).map(([request]) => request.payload.event)).toEqual([
                { t: 'text', text: '\u0001\u000b' },
                { t: 'text', text: 'checked\r' },
            ]);
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
