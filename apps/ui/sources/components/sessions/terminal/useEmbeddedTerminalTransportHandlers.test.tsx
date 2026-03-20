import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const inputSpy = vi.fn(async () => undefined);
const resizeSpy = vi.fn(async () => undefined);

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalInput: (...args: Parameters<typeof inputSpy>) => inputSpy(...args),
    machineTerminalResize: (...args: Parameters<typeof resizeSpy>) => resizeSpy(...args),
}));

describe('useEmbeddedTerminalTransportHandlers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        inputSpy.mockClear();
        resizeSpy.mockClear();
    });

    it('keeps buffered input until machine and terminal ids are available', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        let latestHandlers: ReturnType<typeof useEmbeddedTerminalTransportHandlers> | null = null;
        const terminalIdRef: React.MutableRefObject<string | null> = { current: null };

        function Harness(props: Readonly<{ machineId: string | null }>) {
            latestHandlers = useEmbeddedTerminalTransportHandlers({
                machineId: props.machineId,
                terminalIdRef,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Harness machineId={null} />);
        });

        act(() => {
            latestHandlers!.onInput('hello');
        });

        await act(async () => {
            vi.runAllTimers();
        });

        expect(inputSpy).not.toHaveBeenCalled();

        await act(async () => {
            tree!.update(<Harness machineId="machine-1" />);
        });
        terminalIdRef.current = 'term-1';

        act(() => {
            latestHandlers!.onInput('!');
        });

        await act(async () => {
            vi.runAllTimers();
        });

        expect(inputSpy).toHaveBeenCalledTimes(1);
        expect(inputSpy).toHaveBeenCalledWith('machine-1', { terminalId: 'term-1', data: 'hello!' });
    });

    it('flushes buffered input during unmount when transport is ready', async () => {
        const { useEmbeddedTerminalTransportHandlers } = await import('./useEmbeddedTerminalTransportHandlers');

        let latestHandlers: ReturnType<typeof useEmbeddedTerminalTransportHandlers> | null = null;
        const terminalIdRef: React.MutableRefObject<string | null> = { current: 'term-1' };

        function Harness() {
            latestHandlers = useEmbeddedTerminalTransportHandlers({
                machineId: 'machine-1',
                terminalIdRef,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Harness />);
        });

        act(() => {
            latestHandlers!.onInput('buffered');
        });

        expect(inputSpy).not.toHaveBeenCalled();

        await act(async () => {
            tree!.unmount();
        });

        expect(inputSpy).toHaveBeenCalledTimes(1);
        expect(inputSpy).toHaveBeenCalledWith('machine-1', { terminalId: 'term-1', data: 'buffered' });
    });
});
