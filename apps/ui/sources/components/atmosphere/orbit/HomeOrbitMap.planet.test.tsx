import * as React from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { expect, it, vi } from 'vitest';
import { glyphFrame, planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { HomeOrbitMap } from './HomeOrbitMap';
import { layoutHomeOrbitRing, layoutHomeOrbitScene } from './homeOrbitScene';

const paint = vi.hoisted(() => ({
  images: [] as Uint8Array[],
  pictures: 0,
}));

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'android' }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@shopify/react-native-skia', async () =>
  (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock({
    onImage: (_info, bytes) => paint.images.push(bytes.slice()),
    onPicture: () => { paint.pictures++; },
  }),
);
// The native worker cannot rasterize fonts in the Node runner; leave the scene and painter real.
vi.mock('../glyph/glyphAtlas.native', async () => ({
  glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));

it.each([
  ['machine orbits', layoutHomeOrbitScene(310, 200, [{ key: 'dev', online: true, dots: [] }], { px: 138, py: 83, pr: 34 })],
  ['MCP ring', layoutHomeOrbitRing(310, 200, [{ key: 'mcp', tether: 'account' }], { px: 138, py: 83, pr: 34 })],
] as const)('paints the shared static Horizon planet at the centre of %s', async (_name, scene) => {
  paint.images.length = 0;
  paint.pictures = 0;
  const screen = await renderScreen(<HomeOrbitMap scene={scene} accessibilityLabel="Orbits" />);
  const size = scene.canvas!.size;
  const geometry = horizonPlanetGeometry({ width: size, height: size }, { radius: scene.pr, limb: size / 2 - scene.pr });
  const body = glyphFrame({ view: { w: size, h: size }, dpr: PixelRatio.get(), theme: 'light',
    layers: [planetGlyphLayer({ geometry, intensity: 'quiet', digits: false })] }).body;
  expect(body?.rgba.some((channel, index) => index % 4 === 3 && channel > 0)).toBe(true);
  await vi.waitFor(() => {
    expect(paint.images.some(image => image.length === body!.rgba.length && image.every((value, index) => value === body!.rgba[index]))).toBe(true);
  });
  const [canvas] = screen.findAll(node => node.type === 'Canvas');
  expect(StyleSheet.flatten(canvas?.props.style)).toMatchObject({ left: scene.px - size / 2, top: scene.py - size / 2 });
  const pictures = paint.pictures;
  expect(pictures).toBeGreaterThan(0);
  await screen.update(<HomeOrbitMap scene={scene} highlightKeys={new Set(['dev'])} accessibilityLabel="Orbits" />);
  expect(paint.pictures).toBe(pictures);
  await screen.unmount();
});
