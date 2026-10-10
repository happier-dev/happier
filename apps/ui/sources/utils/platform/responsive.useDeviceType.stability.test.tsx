import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { getDeviceType, useDeviceType } from './responsive';

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
    afterEach(() => vi.unstubAllGlobals());
    beforeEach(() => {
        screenState.platformOS = 'web';
        screenState.hookDims = { width: 800, height: 700 };
        screenState.staticDims = { width: 800, height: 700 };
    });

    it.each([
        { host: 'Windows touch desktop', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', fine: false, width: 1440, height: 400, expected: 'tablet' },
        { host: 'X11 touch desktop', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', fine: false, width: 1440, height: 540, expected: 'tablet' },
        { host: 'narrow desktop', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', fine: false, width: 390, height: 844, expected: 'phone' },
        { host: 'Android phone with pointer', userAgent: 'Mozilla/5.0 (Linux; Android 14)', fine: true, width: 844, height: 390, expected: 'phone' },
        { host: 'iPad with pointer in short split view', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', fine: true, width: 844, height: 390, expected: 'phone' },
        { host: 'portrait iPad with pointer', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', fine: true, width: 834, height: 1194, expected: 'tablet' },
        { host: 'landscape iPad with pointer', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', fine: true, width: 1194, height: 834, expected: 'tablet' },
    ])('uses hardware identity in reactive and snapshot classification: $host', async ({ userAgent, fine, width, height, expected }) => {
        vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 5 });
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: fine
                ? query === '(pointer: fine)' || query === '(hover: hover)'
                : query === '(pointer: coarse)' || query === '(hover: none)' }),
        });
        screenState.hookDims = { width, height };
        screenState.staticDims = { width, height };
        const screen = await renderScreen(<DeviceTypeLabel />);
        expect(screen.findByProps({ 'data-testid': 'deviceType' }).children[0]).toBe(expected);
        expect(getDeviceType()).toBe(expected);
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
