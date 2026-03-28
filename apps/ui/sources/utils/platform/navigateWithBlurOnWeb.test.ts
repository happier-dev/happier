import { describe, expect, it, vi } from 'vitest';

describe('navigateWithBlurOnWeb', () => {
    it('blurs the active element before running the navigation action on web', async () => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
        }
    );
});

        const blurSpy = vi.fn();
        const originalDocument = globalThis.document;
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: { activeElement: { blur: blurSpy } },
        });

        const { navigateWithBlurOnWeb } = await import('./navigateWithBlurOnWeb');
        const actionSpy = vi.fn();
        navigateWithBlurOnWeb(actionSpy);

        expect(blurSpy).toHaveBeenCalledTimes(1);
        expect(actionSpy).toHaveBeenCalledTimes(1);

        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: originalDocument,
        });
    });

    it('runs the navigation action without trying to blur on native', async () => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'ios',
            },
        }
    );
});

        const { navigateWithBlurOnWeb } = await import('./navigateWithBlurOnWeb');
        const actionSpy = vi.fn();
        navigateWithBlurOnWeb(actionSpy);

        expect(actionSpy).toHaveBeenCalledTimes(1);
    });
});
