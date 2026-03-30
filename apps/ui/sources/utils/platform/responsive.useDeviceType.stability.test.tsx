import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { useDeviceType } from './responsive';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const screenState = vi.hoisted(() => ({
    platformOS: 'web' as 'ios' | 'android' | 'web',
    hookDims: { width: 800, height: 700 },
    staticDims: { width: 800, height: 700 },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    get OS() {
                        return screenState.platformOS;
                    },
                    select: (options: any) => options?.[screenState.platformOS] ?? options?.default ?? options?.ios ?? options?.android,
                },
                Dimensions: {
                    get: () => ({
                        width: screenState.staticDims.width,
                        height: screenState.staticDims.height,
                        scale: 2,
                        fontScale: 1,
                    }),
                },
                useWindowDimensions: () => ({
                    width: screenState.hookDims.width,
                    height: screenState.hookDims.height,
                    scale: 2,
                    fontScale: 1,
                }),
            }
    );
});

function DeviceTypeLabel() {
    const deviceType = useDeviceType();
    return <div data-testid="deviceType">{deviceType}</div>;
}

describe('useDeviceType (stability)', () => {
    beforeEach(() => {
        screenState.platformOS = 'web';
        screenState.hookDims = { width: 800, height: 700 };
        screenState.staticDims = { width: 800, height: 700 };
    });

    it('keeps the last valid deviceType when useWindowDimensions returns zero temporarily', async () => {
        const screen = await renderScreen(<DeviceTypeLabel />);
        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('tablet');

        screenState.hookDims = { width: 0, height: 0 };
        await screen.update(<DeviceTypeLabel />);

        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('tablet');
    });

    it('falls back to Dimensions.get when hook dimensions are temporarily invalid', async () => {
        const screen = await renderScreen(<DeviceTypeLabel />);
        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('tablet');

        screenState.hookDims = { width: 0, height: 0 };
        screenState.staticDims = { width: 800, height: 700 };
        await screen.update(<DeviceTypeLabel />);

        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('tablet');
    });

    it('still updates when dimensions are valid and cross the tablet threshold', async () => {
        const screen = await renderScreen(<DeviceTypeLabel />);
        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('tablet');

        screenState.hookDims = { width: 390, height: 844 };
        screenState.staticDims = { width: 390, height: 844 };
        await screen.update(<DeviceTypeLabel />);

        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe('phone');
    });
});
