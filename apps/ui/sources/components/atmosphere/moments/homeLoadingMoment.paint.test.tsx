import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { HomePlanet, useHomePlanetOptions, homePlanetFootFade } from '../HomePlanet';
import { useHomeLoadingMoment } from './homeLoadingMoment';

// Exercise the physical web drawing adapter, with only browser/RN boundaries supplied below.
vi.mock('../PlanetCanvas', () => import('../PlanetCanvas.web'));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  { name: 'corner', placement: 'corner', phone: false, widgets: false },
  { name: 'side', placement: 'side', phone: false, widgets: false },
  { name: 'side with widgets', placement: 'side', phone: false, widgets: true },
  { name: 'rise', placement: 'rise', phone: false, widgets: false },
  { name: 'rise with widgets', placement: 'rise', phone: false, widgets: true },
  { name: 'phone corner', placement: 'corner', phone: true, widgets: false },
  { name: 'phone side', placement: 'side', phone: true, widgets: false },
  { name: 'phone side with widgets', placement: 'side', phone: true, widgets: true },
  { name: 'phone rise', placement: 'rise', phone: true, widgets: false },
  { name: 'corner after font failure', placement: 'corner', phone: false, widgets: false, fontFailure: true },
] as const)("settles Loading on Home's $name frame", async scenario => {
  const { placement, phone, widgets } = scenario;
  const fontFailure = 'fontFailure' in scenario && scenario.fontFailure;
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  let holdFonts = false;
  let releaseFonts: () => void = () => {};
  let rejectFonts: (error: Error) => void = () => {};
  const fonts = new Promise<void>((resolve, reject) => { releaseFonts = resolve; rejectFonts = reject; });
  const layerContext = { setTransform() {}, beginPath() {}, fill() {}, fillText() {},
    arcs: [] as number[][],
    arc(x: number, y: number, r: number) { this.arcs.push([x, y, r]); },
  };
  vi.stubGlobal('document', { documentElement: {},
    createElement: () => {
      // The physical canvas adapter composites its static body from a separate layer.
      const context = { ...layerContext, arcs: [] as number[][] };
      return { getContext: () => context };
    }, fonts: {
    check: () => !holdFonts, load: () => fonts,
  } });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  const pane = { width: 280, height: 240 };
  const hero = { composerTop: 95, aboveBottom: 130, nextTop: widgets ? 350 : null };
  const paints = new Map<string, number[][]>();
  const boxes = new Map<string, { width: number; height: number }>();
  let released = false;
  function Home({ waiting }: { waiting: boolean }) {
    const look = { pane, placement, style: 'balanced' as const, digits: true, theme: 'dark' as const, phone, hero };
    const options = useHomePlanetOptions(look);
    const [drawn, setDrawn] = React.useState(false);
    const onDrawn = React.useCallback(() => setDrawn(true), []);
    const home = React.useMemo(() => ({ waiting, drawn, target: options ? {
      kind: 'planet' as const, options, fade: homePlanetFootFade(look),
    } : null, orientation: { rotate: options?.rotate ?? 0, mirror: false } }), [waiting, drawn, options]);
    const moment = useHomeLoadingMoment({ waiting, home, start: 'mount', paused: false, reducedMotion: false, theme: 'dark', pane });
    if (!moment.hold.held) released = true;
    return <><HomePlanet {...look} hidden={moment.hold.held} leave="fade" reducedMotion={false} onDrawn={onDrawn} />{moment.layer}</>;
  }
  const screen = await renderScreen(<Home waiting />, { createNodeMock: element => {
    if (element.type !== 'canvas') return null;
    const id = String(element.props['data-testid']);
    const { width, height } = element.props;
    if (typeof width !== 'number' || typeof height !== 'number') throw new Error('Canvas backing dimensions are missing');
    boxes.set(id, { width, height });
    const context = { setTransform() {}, clearRect() { paints.set(id, []); }, beginPath() {}, fill() {}, fillText() {},
      arc(x: number, y: number, r: number) { paints.get(id)?.push([x, y, r]); },
      drawImage(layer: { getContext: () => typeof layerContext }) {
        paints.set(id, layer.getContext().arcs.slice());
      },
      measureText: () => ({ actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 12 }),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData() {},
    };
    return { getContext: () => context };
  } });
  try {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await act(async () => { vi.advanceTimersByTime(16); });
    };
    await frames(30);
    await screen.update(<Home waiting={false} />);
    await frames(38); // The travel has begun, but has not landed.
    expect(paints.get('loading-planet.travel')?.length).toBeGreaterThan(0);
    expect(released).toBe(false);
    holdFonts = true;
    await frames(40);
    // The clock finishing is not a painted final frame. Keep the current planet until fonts resolve.
    expect(released).toBe(false);
    expect(screen.findByTestId('loading-planet')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      holdFonts = false;
      if (fontFailure) rejectFonts(new Error('Font request failed'));
      else releaseFonts();
    });
    await frames(2);
    expect(released).toBe(true);
    expect(screen.findByTestId('loading-planet')).toBeNull();
    if (!fontFailure) expect(paints.get('loading-planet.travel')).toEqual(paints.get('home-planet'));
    expect(boxes.get('loading-planet.travel')).toEqual(boxes.get('home-planet'));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    releaseFonts();
    await screen.unmount();
  }
});
