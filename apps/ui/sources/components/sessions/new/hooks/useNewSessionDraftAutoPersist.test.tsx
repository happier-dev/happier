import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useNewSessionDraftAutoPersist } from './useNewSessionDraftAutoPersist';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(): Promise<void> {
    await Promise.resolve();
}

async function renderHook(useValue: () => void): Promise<{ unmount: () => void; rerender: () => Promise<void> }> {
    function Test() {
        useValue();
        return null;
    }

    let root: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        root = renderer.create(React.createElement(Test));
        await flushAsync();
    });

    return {
        unmount: () => {
            if (!root) return;
            act(() => {
                root?.unmount();
            });
        },
        rerender: async () => {
            if (!root) return;
            await act(async () => {
                root?.update(React.createElement(Test));
                await flushAsync();
            });
        },
    };
}

describe('useNewSessionDraftAutoPersist', () => {
    it('flushes the pending persist callback on unmount', async () => {
        vi.useFakeTimers();
        try {
            const persistDraftNow = vi.fn();

            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                }),
            );

            // Unmount before the debounce timer fires.
            hook.unmount();

            // Ensure unmount effects have a chance to run without giving timers time to fire.
            await act(async () => {
                await Promise.resolve();
            });

            expect(persistDraftNow).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not flush a pending persist callback after persistence is disabled', async () => {
        vi.useFakeTimers();
        try {
            const persistDraftNow = vi.fn();
            let persistenceEnabled = true;

            const hook = await renderHook(() =>
                useNewSessionDraftAutoPersist({
                    persistDraftNow,
                    persistenceEnabled,
                }),
            );

            persistenceEnabled = false;
            await hook.rerender();

            await act(async () => {
                vi.runAllTimers();
                await Promise.resolve();
            });

            hook.unmount();

            await act(async () => {
                await Promise.resolve();
            });

            expect(persistDraftNow).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
