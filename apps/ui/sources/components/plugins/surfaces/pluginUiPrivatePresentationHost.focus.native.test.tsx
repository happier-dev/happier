import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFocus = vi.hoisted(() => ({
    findNodeHandle: vi.fn(() => 73),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
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

describe('createPluginUiPrivatePresentationHost native focus transfer', () => {
    it('moves physical and accessibility focus only while the retained mount remains active, enabled, and un-aborted', () => {
        const current = {
            layoutActive: true,
            interactionEnabled: true,
            aborted: false,
        };
        const target = { focus: vi.fn() };
        const host = createPluginUiPrivatePresentationHost(undefined, {
            isFocusEligible: () => (
                current.layoutActive
                && current.interactionEnabled
                && !current.aborted
            ),
        }) as FocusPresentationHost;

        const oldHostHandle = host;
        expect(oldHostHandle.focusTarget?.(target)).toBe(true);
        expect(target.focus).toHaveBeenCalledWith();
        expect(nativeFocus.findNodeHandle).toHaveBeenCalledWith(target);
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledWith(73);

        current.layoutActive = false;
        expect(oldHostHandle.focusTarget?.(target)).toBe(false);

        current.layoutActive = true;
        current.interactionEnabled = false;
        expect(oldHostHandle.focusTarget?.(target)).toBe(false);

        current.interactionEnabled = true;
        current.aborted = true;
        expect(oldHostHandle.focusTarget?.(target)).toBe(false);
        expect(target.focus).toHaveBeenCalledTimes(1);
        expect(nativeFocus.setAccessibilityFocus).toHaveBeenCalledTimes(1);
    });
});
