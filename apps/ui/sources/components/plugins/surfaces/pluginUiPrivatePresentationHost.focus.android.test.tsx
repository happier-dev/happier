import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn(() => 101),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        findNodeHandle: nativeFocus.findNodeHandle,
        AccessibilityInfo: { setAccessibilityFocus: nativeFocus.setAccessibilityFocus },
    });
});

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

type FocusPresentationHost = Readonly<{
    focusTarget?(target: unknown): boolean;
}>;

afterEach(() => {
    nativeFocus.findNodeHandle.mockClear();
    nativeFocus.setAccessibilityFocus.mockClear();
});

describe('createPluginUiPrivatePresentationHost Android focus transfer', () => {
    it('moves native physical and accessibility focus through the Android platform owner', () => {
        const target = { focus: vi.fn() };
        const host = createPluginUiPrivatePresentationHost(undefined, {
            isFocusEligible: () => true,
        }) as FocusPresentationHost;

        expect(host.focusTarget?.(target)).toBe(true);
        expect(target.focus).toHaveBeenCalledWith();
        expect(nativeFocus.findNodeHandle).toHaveBeenCalledWith(target);
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(101);
    });
});
