/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { restoreFocusToBestTarget } from './focusReturn';

describe('focus return helpers on web', () => {
    it('invokes DOM focus on the requested anchor', () => {
        const focus = vi.fn();

        expect(restoreFocusToBestTarget({ current: { focus, isConnected: true } })).toBe(true);
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    });

    it('returns browser focus without changing the retained page scroll', () => {
        const page = document.createElement('div');
        const trigger = document.createElement('button');
        page.append(trigger); document.body.append(page);
        page.scrollTop = 650;
        // Browser focus scrolling is an OS boundary: jsdom owns activeElement,
        // but does not implement the layout-driven scroll side effect itself.
        const original = trigger.focus;
        trigger.focus = (options?: FocusOptions) => {
            original.call(trigger, options);
            if (!options?.preventScroll) page.scrollTop = 81;
        };
        try {
            expect(restoreFocusToBestTarget({ current: trigger })).toBe(true);
            expect(document.activeElement).toBe(trigger);
            expect(page.scrollTop).toBe(650);
        } finally { page.remove(); }
    });

    it('returns to the eligible control inside a measurable trigger wrapper', () => {
        const wrapper = document.createElement('div');
        const hidden = document.createElement('button');
        hidden.hidden = true;
        const disabled = document.createElement('button');
        disabled.disabled = true;
        const trigger = document.createElement('button');
        wrapper.append(hidden, disabled, trigger);
        document.body.append(wrapper);
        try {
            expect(restoreFocusToBestTarget({ current: wrapper })).toBe(true);
            expect(document.activeElement).toBe(trigger);
        } finally { wrapper.remove(); }
    });
});
