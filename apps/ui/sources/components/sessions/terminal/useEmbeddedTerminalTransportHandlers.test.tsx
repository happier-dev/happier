import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inputSpy = vi.fn(async () => undefined);
const resizeSpy = vi.fn(async () => undefined);

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalInput: (...args: Parameters<typeof inputSpy>) => inputSpy(...args),
    machineTerminalResize: (...args: Parameters<typeof resizeSpy>) => resizeSpy(...args),
}));

type TerminalIdRef = { current: string | null };

describe('useEmbeddedTerminalTransportHandlers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        inputSpy.mockClear();
        resizeSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('keeps buffered input until machine and terminal ids are available', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: null };
        const initialProps: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef }> = {
            machineId: null,
            terminalIdRef,
        };
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps,
            },
        );

        hook.getCurrent().onInput('hello');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(inputSpy).not.toHaveBeenCalled();

        await hook.rerender({ machineId: 'machine-1', terminalIdRef });
        terminalIdRef.current = 'term-1';

        hook.getCurrent().onInput('!');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(inputSpy).toHaveBeenCalledTimes(1);
        expect(inputSpy).toHaveBeenCalledWith('machine-1', { terminalId: 'term-1', data: 'hello!' });

        await hook.unmount();
    });

    it('flushes buffered input during unmount when transport is ready', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const initialProps: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef }> = {
            machineId: 'machine-1',
            terminalIdRef,
        };
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps,
            },
        );

        hook.getCurrent().onInput('buffered');

        expect(inputSpy).not.toHaveBeenCalled();

        await hook.unmount();

        expect(inputSpy).toHaveBeenCalledTimes(1);
        expect(inputSpy).toHaveBeenCalledWith('machine-1', { terminalId: 'term-1', data: 'buffered' });
    });

    it('does not start a second terminal input send while the previous send is still in flight', async () => {
        let resolveFirst: (() => void) | undefined;
        inputSpy
            .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
                resolveFirst = () => resolve(undefined);
            }))
            .mockResolvedValueOnce(undefined);

        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const hook = await renderHook(() =>
            useEmbeddedTerminalTransportHandlers({ machineId: 'machine-1', terminalIdRef }),
        );

        hook.getCurrent().onInput('g');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(inputSpy).toHaveBeenNthCalledWith(1, 'machine-1', { terminalId: 'term-1', data: 'g' });

        hook.getCurrent().onInput('it status');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(inputSpy).toHaveBeenCalledTimes(1);

        expect(resolveFirst).toBeDefined();
        resolveFirst?.();
        await flushHookEffects({ cycles: 3, turns: 3, runOnlyPendingTimers: true });

        expect(inputSpy).toHaveBeenNthCalledWith(2, 'machine-1', { terminalId: 'term-1', data: 'it status' });
    });

    it('continues draining later buffered input after a send failure', async () => {
        let rejectFirst: ((error?: unknown) => void) | undefined;
        inputSpy
            .mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => {
                rejectFirst = reject;
            }))
            .mockResolvedValueOnce(undefined);

        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const hook = await renderHook(() =>
            useEmbeddedTerminalTransportHandlers({ machineId: 'machine-1', terminalIdRef }),
        );

        hook.getCurrent().onInput('git ');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(inputSpy).toHaveBeenCalledTimes(1);

        hook.getCurrent().onInput('status');
        rejectFirst!(new Error('transient'));
        await flushHookEffects({ cycles: 3, turns: 3, runOnlyPendingTimers: true });

        expect(inputSpy).toHaveBeenCalledTimes(2);
        expect(inputSpy).toHaveBeenLastCalledWith('machine-1', { terminalId: 'term-1', data: 'status' });
    });

    it('uses the latest machine after rerender while a previous send is still in flight', async () => {
        let resolveFirst: (() => void) | undefined;
        inputSpy
            .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
                resolveFirst = () => resolve(undefined);
            }))
            .mockResolvedValueOnce(undefined);

        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');
        const terminalIdRef: TerminalIdRef = { current: 'term-1' };
        const hook = await renderHook(
            (props: Readonly<{ machineId: string | null; terminalIdRef: TerminalIdRef }>) =>
                useEmbeddedTerminalTransportHandlers(props),
            {
                initialProps: { machineId: 'machine-1', terminalIdRef },
            },
        );

        hook.getCurrent().onInput('git ');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(inputSpy).toHaveBeenNthCalledWith(1, 'machine-1', { terminalId: 'term-1', data: 'git ' });

        await hook.rerender({ machineId: 'machine-2', terminalIdRef });
        hook.getCurrent().onInput('status');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(inputSpy).toHaveBeenCalledTimes(1);

        expect(resolveFirst).toBeDefined();
        resolveFirst?.();
        await flushHookEffects({ cycles: 3, turns: 3, runOnlyPendingTimers: true });

        expect(inputSpy).toHaveBeenNthCalledWith(2, 'machine-2', { terminalId: 'term-1', data: 'status' });
    });
});
