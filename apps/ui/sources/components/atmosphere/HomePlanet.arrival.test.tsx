import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HomePlanet } from './HomePlanet';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The web layer owns the arrival fade; the Skia planet stands in for the drawing (its picture is the boundary).
vi.mock('./AtmosphereDissolve', async () => import('./AtmosphereDissolve.web'));
vi.mock('./glyph/glyphAtlas.native', async () => ({
  glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));
vi.mock('@shopify/react-native-skia', async () =>
  (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock(),
);

beforeEach(() => {
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('document', { documentElement: {}, fonts: { load: async () => [] }, visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

it('a return to Home shows the planet at once; only a moment that hands over to it fades it in, once', async () => {
  // Web Animations is the platform boundary: count the arrival fades the planet layer asks for. A fade
  // replayed on every Home return kept a pane-sized compositing surface per visit that WebKit never
  // returned, ~190 MB per 12 visits on desktop (P03-DESKTOP-MEMORY-3).
  const arrivals: number[] = [];
  const node = () => ({
    style: {} as Record<string, string>,
    getAnimations: () => [],
    animate: (frames: Array<{ opacity?: number }>, timing: KeyframeAnimationOptions) => {
      if (frames[0]?.opacity === 0 && timing.duration === motionTokens.atmosphere.readyFadeMs) arrivals.push(1);
      return {};
    },
  });
  const planet = (hidden: boolean) => (
    <HomePlanet pane={{ width: 280, height: 240 }} intensity="calm" digits={false} theme="dark"
      phone={false} hero={null} hidden={hidden} arrive="fade" leave="fade" reducedMotion={false} />
  );
  for (let visit = 0; visit < 3; visit++) {
    const screen = await renderScreen(planet(false), { createNodeMock: node });
    await screen.unmount();
  }
  expect(arrivals).toHaveLength(0);
  // A moment holds the planet hidden, then hands over to it.
  const screen = await renderScreen(planet(true), { createNodeMock: node });
  await screen.update(planet(false));
  await vi.waitFor(() => expect(arrivals).toHaveLength(1));
  await screen.unmount();
});
