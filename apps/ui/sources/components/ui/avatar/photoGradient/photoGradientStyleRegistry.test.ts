import { describe, expect, it } from 'vitest';

import {
    getPhotoGradientFallbackStyleId,
    getPhotoGradientStyleDefinition,
} from './photoGradientStyleRegistry';

describe('photoGradientStyleRegistry', () => {
    it('defines shared renderer modes, warp variants, and SVG fallbacks for persisted PhotoGradient styles', () => {
        expect(getPhotoGradientStyleDefinition('photoGradientRows')).toMatchObject({
            id: 'photoGradientRows',
            renderMode: 'sharpBezier',
            warpVariant: 'rows',
            fallbackStyleId: 'meshGradientRows',
        });
        expect(getPhotoGradientStyleDefinition('photoGradientDiagonal')).toMatchObject({
            id: 'photoGradientDiagonal',
            renderMode: 'sharpBezier',
            warpVariant: 'diagonal',
            fallbackStyleId: 'meshGradientDiagonal',
        });
        expect(getPhotoGradientStyleDefinition('photoGradientMeshGrid')).toMatchObject({
            renderMode: 'meshGrid',
            warpVariant: 'columns',
        });
        expect(getPhotoGradientFallbackStyleId('photoGradientVoronoi')).toBe('meshGradientOrganic');
    });
});
