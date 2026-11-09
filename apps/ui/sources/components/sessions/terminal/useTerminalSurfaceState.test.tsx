import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { useTerminalSurfaceState } from './useTerminalSurfaceState';
import { Terminal } from '@xterm/xterm';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';

describe('terminal retained-output facts', () => {
    it('preserves parsed scrollback adopted before controller initialization', async () => {
        // Xterm is the renderer SDK boundary; keep the real surface-state owner and cache.
        const terminal = new Terminal({ cols: 80, rows: 24 });
        const output = 'prior command\r\nprior result\r\nprompt$ ';
        await new Promise<void>(resolve => terminal.write(output, resolve));
        const renderer: EmbeddedTerminalRendererHandle = {
            write: text => { terminal.write(text); return true; },
            clear: () => terminal.reset(),
            hasRetainedOutput: () => true,
        };
        const terminalKey = 'd5-adopted-scrollback';
        replaceTerminalSurfaceState(terminalKey, { ...createEmptyTerminalSurfaceState(), terminalId: 'shell', cursor: output.length, output });
        const hook = await renderHook(() => useTerminalSurfaceState({ terminalKey, terminalRef: { current: renderer },
            terminalIdRef: { current: null }, cursorRef: { current: 0 }, terminalRendererHandleRef: { current: null },
            clearNonceRef: { current: 0 }, hydrateOnRender: false }));
        try {
            const text = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n').trimEnd();
            expect(text).toBe(output.replaceAll('\r\n', '\n').trimEnd());
        } finally {
            await hook.unmount();
            replaceTerminalSurfaceState(terminalKey, createEmptyTerminalSurfaceState());
            terminal.dispose();
        }
    });

    it('publishes only the truncation fact consumers read while the cache keeps the exact daemon window', async () => {
        const params = { terminalKey: 'FX211-retention', terminalRef: { current: null },
            terminalIdRef: { current: 'terminal' as string | null }, cursorRef: { current: 0 },
            terminalRendererHandleRef: { current: null }, clearNonceRef: { current: 0 } };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useTerminalSurfaceState(params); });
        expect(hook.getCurrent()).toHaveProperty('syncOutputRetention', expect.any(Function));
        const retention = { mode: 'byte-offset', retainedFromCursor: 100, availableCursor: 2500, truncated: true } as const;
        await act(async () => hook.getCurrent().syncOutputRetention('terminal', retention));
        expect(hook.getCurrent().outputRetention).toEqual({ terminalId: 'terminal', truncated: true });
        const settledRenders = renders;
        // Every streamed chunk advances the daemon window; none of it changes what a consumer shows.
        await act(async () => {
            for (let index = 1; index <= 100; index += 1) {
                hook.getCurrent().syncOutputRetention('terminal', { ...retention, retainedFromCursor: 100 + index, availableCursor: 2500 + index });
            }
        });
        expect(renders).toBe(settledRenders);
        expect(readTerminalSurfaceState('FX211-retention')?.outputRetention).toEqual({ ...retention, retainedFromCursor: 200, availableCursor: 2600 });
        await act(async () => hook.getCurrent().syncOutputRetention('terminal', { ...retention, retainedFromCursor: 0, availableCursor: 3000, truncated: false }));
        expect(hook.getCurrent().outputRetention).toEqual({ terminalId: 'terminal', truncated: false });
        expect(renders).toBe(settledRenders + 1);
        await hook.unmount();
        const reopened = await renderHook(() => useTerminalSurfaceState(params));
        expect(reopened.getCurrent().outputRetention).toEqual({ terminalId: 'terminal', truncated: false });
        expect(readTerminalSurfaceState('FX211-retention')?.outputRetention).toMatchObject({ availableCursor: 3000, truncated: false });
        await act(async () => reopened.getCurrent().syncOutputRetention('replacement', null));
        expect(reopened.getCurrent().outputRetention).toBeNull();
        await reopened.unmount();
    });
});
