import { describe, expect, it } from 'vitest';

import {
    generateAndCachePhotoGradientAvatarDataUri,
    getCachedPhotoGradientAvatarDataUri,
} from './photoGradientAvatarDataUri';
import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';

const themeInput = {
    surface: '#ffffff',
    surfaceHigh: '#f8f8f8',
    surfaceHighest: '#eeeeee',
    textSecondary: '#6c6c70',
    accentColors: ['#007aff', '#34c759', '#ff9500', '#ffcc00', '#ff3b30', '#5856d6', '#af52de'],
} satisfies MeshGradientThemeInput;

describe('photoGradientAvatarDataUri', () => {
    it('generates and caches PhotoGradient raster data by session, style, theme, and monochrome mode', async () => {
        const params = {
            id: 'session-photo-cache',
            styleId: 'photoGradientRows' as const,
            monochrome: false,
            theme: themeInput,
        };

        expect(getCachedPhotoGradientAvatarDataUri(params)).toBeNull();

        const generated = await generateAndCachePhotoGradientAvatarDataUri(params, {
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
                toDataURL: () => 'data:image/png;base64,cached-photo-gradient',
            }),
        });

        expect(generated).toBe('data:image/png;base64,cached-photo-gradient');
        expect(getCachedPhotoGradientAvatarDataUri(params)).toBe(generated);
        expect(getCachedPhotoGradientAvatarDataUri({ ...params, monochrome: true })).toBeNull();
    });
});
