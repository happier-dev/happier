import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { generateAndCachePhotoGradientAvatarDataUri } from './photoGradientAvatarDataUri';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#ffffff',
                surfaceHigh: '#f8f8f8',
                surfaceHighest: '#eeeeee',
                textSecondary: '#6c6c70',
                accent: {
                    blue: '#007aff',
                    green: '#34c759',
                    orange: '#ff9500',
                    yellow: '#ffcc00',
                    red: '#ff3b30',
                    indigo: '#5856d6',
                    purple: '#af52de',
                },
            },
        },
    });
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

const ImageMock = 'Image' as unknown as React.ComponentType<{ source?: { uri?: string } }>;

describe('AvatarPhotoGradient', () => {
    it('renders the SVG mesh fallback when no raster image has been generated yet', async () => {
        const { AvatarPhotoGradient } = await import('./AvatarPhotoGradient');

        const screen = await renderScreen(
            <AvatarPhotoGradient id="session-photo-fallback" styleId="photoGradientRows" size={48} />,
        );

        expect(screen.findAllByProps({ testID: 'avatar-generated-meshGradient' }).length).toBeGreaterThan(0);
        expect(screen.findAllByType(ImageMock)).toHaveLength(0);
    });

    it('renders a cached raster image instead of the SVG fallback when generation already completed', async () => {
        const { AvatarPhotoGradient } = await import('./AvatarPhotoGradient');
        const id = 'session-photo-cached-component';
        const theme = {
            surface: '#ffffff',
            surfaceHigh: '#f8f8f8',
            surfaceHighest: '#eeeeee',
            textSecondary: '#6c6c70',
            accentColors: ['#007aff', '#34c759', '#ff9500', '#ffcc00', '#ff3b30', '#5856d6', '#af52de'],
        };
        await generateAndCachePhotoGradientAvatarDataUri({
            id,
            styleId: 'photoGradientRows',
            monochrome: false,
            theme,
        }, {
            createCanvas: (width, height) => ({
                width,
                height,
                getContext: () => ({
                    createImageData: (imageWidth: number, imageHeight: number) => ({
                        width: imageWidth,
                        height: imageHeight,
                        colorSpace: 'srgb',
                        data: new Uint8ClampedArray(imageWidth * imageHeight * 4),
                    }),
                    putImageData: () => undefined,
                }),
                toDataURL: () => 'data:image/png;base64,component-cache',
            }),
        });

        const screen = await renderScreen(
            <AvatarPhotoGradient id={id} styleId="photoGradientRows" size={48} />,
        );
        const image = screen.findAllByType(ImageMock)[0];

        expect(image.props.source?.uri).toBe('data:image/png;base64,component-cache');
        expect(screen.findAllByProps({ testID: 'avatar-generated-meshGradient' })).toHaveLength(0);
    });

    it('falls back to the standard gradient avatar if the SVG fallback renderer fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PhotoGradientFallbackBoundary } = await import('./AvatarPhotoGradient');
        const ThrowingSvgFallback = () => {
            throw new Error('svg fallback failed');
        };

        try {
            const screen = await renderScreen(
                <PhotoGradientFallbackBoundary
                    id="session-photo-failed-svg"
                    styleId="photoGradientRows"
                    fallbackStyleId="meshGradientRows"
                    size={48}
                >
                    <ThrowingSvgFallback />
                </PhotoGradientFallbackBoundary>,
            );

            expect(screen.findAllByType(ImageMock)).toHaveLength(1);
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });
});
