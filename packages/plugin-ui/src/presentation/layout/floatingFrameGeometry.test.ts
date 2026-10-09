import { describe, expect, it } from 'vitest';
import { resolveFloatingFrameRect } from './floatingFrameGeometry.js';

describe('measured floating frame placement', () => {
    it('keeps the closest unobstructed placement inside the measured available rect', () => {
        const result = resolveFloatingFrameRect({
            rect: { x: 810, y: 600, width: 180, height: 120 },
            availableRect: { x: 10, y: 70, width: 980, height: 650 },
            avoidRects: [{ x: 850, y: 610, width: 140, height: 110 }],
        });
        expect(result).toEqual({ rect: { x: 810, y: 490, width: 180, height: 120 }, fits: true });
    });

    it('finds a usable pocket among several measured obstacles regardless of their order', () => {
        const input = {
            rect: { x: 100, y: 100, width: 80, height: 60 },
            availableRect: { x: 0, y: 0, width: 300, height: 200 },
            avoidRects: [
                { x: 0, y: 0, width: 220, height: 130 },
                { x: 0, y: 130, width: 300, height: 70 },
            ],
        };
        const result = resolveFloatingFrameRect(input);
        expect(result.fits).toBe(true);
        expect(result.rect.x).toBe(220);
        expect(resolveFloatingFrameRect({ ...input, avoidRects: [...input.avoidRects].reverse() })).toEqual(result);
    });

    it('clips measured viewport size with the supplied aspect ratio and reports no usable space', () => {
        expect(resolveFloatingFrameRect({
            rect: { x: 0, y: 0, width: 600, height: 400 },
            availableRect: { x: 16, y: 60, width: 358, height: 120 }, aspectRatio: 1.5,
        })).toEqual({ rect: { x: 16, y: 60, width: 180, height: 120 }, fits: true });
        expect(resolveFloatingFrameRect({
            rect: { x: 0, y: 0, width: 80, height: 60 },
            availableRect: { x: 0, y: 0, width: 100, height: 100 },
            avoidRects: [{ x: 0, y: 0, width: 100, height: 100 }],
        }).fits).toBe(false);
    });
});
