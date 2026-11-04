import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// This drawing-only suite does not need the root barrel's Protocol fixtures.
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PlanetCanvas } from './PlanetCanvas.web';
import { homePlanetGeometry, homePlanetSceneOptions } from './homePlanetPlacement';
import { createPlanetScene } from '@happier-dev/brand/planet';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('draws the static body once per real input change and only retypes digits on visible two-second ticks', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Browser fonts and the physical Canvas2D drawing surface are system boundaries.
    vi.stubGlobal('document', { documentElement: {}, fonts: { check: () => true } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const frames: string[][] = [[]];
    const arc = vi.fn();
    const context = { setTransform() {}, clearRect() { frames.push([]); }, beginPath() {}, arc, fill() {}, drawImage() {},
        measureText: () => ({ actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 12 }),
        fillText(text: string) { frames.at(-1)!.push(text); } };
    Object.assign(document, { createElement: () => ({ getContext: () => context }) });
    const pane = { width: 280, height: 240 };
    const options = homePlanetSceneOptions(homePlanetGeometry('corner', pane), pane,
        { theme: 'dark', style: 'balanced', digits: true });
    const ready = vi.fn();
    let parentRenders = 0;
    function Scene({ paused = false, theme = 'dark', ink }: { paused?: boolean; theme?: 'dark' | 'light'; ink?: string }) {
        parentRenders += 1;
        return <PlanetCanvas {...pane} options={{ ...options, theme }} ink={ink} retype={{ paused }} onReady={ready} />;
    }
    const screen = await renderScreen(<Scene />, { createNodeMock: element => element.type === 'canvas'
        ? { getContext: () => context } : null });
    const mounted = parentRenders;
    const outerProps = screen.findByType(PlanetCanvas).props;
    ready.mockClear();
    const rest = frames.at(-1)!;
    const mountedFrames = frames.length;
    const bodyDots = arc.mock.calls.length;
    const initial = createPlanetScene(options);
    expect(bodyDots).toBe(initial.body.length + initial.haze.length);
    expect(bodyDots).toBeGreaterThan(0);
    for (let tick = 0; tick < 150; tick++) await act(async () => { vi.advanceTimersByTime(2000); });
    expect(arc).toHaveBeenCalledTimes(bodyDots);
    expect(ready).toHaveBeenCalledTimes(150);
    expect(parentRenders).toBe(mounted);
    expect(screen.findByType(PlanetCanvas).props === outerProps).toBe(true);
    expect(frames.slice(mountedFrames).some(frame => JSON.stringify(frame) !== JSON.stringify(rest))).toBe(true);
    await screen.update(<Scene paused />);
    ready.mockClear();
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(ready).not.toHaveBeenCalled();
    await screen.update(<Scene />);
    ready.mockClear();
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(ready).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(ready).toHaveBeenCalledOnce();
    await screen.update(<Scene theme="light" />);
    const light = createPlanetScene({ ...options, theme: 'light' });
    expect(arc).toHaveBeenCalledTimes(bodyDots + light.body.length + light.haze.length);
    const lightDigits = frames.at(-1)!;
    expect(lightDigits.length).toBeGreaterThan(0);
    await screen.update(<Scene theme="light" ink="#123456" />);
    expect(frames.at(-1)).toEqual(lightDigits);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
