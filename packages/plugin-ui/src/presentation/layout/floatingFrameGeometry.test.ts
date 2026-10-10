import { describe, expect, it } from 'vitest';
import { resolveFloatingFrameRect } from './floatingFrameGeometry.js';

describe('measured floating frame placement', () => {
    it('settles a native or web throw at the projected corner through aspect, obstacle and dock constraints', () => {
        const input = {
            rect: { x: 40, y: 50, width: 200, height: 165 },
            availableRect: { x: 10, y: 20, width: 800, height: 600 },
            projectedPoint: { x: 650, y: 500 },
            aspectRatio: 1.6, chromeHeight: 40, minWidth: 180,
            avoidRects: [{ x: 610, y: 455, width: 200, height: 165 }],
        };
        expect(resolveFloatingFrameRect(input)).toEqual({
            rect: { x: 610, y: 290, width: 200, height: 165 }, fits: true,
        });
        expect(resolveFloatingFrameRect({ ...input, minWidth: 900 }).fits).toBe(false);
    });
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

    it('keeps the body aspect outside the chrome when the space is short, and refuses a frame narrower than its usable minimum', () => {
        // A 400-wide frame with 40 px of chrome above a 1.6 body asks for 290 px; only 120 px is free.
        const short = resolveFloatingFrameRect({
            rect: { x: 0, y: 0, width: 400, height: 290 },
            availableRect: { x: 0, y: 0, width: 600, height: 120 },
            aspectRatio: 1.6, chromeHeight: 40,
        });
        expect(short.fits).toBe(true);
        expect(short.rect.width).toBeCloseTo(128);
        expect(short.rect.width / (short.rect.height - 40)).toBeCloseTo(1.6);

        // Positive space is not usable space: the controls need 240 px across.
        expect(resolveFloatingFrameRect({
            rect: { x: 0, y: 0, width: 400, height: 290 },
            availableRect: { x: 0, y: 0, width: 600, height: 120 },
            aspectRatio: 1.6, chromeHeight: 40, minWidth: 240,
        }).fits).toBe(false);
        // No body height at all never fits.
        expect(resolveFloatingFrameRect({
            rect: { x: 0, y: 0, width: 400, height: 290 },
            availableRect: { x: 0, y: 0, width: 600, height: 36 },
            aspectRatio: 1.6, chromeHeight: 40,
        }).fits).toBe(false);
    });
});
