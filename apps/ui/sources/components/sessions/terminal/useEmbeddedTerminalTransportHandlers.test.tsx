import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react-test-renderer';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineRpcTerminalStreamCarrier } from '@/sync/domains/terminal/stream/carrier';
import type { TerminalStreamCarrier } from '@/sync/domains/terminal/stream/model';
import { createPf56NativeTerminalPeer } from '@/hooks/machine/pf56NativeTerminalPeer.testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const carrierSendInputSpy = vi.fn(async () => undefined);
const modalConfirmSpy = vi.fn(async () => true);
const onInputErrorSpy = vi.fn();
const rpcBoundary = vi.hoisted(() => ({ request: vi.fn() }));

// The Machine RPC is external; input ordering, carrier serialization and schemas remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: rpcBoundary.request,
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: Parameters<typeof modalConfirmSpy>) => modalConfirmSpy(...args),
    },
}));

type TerminalIdRef = { current: string | null };
type TerminalStreamCarrierRef = {
    current: TerminalStreamCarrier | null;
};

function createTerminalStreamCarrierRef(): TerminalStreamCarrierRef {
    return {
        current: {
            kind: 'machine-rpc-base64',
            read: vi.fn(async () => ({ ok: false, code: 'test_unimplemented', message: 'test unimplemented' } as const)),
            acknowledge: vi.fn(async () => undefined),
            sendInput: carrierSendInputSpy,
        },
    };
}

describe('useEmbeddedTerminalTransportHandlers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        carrierSendInputSpy.mockClear();
        modalConfirmSpy.mockClear();
        onInputErrorSpy.mockClear();
        rpcBoundary.request.mockReset().mockResolvedValue({ ok: true });
        modalConfirmSpy.mockResolvedValue(true);
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('holds admitted input through read-only and disconnect until writable reattachment', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const terminalIdRef = { current: 'borrowed' };
        const terminalStreamCarrierRef: TerminalStreamCarrierRef = { current: null };
        const hook = await renderHook((props: { readOnly: boolean }) => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, readOnly: props.readOnly,
        }), { initialProps: { readOnly: false } });
        act(() => {
            hook.getCurrent().onInput('queued');
            hook.getCurrent().onResize(100, 30);
        });
        await hook.rerender({ readOnly: true });
        await act(async () => {
            hook.getCurrent().onInput('ignored');
            hook.getCurrent().onResize(120, 40);
            expect(await hook.getCurrent().onPaste('x'.repeat(100_000))).toEqual({ kind: 'ignore', reason: 'read_only' });
        });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request).not.toHaveBeenCalled();
        expect(hook.getCurrent().readInputRecovery()).toBe('queued');
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        await hook.rerender({ readOnly: false });
        await flushHookEffects();
        expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual([
            { t: 'text', text: 'queued' },
        ]);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it('coalesces a 275-character queued typing burst behind one in-flight write, preserving Enter', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const first = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        const command = 'typed'.repeat(55);
        for (const character of command) {
            act(() => hook.getCurrent().onInput(character));
            await flushHookEffects({ runOnlyPendingTimers: true });
        }
        act(() => hook.getCurrent().onInput('\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1);
        await act(async () => first.resolve({ ok: true }));
        await flushHookEffects();
        expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual([
            { t: 'text', text: command[0] },
            { t: 'text', text: command.slice(1) },
            { t: 'text', text: '\r' },
        ]);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it.each(['before flush', 'disconnected'] as const)(
        'coalesces unsent text runs queued %s without crossing Enter',
        async state => {
            const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
            const terminalIdRef = { current: 'terminal' };
            const terminalStreamCarrierRef: TerminalStreamCarrierRef = {
                current: state === 'disconnected' ? null : createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }),
            };
            const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
                machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
            }));
            const commands = ['echo ' + 'a'.repeat(130), 'echo ' + 'b'.repeat(130)];
            for (const command of commands) {
                for (const character of command) {
                    act(() => hook.getCurrent().onInput(character));
                    if (state === 'disconnected') await flushHookEffects({ runOnlyPendingTimers: true });
                }
                act(() => hook.getCurrent().onInput('\r'));
            }
            expect(rpcBoundary.request).not.toHaveBeenCalled();
            if (state === 'disconnected') {
                terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
                act(() => hook.getCurrent().flushPendingInput());
            }
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual(
                commands.flatMap(text => [{ t: 'text', text }, { t: 'text', text: '\r' }]),
            );
            expect(hook.getCurrent().readInputRecovery()).toBe('');
            await hook.unmount();
        },
    );

    it('batches queued text without crossing paste or cursor-control chunks', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const first = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('first'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        await act(async () => {
            hook.getCurrent().onInput('a');
            hook.getCurrent().onInput('b');
            await hook.getCurrent().onPaste('pasted');
            hook.getCurrent().onInput('c');
            hook.getCurrent().onInput('d');
            hook.getCurrent().onInput('\u001b[D');
            hook.getCurrent().onInput('e');
            hook.getCurrent().onInput('f');
        });
        await act(async () => first.resolve({ ok: true }));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual([
            { t: 'text', text: 'first' },
            { t: 'text', text: 'ab' },
            { t: 'paste', text: 'pasted', bracketed: true },
            { t: 'text', text: 'cd' },
            { t: 'text', text: '\u001b[D' },
            { t: 'text', text: 'ef' },
        ]);
        await hook.unmount();
    });

    it('delivers a 275-character multi-command burst in text runs separated by Enter', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const first = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        const commands = ['echo ' + 'a'.repeat(85), 'echo ' + 'b'.repeat(86), 'echo ' + 'c'.repeat(86)];
        const input = commands.map(command => command + '\r').join('');
        expect(input).toHaveLength(275);
        for (const character of input) {
            act(() => hook.getCurrent().onInput(character));
            await flushHookEffects({ runOnlyPendingTimers: true });
        }
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1);
        await act(async () => first.resolve({ ok: true }));
        await flushHookEffects();
        expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual(
            [commands[0][0], commands[0].slice(1), '\r', commands[1], '\r', commands[2], '\r']
                .map(text => ({ t: 'text', text })),
        );
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it('keeps valid text beyond the protocol event limit in separate queued writes', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const first = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, onInputError: onInputErrorSpy,
        }));
        act(() => hook.getCurrent().onInput('first'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        act(() => {
            hook.getCurrent().onInput('a'.repeat(60_000));
            hook.getCurrent().onInput('b'.repeat(40_000));
            hook.getCurrent().onInput('c');
        });
        await act(async () => first.resolve({ ok: true }));
        await flushHookEffects({ runOnlyPendingTimers: true });
        const texts = rpcBoundary.request.mock.calls.map(([request]) => request.payload.event.text);
        expect(texts.map(text => text.length)).toEqual([5, 100_000, 1]);
        expect(texts.join('')).toBe('first' + 'a'.repeat(60_000) + 'b'.repeat(40_000) + 'c');
        expect(onInputErrorSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it('holds the never-sent tail when its in-flight predecessor succeeds during read-only', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const first = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => first.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook((props: { readOnly: boolean }) => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, readOnly: props.readOnly,
        }), { initialProps: { readOnly: false } });
        act(() => hook.getCurrent().onInput('first'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        act(() => hook.getCurrent().onInput('held\r'));
        await hook.rerender({ readOnly: true });
        await act(async () => first.resolve({ ok: true }));
        expect(hook.getCurrent().readInputRecovery()).toBe('held\r');
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1);
        await hook.rerender({ readOnly: false });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event.text)).toEqual(['first', 'held\r']);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it.each(['input', 'resize'] as const)('ignores a retired attachment’s %s failure while retaining current failures', async operation => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const terminalIdRef = { current: 'original' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const pending = createDeferred<undefined>();
        carrierSendInputSpy.mockImplementationOnce(() => pending.promise);
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, onInputError: onInputErrorSpy,
        }));
        await act(async () => {
            if (operation === 'input') hook.getCurrent().onInput('old');
            else hook.getCurrent().onResize(100, 30);
        });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(carrierSendInputSpy).toHaveBeenCalledTimes(1);
        if (operation === 'input') terminalIdRef.current = 'replacement';
        else terminalStreamCarrierRef.current = createTerminalStreamCarrierRef().current;
        const failure = Object.assign(new Error('terminal_not_found'), { code: 'terminal_not_found' });
        await act(async () => pending.reject(failure));
        expect(onInputErrorSpy).not.toHaveBeenCalled();
        if (operation === 'input') act(() => hook.getCurrent().discardInputRecovery());
        carrierSendInputSpy.mockRejectedValueOnce(failure);
        await act(async () => {
            if (operation === 'input') hook.getCurrent().onInput('current');
            else hook.getCurrent().onResize(120, 40);
        });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(onInputErrorSpy).toHaveBeenCalledExactlyOnceWith(failure);
        await hook.unmount();
    });

    it('keeps buffered input chunks separate until machine and terminal ids are available', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: null };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const initialProps: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }> = {
            machineId: null,
            terminalIdRef,
            terminalStreamCarrierRef,
        };
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps,
            },
        );

        hook.getCurrent().onInput('hello');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).not.toHaveBeenCalled();

        await hook.rerender({ machineId: 'machine-1', terminalIdRef, terminalStreamCarrierRef });
        terminalIdRef.current = 'term-1';

        hook.getCurrent().onInput('!');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        await flushHookEffects();

        expect(carrierSendInputSpy.mock.calls).toEqual([
            ['term-1', { t: 'text', text: 'hello' }],
            ['term-1', { t: 'text', text: '!' }],
        ]);

        await hook.unmount();
    });

    it.each(['unavailable', 'blocked acknowledgement', 'notSent retry'] as const)(
        'keeps held command, Enter and later typing as separate ordered writes through a %s carrier',
        async state => {
            const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
            const first = createDeferred<unknown>();
            if (state !== 'unavailable') rpcBoundary.request.mockImplementationOnce(() => first.promise);
            const terminalIdRef = { current: 'terminal' };
            const terminalStreamCarrierRef: TerminalStreamCarrierRef = {
                current: state === 'unavailable' ? null : createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }),
            };
            const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
                machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
            }));

            act(() => {
                hook.getCurrent().onInput('held command');
                hook.getCurrent().onInput('\r');
            });
            await flushHookEffects({ runOnlyPendingTimers: true });
            act(() => {
                hook.getCurrent().onInput('later command');
                hook.getCurrent().onInput('\r');
            });
            await flushHookEffects({ runOnlyPendingTimers: true });

            // Neither a missing carrier nor an unacknowledged write may let the tail overtake it.
            expect(rpcBoundary.request).toHaveBeenCalledTimes(state === 'unavailable' ? 0 : 1);
            if (state === 'blocked acknowledgement') {
                await act(async () => first.resolve({ ok: true }));
            } else {
                terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
                act(() => hook.getCurrent().flushPendingInput());
                if (state === 'notSent retry') {
                    await act(async () => first.reject(markRpcRequestDisposition(new Error('disconnected'), 'notSent')));
                }
            }
            await flushHookEffects();

            const expectedChunks = ['held command', '\r', 'later command', '\r'];
            if (state === 'notSent retry') expectedChunks.unshift('held command');
            expect(rpcBoundary.request.mock.calls.map(([request]) => request.payload.event)).toEqual(
                expectedChunks.map(text => ({ t: 'text', text })),
            );
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
            expect(hook.getCurrent().readInputRecovery()).toBe('');
            await hook.unmount();
        },
    );

    // Only the IPC transport is substituted: the real daemon RPC writes to Bash's native PTY.
    it.skipIf(process.platform === 'win32')('clears a partially delivered Bash line before an explicit whole-command retry', async () => {
        vi.useRealTimers();
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const directory = await mkdtemp(join(tmpdir(), 'pf56-r6-input-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const peer = await createPf56NativeTerminalPeer('pf56-input-recovery');
        onTestFinished(() => peer.dispose());
        const output = join(directory, 'executions');
        const command = `printf '%s\\n' 'whole-command' >> '${output}'`;
        const failedWrite = createDeferred<void>();
        let partial = true;
        rpcBoundary.request.mockImplementation(async request => {
            if (partial) {
                partial = false;
                await peer.request(request.method, { ...request.payload,
                    event: { t: 'text', text: command.slice(0, 6) + '\u001b[D\u001b[D' } });
                failedWrite.resolve();
                throw markRpcRequestDisposition(new Error('acknowledgement lost after partial delivery'), 'outcomeUnknown');
            }
            return peer.request(request.method, request.payload);
        });
        const terminalIdRef = { current: peer.terminalId };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        await act(async () => {
            hook.getCurrent().onInput(command);
            hook.getCurrent().onInput('\r');
            await failedWrite.promise;
        });
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        expect(hook.getCurrent().readInputRecovery()).toBe(command + '\r');
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1); // An ambiguous command is never replayed.
        act(() => hook.getCurrent().discardInputRecovery());
        act(() => {
            hook.getCurrent().onInput(command);
            hook.getCurrent().onInput('\r');
        });
        await act(async () => {
            await vi.waitFor(async () => expect(await readFile(output, 'utf8')).toBe('whole-command\n'));
        });
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it('keeps recovery text and later chunks held until the explicit line-clear is acknowledged', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        rpcBoundary.request.mockRejectedValueOnce(markRpcRequestDisposition(new Error('lost ack'), 'outcomeUnknown'));
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('uncertain\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        const clear = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => clear.promise);
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().discardInputRecovery());
        expect(hook.getCurrent().readInputRecovery()).toBe('uncertain\r');
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        act(() => {
            hook.getCurrent().onInput('later');
            hook.getCurrent().onInput('\r');
        });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request).toHaveBeenCalledTimes(2);
        await act(async () => clear.resolve({ ok: true }));
        await flushHookEffects();
        expect(rpcBoundary.request.mock.calls.slice(1).map(([request]) => request.payload.event)).toEqual([
            { t: 'text', text: '\u0001\u000b' },
            { t: 'text', text: 'later' },
            { t: 'text', text: '\r' },
        ]);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        await hook.unmount();
    });

    it('retains recovery after a failed line-clear and never retries that clear automatically', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        rpcBoundary.request.mockRejectedValueOnce(markRpcRequestDisposition(new Error('lost ack'), 'outcomeUnknown'));
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('uncertain\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        rpcBoundary.request.mockRejectedValueOnce(markRpcRequestDisposition(new Error('clear lost ack'), 'outcomeUnknown'));
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().discardInputRecovery());
        await flushHookEffects();
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        expect(hook.getCurrent().readInputRecovery()).toBe('uncertain\r');
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        expect(rpcBoundary.request).toHaveBeenCalledTimes(2);
        act(() => hook.getCurrent().discardInputRecovery());
        await flushHookEffects();
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        expect(hook.getCurrent().readInputRecovery()).toBe('');
        await hook.unmount();
    });

    it.each(['waiting for carrier', 'clear in flight'] as const)(
        'preserves uncertain recovery across read-only while %s and requires a writable explicit discard',
        async state => {
            const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
            rpcBoundary.request.mockRejectedValueOnce(markRpcRequestDisposition(new Error('lost ack'), 'outcomeUnknown'));
            const terminalIdRef = { current: 'terminal' };
            const terminalStreamCarrierRef: TerminalStreamCarrierRef = {
                current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }),
            };
            const hook = await renderHook((props: { readOnly: boolean }) => useEmbeddedTerminalTransportHandlers({
                machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, readOnly: props.readOnly,
            }), { initialProps: { readOnly: false } });
            act(() => hook.getCurrent().onInput('uncertain\r'));
            await flushHookEffects({ runOnlyPendingTimers: true });
            const clear = createDeferred<unknown>();
            if (state === 'clear in flight') rpcBoundary.request.mockImplementationOnce(() => clear.promise);
            terminalStreamCarrierRef.current = state === 'clear in flight'
                ? createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) : null;
            act(() => hook.getCurrent().discardInputRecovery());
            act(() => hook.getCurrent().onInput('held later\r'));
            await hook.rerender({ readOnly: true });
            await flushHookEffects({ runOnlyPendingTimers: true });
            if (state === 'clear in flight') await act(async () => clear.resolve({ ok: true }));
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
            expect(hook.getCurrent().readInputRecovery()).toBe('uncertain\rheld later\r');
            act(() => hook.getCurrent().discardInputRecovery()); // A read-only action cannot authorize a write.
            await hook.rerender({ readOnly: false });
            terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
            act(() => hook.getCurrent().flushPendingInput());
            await flushHookEffects();
            expect(rpcBoundary.request).toHaveBeenCalledTimes(state === 'clear in flight' ? 2 : 1);
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
            act(() => hook.getCurrent().discardInputRecovery());
            await flushHookEffects();
            expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
            expect(hook.getCurrent().readInputRecovery()).toBe('');
            await hook.unmount();
        },
    );

    it('retains an in-flight write across read-only until its ambiguous disposition can be recovered', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const pending = createDeferred<unknown>();
        rpcBoundary.request.mockImplementationOnce(() => pending.promise);
        const terminalIdRef = { current: 'terminal' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook((props: { readOnly: boolean }) => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef, readOnly: props.readOnly,
        }), { initialProps: { readOnly: false } });
        act(() => hook.getCurrent().onInput('uncertain'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        act(() => hook.getCurrent().onInput('\r'));
        await hook.rerender({ readOnly: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        await act(async () => pending.reject(markRpcRequestDisposition(new Error('lost ack'), 'outcomeUnknown')));
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        expect(hook.getCurrent().readInputRecovery()).toBe('uncertain\r');
        await hook.rerender({ readOnly: false });
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().flushPendingInput());
        await flushHookEffects();
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(true);
        await hook.unmount();
    });

    it('discards replaced-process recovery without clearing the replacement terminal', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        rpcBoundary.request.mockRejectedValueOnce(markRpcRequestDisposition(new Error('lost ack'), 'outcomeUnknown'));
        const terminalIdRef = { current: 'original' };
        const terminalStreamCarrierRef = { current: createMachineRpcTerminalStreamCarrier({ machineId: 'machine' }) };
        const hook = await renderHook(() => useEmbeddedTerminalTransportHandlers({
            machineId: 'machine', terminalIdRef, terminalStreamCarrierRef,
        }));
        act(() => hook.getCurrent().onInput('uncertain\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        terminalIdRef.current = 'replacement';
        terminalStreamCarrierRef.current = createMachineRpcTerminalStreamCarrier({ machineId: 'machine' });
        act(() => hook.getCurrent().discardInputRecovery());
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        expect(rpcBoundary.request).toHaveBeenCalledTimes(1);
        act(() => hook.getCurrent().onInput('replacement input\r'));
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(rpcBoundary.request.mock.calls[1]?.[0].payload).toEqual({
            terminalId: 'replacement', event: { t: 'text', text: 'replacement input\r' },
        });
        await hook.unmount();
    });

    it('flushes buffered input during unmount when transport is ready', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const initialProps: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }> = {
            machineId: 'machine-1',
            terminalIdRef,
            terminalStreamCarrierRef,
        };
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps,
            },
        );

        hook.getCurrent().onInput('buffered');

        expect(carrierSendInputSpy).not.toHaveBeenCalled();

        await hook.unmount();

        expect(carrierSendInputSpy).toHaveBeenCalledTimes(1);
        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', { t: 'text', text: 'buffered' });
    });

    it('routes explicit paste through bracketed paste policy before terminal input', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        const current = hook.getCurrent() as ReturnType<typeof useEmbeddedTerminalTransportHandlers> & {
            onPaste?: (text: string) => unknown;
        };
        expect(typeof current.onPaste).toBe('function');
        current.onPaste?.('hello');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', {
            t: 'paste',
            text: 'hello',
            bracketed: true,
        });

        await hook.unmount();
    });

    it('routes debounced resizes through the stream carrier', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        await act(async () => {
            hook.getCurrent().onResize(120, 40);
        });

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', { t: 'resize', cols: 120, rows: 40 });

        await hook.unmount();
    });

    it('ignores transient renderer sizes that the terminal protocol cannot represent', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        await act(async () => {
            hook.getCurrent().onResize(120, 1);
            hook.getCurrent().onReady(1, 40);
        });
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(hook.getCurrent().initialTerminalSize).toBeNull();
        expect(hook.getCurrent().latestTerminalSizeRef.current).toBeNull();
        expect(carrierSendInputSpy).not.toHaveBeenCalled();
        expect(onInputErrorSpy).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onResize(100, 30);
        });
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(hook.getCurrent().initialTerminalSize).toEqual({ cols: 100, rows: 30 });
        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', { t: 'resize', cols: 100, rows: 30 });

        await hook.unmount();
    });

    it('reports debounced resize failures through the shared input error callback', async () => {
        carrierSendInputSpy.mockRejectedValueOnce(new Error('terminal_not_found'));
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers({
                    ...props,
                    onInputError: onInputErrorSpy,
                }),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        await act(async () => {
            hook.getCurrent().onResize(120, 40);
        });

        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', { t: 'resize', cols: 120, rows: 40 });
        expect(onInputErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'terminal_not_found' }));

        await hook.unmount();
    });

    it('asks for host confirmation before sending large paste payloads', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        await hook.getCurrent().onPaste('x'.repeat(40_000));
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', {
            t: 'paste',
            text: 'x'.repeat(40_000),
            bracketed: true,
        });

        await hook.unmount();
    });

    it('does not send a large paste when host confirmation is rejected', async () => {
        modalConfirmSpy.mockResolvedValueOnce(false);
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const terminalStreamCarrierRef = createTerminalStreamCarrierRef();
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef; terminalStreamCarrierRef: TerminalStreamCarrierRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: {
                    machineId: 'machine-1',
                    terminalIdRef,
                    terminalStreamCarrierRef,
                },
            },
        );

        await hook.getCurrent().onPaste('x'.repeat(40_000));
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
