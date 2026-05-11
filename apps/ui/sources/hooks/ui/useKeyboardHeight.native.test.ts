import { describe, expect, it, beforeEach, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const nativeState = vi.hoisted(() => ({
    platformOS: 'ios' as 'ios' | 'android',
    keyboard: {
        isVisible: true,
        height: 300,
    },
    safeArea: {
        top: 0,
        right: 0,
        bottom: 34,
        left: 0,
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return nativeState.platformOS;
            },
            select: <T,>(options: { ios?: T; android?: T; native?: T; default?: T }) =>
                options[nativeState.platformOS] ?? options.native ?? options.default,
        },
    });
});

vi.mock('react-native-keyboard-controller', async () => {
    const { createKeyboardControllerMock } = await import('@/dev/testkit/mocks/nativeEnvironment');
    return createKeyboardControllerMock(nativeState);
});

vi.mock('react-native-safe-area-context', async () => {
    const { createSafeAreaContextMock } = await import('@/dev/testkit/mocks/nativeEnvironment');
    return createSafeAreaContextMock(nativeState);
});

describe('useKeyboardHeight native', () => {
    beforeEach(() => {
        standardCleanup();
        nativeState.platformOS = 'ios';
        nativeState.keyboard.isVisible = true;
        nativeState.keyboard.height = 300;
        nativeState.safeArea.bottom = 34;
    });

    it('returns 0 while the keyboard is hidden', async () => {
        nativeState.keyboard.isVisible = false;

        const { useKeyboardHeight } = await import('./useKeyboardHeight.native');
        const hook = await renderHook(() => useKeyboardHeight());

        expect(hook.getCurrent()).toBe(0);
    });

    it('subtracts the bottom safe area from iOS keyboard height', async () => {
        nativeState.platformOS = 'ios';

        const { useKeyboardHeight } = await import('./useKeyboardHeight.native');
        const hook = await renderHook(() => useKeyboardHeight());

        expect(hook.getCurrent()).toBe(266);
    });

    it('does not subtract the bottom safe area from Android keyboard height', async () => {
        nativeState.platformOS = 'android';

        const { useKeyboardHeight } = await import('./useKeyboardHeight.native');
        const hook = await renderHook(() => useKeyboardHeight());

        expect(hook.getCurrent()).toBe(300);
    });
});
