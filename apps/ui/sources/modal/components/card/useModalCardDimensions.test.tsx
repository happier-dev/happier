import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

const windowState = vi.hoisted(() => ({
    width: 1024,
    height: 768,
}));

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({
                width: windowState.width,
                height: windowState.height,
            }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

describe('useModalCardDimensions', () => {
    it('clamps the modal card dimensions to the current window', async () => {
        const { renderHook } = await import('@/dev/testkit');
        const { useModalCardDimensions } = await import('./useModalCardDimensions');

        windowState.width = 920;
        windowState.height = 620;

        const hook = await renderHook(() => useModalCardDimensions({
            size: 'lg',
        }));

        expect(hook.getCurrent()).toEqual({
            width: 840,
            maxHeight: 527,
        });
    });

    it('shrinks on smaller windows without dropping below the minimum card size', async () => {
        const { renderHook } = await import('@/dev/testkit');
        const { useModalCardDimensions } = await import('./useModalCardDimensions');

        windowState.width = 360;
        windowState.height = 420;

        const hook = await renderHook(() => useModalCardDimensions({
            size: 'lg',
        }));

        expect(hook.getCurrent()).toEqual({
            width: 320,
            maxHeight: 357,
        });
    });

    it('still fits within narrow windows when an explicit width is requested', async () => {
        const { renderHook } = await import('@/dev/testkit');
        const { useModalCardDimensions } = await import('./useModalCardDimensions');

        windowState.width = 360;
        windowState.height = 680;

        const hook = await renderHook(() => useModalCardDimensions({
            size: 'lg',
            width: 560,
        }));

        expect(hook.getCurrent()).toEqual({
            width: 280,
            maxHeight: 578,
        });
    });

    it('does not hard-cap dialog max height to 320 when maxHeightRatio allows larger cards', async () => {
        const { renderHook } = await import('@/dev/testkit');
        const { useModalCardDimensions } = await import('./useModalCardDimensions');

        windowState.width = 1200;
        windowState.height = 1000;

        const hook = await renderHook(() => useModalCardDimensions({
            size: 'dialog',
            maxHeightRatio: 0.85,
        }));

        expect(hook.getCurrent()).toEqual({
            width: 360,
            maxHeight: 850,
        });
    });
});
