import { describe, expect, it } from 'vitest';

import { resolveCapturePillFrame, resolveCaptureWindowFrame, type CaptureWindowFrameInput } from './resolveCaptureWindowFrame';

const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const metrics = { gutter: 24, screenInset: 24, chromeTop: 68, chromeBottom: 124, floorWidth: 740 };
const base: CaptureWindowFrameInput = { picture: { width: 594, height: 360 }, origin: null, workArea, metrics, remembered: null };

const contains = (outer: { x: number; y: number; width: number; height: number }, inner: typeof outer) =>
    inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

describe('resolveCaptureWindowFrame', () => {
    it('cascades from the previous capture using the existing gutter and keeps the union on screen', () => {
        const previous = resolveCaptureWindowFrame(base).window;
        const next = resolveCaptureWindowFrame({ ...base, previousFrame: previous });
        expect(next.window.x).toBe(previous.x + metrics.gutter);
        expect(next.window.y).toBe(previous.y + metrics.gutter);
        const corner = resolveCaptureWindowFrame({ ...base, previousFrame: { ...previous, x: 1400, y: 870 } });
        expect(corner.window.x + corner.window.width).toBe(workArea.x + workArea.width - metrics.screenInset);
        expect(corner.window.y + corner.window.height).toBe(workArea.y + workArea.height - metrics.screenInset);
    });
    it('lands a small capture on the area it came from, at 1×', () => {
        const origin = { x: 300, y: 200, width: 594, height: 360 };
        const { window, picture, scale } = resolveCaptureWindowFrame({ ...base, origin });
        expect(scale).toBe(1);
        expect({ x: window.x + picture.x, y: window.y + picture.y }).toEqual({ x: 300, y: 200 });
    });

    it('fits a large capture so the source stays visible around the window', () => {
        const { picture, scale, window } = resolveCaptureWindowFrame({ ...base, picture: { width: 1440, height: 900 }, origin: { x: 0, y: 0, width: 1440, height: 900 } });
        expect(scale).toBeLessThan(1);
        expect(picture.width).toBeLessThanOrEqual(workArea.width * 0.54);
        expect(picture.height / picture.width).toBeCloseTo(900 / 1440, 2);
        expect(window.width).toBe(picture.width + metrics.gutter * 2);
    });

    it('clamps inside the work area near every edge, negative origins included', () => {
        const left = resolveCaptureWindowFrame({ ...base, workArea: { x: -1920, y: 0, width: 1920, height: 1080 }, origin: { x: -1990, y: -40, width: 594, height: 360 } });
        expect(left.window.x).toBe(-1920 + metrics.screenInset);
        expect(left.window.y).toBe(metrics.screenInset);
        const corner = resolveCaptureWindowFrame({ ...base, origin: { x: 846, y: 466, width: 594, height: 360 } });
        expect(corner.window.x + corner.window.width).toBe(workArea.x + workArea.width - metrics.screenInset);
        expect(corner.window.y + corner.window.height).toBe(workArea.y + workArea.height - metrics.screenInset);
    });

    it('never narrows below the measured toolbar floor and centres a narrower picture', () => {
        const { window, picture } = resolveCaptureWindowFrame({ ...base, picture: { width: 200, height: 120 } });
        expect(window.width).toBe(metrics.floorWidth);
        expect(picture.x).toBe((metrics.floorWidth - 200) / 2);
    });

    it('centres without an origin and uses the remembered place only then', () => {
        const centred = resolveCaptureWindowFrame(base);
        expect(centred.window.x + centred.window.width / 2).toBe(workArea.x + workArea.width / 2);
        const remembered = { x: 40, y: 60 };
        expect(resolveCaptureWindowFrame({ ...base, remembered }).window).toMatchObject(remembered);
        const origin = { x: 300, y: 200, width: 594, height: 360 };
        expect(resolveCaptureWindowFrame({ ...base, origin, remembered }).window.x).not.toBe(remembered.x);
    });

    it('gives a union frame holding both the area and the window', () => {
        const origin = { x: 846, y: 466, width: 594, height: 360 };
        const { union, window } = resolveCaptureWindowFrame({ ...base, origin });
        expect(contains(union, origin)).toBe(true);
        expect(contains(union, window)).toBe(true);
        expect(resolveCaptureWindowFrame(base).union).toEqual(resolveCaptureWindowFrame(base).window);
    });
});

describe('resolveCapturePillFrame', () => {
    it('sits at the window bottom edge, centred, inside the work area', () => {
        const window = { x: 40, y: 100, width: 640, height: 500 };
        const pill = resolveCapturePillFrame({ window, pill: { width: 460, height: 52 }, workArea, screenInset: 24 });
        expect(pill.x + pill.width / 2).toBe(window.x + window.width / 2);
        expect(pill.y + pill.height).toBe(window.y + window.height);
        const narrow = resolveCapturePillFrame({ window: { ...window, x: 0, width: 300 }, pill: { width: 460, height: 52 }, workArea, screenInset: 24 });
        expect(narrow.x).toBe(24);
    });
});
