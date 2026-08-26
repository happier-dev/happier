import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { TerminalStreamCarrier } from '@/sync/domains/terminal/stream/model';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inputSpy = vi.fn(async () => undefined);
const resizeSpy = vi.fn(async () => undefined);
const carrierSendInputSpy = vi.fn(async () => undefined);
const modalConfirmSpy = vi.fn(async () => true);
const onInputErrorSpy = vi.fn();

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalInput: (...args: Parameters<typeof inputSpy>) => inputSpy(...args),
    machineTerminalResize: (...args: Parameters<typeof resizeSpy>) => resizeSpy(...args),
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
        inputSpy.mockClear();
        resizeSpy.mockClear();
        carrierSendInputSpy.mockClear();
        modalConfirmSpy.mockClear();
        onInputErrorSpy.mockClear();
        modalConfirmSpy.mockResolvedValue(true);
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('keeps buffered input until machine and terminal ids are available', async () => {
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
        expect(inputSpy).not.toHaveBeenCalled();

        await hook.rerender({ machineId: 'machine-1', terminalIdRef, terminalStreamCarrierRef });
        terminalIdRef.current = 'term-1';

        hook.getCurrent().onInput('!');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(carrierSendInputSpy).toHaveBeenCalledTimes(1);
        expect(carrierSendInputSpy).toHaveBeenCalledWith('term-1', { t: 'text', text: 'hello!' });
        expect(inputSpy).not.toHaveBeenCalled();

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
        expect(inputSpy).not.toHaveBeenCalled();
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
        expect(inputSpy).not.toHaveBeenCalled();

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
        expect(resizeSpy).not.toHaveBeenCalled();

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
