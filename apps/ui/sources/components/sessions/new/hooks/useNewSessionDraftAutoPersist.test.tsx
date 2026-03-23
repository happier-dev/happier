import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import { useNewSessionDraftAutoPersist } from './useNewSessionDraftAutoPersist';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
            await hook.unmount();
            await flushHookEffects();

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
            await flushHookEffects({ runAllTimers: true });
            await hook.unmount();
            await flushHookEffects();

            expect(persistDraftNow).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
