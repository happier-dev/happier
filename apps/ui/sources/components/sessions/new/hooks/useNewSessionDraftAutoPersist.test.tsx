import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import { useNewSessionDraftAutoPersist } from './useNewSessionDraftAutoPersist';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNewSessionDraftAutoPersist', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushes the pending persist callback on unmount', async () => {
        const persistDraftNow = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionDraftAutoPersist({
                persistDraftNow,
            }),
        );

        // Unmount before the debounce timer fires.
        await hook.unmount();

        expect(persistDraftNow).toHaveBeenCalledTimes(1);
    });

    it('does not flush a pending persist callback after persistence is disabled', async () => {
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

        expect(persistDraftNow).not.toHaveBeenCalled();
    });
});
