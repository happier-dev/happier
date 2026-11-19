import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// This drawing-only suite does not need the root barrel's Protocol fixtures.
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PlanetCanvas } from './PlanetCanvas.web';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps one canvas per mark and frees its pixel buffer while hidden and when it unmounts', async () => {
    // WebKit keeps a dropped canvas's pixel surface until a GC the JS heap has no pressure to run, so
    // each Home visit grew the desktop app by the planet's full-size buffers (P03-DESKTOP-LONG).
    vi.stubGlobal('document', { documentElement: {}, fonts: { check: () => true } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const dot = vi.fn();
    const context = { setTransform() {}, clearRect() {}, beginPath() {}, arc: dot, fill() {}, fillText() {},
        measureText: () => ({ actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 12 }) };
    // The physical drawing surfaces are the system boundary: count their pixels, not the drawing.
    const surfaces: { width: number; height: number }[] = [];
    const surface = (width = 0, height = 0) => {
        const canvas = { width, height, getContext: () => context };
        surfaces.push(canvas);
        return canvas;
    };
    const pixels = () => surfaces.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
    let layers = 0;
    Object.assign(document, { createElement: () => { layers += 1; return surface(); } });
    const pane = { width: 280, height: 240 };
    const Scene = ({ mode = 'visible', theme = 'dark' }: { mode?: 'visible' | 'hidden'; theme?: 'dark' | 'light' }) =>
        <React.Activity mode={mode}><PlanetCanvas {...pane} mark={{ theme, size: pane.width }} /></React.Activity>;
    const screen = await renderScreen(<Scene />,
        { createNodeMock: element => {
            const { width, height } = element.props;
            return element.type === 'canvas' && typeof width === 'number' && typeof height === 'number' ? surface(width, height) : null;
        } });
    await screen.update(<Scene theme="light" />);
    await screen.update(<Scene />);
    expect(layers).toBe(0);
    const shown = pixels();
    expect(shown).toBeGreaterThan(0);
    await screen.update(<Scene mode="hidden" />);
    expect(pixels()).toBe(0);
    dot.mockClear();
    await screen.update(<Scene />);
    expect(pixels()).toBe(shown);
    expect(dot).toHaveBeenCalled();
    expect(layers).toBe(0);
    await screen.unmount();
    expect(pixels()).toBe(0);
});
