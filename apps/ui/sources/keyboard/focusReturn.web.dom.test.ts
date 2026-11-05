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
        expect(focus).toHaveBeenCalledExactlyOnceWith();
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
