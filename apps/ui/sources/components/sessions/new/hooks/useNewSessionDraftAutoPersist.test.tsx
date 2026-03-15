import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useNewSessionDraftAutoPersist } from './useNewSessionDraftAutoPersist';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(): Promise<void> {
    await Promise.resolve();
}

async function renderHook(useValue: () => void): Promise<{ unmount: () => void }> {
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
});
