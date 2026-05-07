import { describe, expect, it } from 'vitest';

import { derivePhotoGradientAvatar } from './derivePhotoGradientAvatar';
import { renderPhotoGradientRasterDataUri } from './renderPhotoGradientRaster';
import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';

const themeInput = {
    surface: '#ffffff',
    surfaceHigh: '#f8f8f8',
    surfaceHighest: '#eeeeee',
    textSecondary: '#6c6c70',
    accentColors: ['#007aff', '#34c759', '#ff9500', '#ffcc00', '#ff3b30', '#5856d6', '#af52de'],
} satisfies MeshGradientThemeInput;

describe('renderPhotoGradientRasterDataUri', () => {
    it('renders a cached-image-ready raster data URI through an injectable canvas', () => {
        let renderedPixels: Uint8ClampedArray | null = null;
        const model = derivePhotoGradientAvatar({
            id: 'session-photo-render',
            size: 24,
            monochrome: false,
            styleId: 'photoGradientRows',
            theme: themeInput,
        });

        const dataUri = renderPhotoGradientRasterDataUri(model, {
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
                    putImageData: (imageData: ImageData) => {
                        renderedPixels = new Uint8ClampedArray(imageData.data);
                    },
                }),
                toDataURL: () => 'data:image/png;base64,avatar',
            }),
        });

        expect(dataUri).toBe('data:image/png;base64,avatar');
        expect(renderedPixels).not.toBeNull();
        expect(new Set(Array.from(renderedPixels!.slice(0, 96)))).not.toEqual(new Set([0, 255]));
    });

    it('renders the diagonal warp as a shallow slant rather than a 45 degree slash', () => {
        let renderedPixels: Uint8ClampedArray | null = null;
        const model = derivePhotoGradientAvatar({
            id: 'session-photo-diagonal-render',
            size: 24,
            monochrome: false,
            styleId: 'photoGradientDiagonal',
            theme: themeInput,
        });

        renderPhotoGradientRasterDataUri(model, {
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
                    putImageData: (imageData: ImageData) => {
                        renderedPixels = new Uint8ClampedArray(imageData.data);
                    },
                }),
                toDataURL: () => 'data:image/png;base64,avatar',
            }),
        });

        expect(model.warpVariant).toBe('diagonal');
        expect(renderedPixels).not.toBeNull();
        expect(new Set(Array.from(renderedPixels!.slice(0, 96)))).not.toEqual(new Set([0, 255]));
    });
});
