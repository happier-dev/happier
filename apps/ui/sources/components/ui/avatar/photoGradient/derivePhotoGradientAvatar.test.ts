import { describe, expect, it } from 'vitest';

import { derivePhotoGradientAvatar } from './derivePhotoGradientAvatar';
import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';

const themeInput = {
    surface: '#ffffff',
    surfaceHigh: '#f8f8f8',
    surfaceHighest: '#eeeeee',
    textSecondary: '#6c6c70',
    accentColors: ['#007aff', '#34c759', '#ff9500', '#ffcc00', '#ff3b30', '#5856d6', '#af52de'],
} satisfies MeshGradientThemeInput;

const PHOTO_GRADIENT_STYLE_IDS = [
    'photoGradient',
    'photoGradientRows',
    'photoGradientColumns',
    'photoGradientDiagonal',
    'photoGradientWaves',
    'photoGradientOval',
    'photoGradientValueNoise',
    'photoGradientVoronoi',
    'photoGradientMeshGrid',
] as const;

describe('derivePhotoGradientAvatar', () => {
    it('derives deterministic shader-style control points from session id and style', () => {
        const first = derivePhotoGradientAvatar({
            id: 'session-photo-1',
            size: 128,
            monochrome: false,
            styleId: 'photoGradientRows',
            theme: themeInput,
        });
        const second = derivePhotoGradientAvatar({
            id: 'session-photo-1',
            size: 128,
            monochrome: false,
            styleId: 'photoGradientRows',
            theme: themeInput,
        });

        expect(second).toEqual(first);
        expect(first.renderMode).toBe('sharpBezier');
        expect(first.warpVariant).toBe('rows');
        expect(first.points.length).toBeGreaterThanOrEqual(6);
        expect(first.noiseRatio).toBeGreaterThan(0);
        expect(first.warpRatio).toBeGreaterThan(0);
    });

    it('keeps monochrome PhotoGradient models neutral at the shared model layer', () => {
        const model = derivePhotoGradientAvatar({
            id: 'session-photo-1',
            size: 128,
            monochrome: true,
            styleId: 'photoGradientRows',
            theme: themeInput,
        });

        for (const point of model.points) {
            expect(point.color.r).toBe(point.color.g);
            expect(point.color.g).toBe(point.color.b);
        }
    });

    it('keeps PhotoGradient color control sets warm-balanced instead of cool-dominant', () => {
        for (const styleId of PHOTO_GRADIENT_STYLE_IDS) {
            for (const id of ['lantern', 'atlas', 'prism', 'patio']) {
                const model = derivePhotoGradientAvatar({
                    id,
                    size: 128,
                    monochrome: false,
                    styleId,
                    theme: themeInput,
                });

                for (const point of model.points) {
                    expect(point.color.b - Math.max(point.color.r, point.color.g)).toBeLessThanOrEqual(48);
                }
            }
        }
    });
});
