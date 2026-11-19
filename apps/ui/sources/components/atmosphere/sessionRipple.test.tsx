import { expect, it } from 'vitest';
import { glyphFrame, planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { sessionRippleLayer } from './sessionRipple';

it('types the ring over a planet with Digits off, then returns to the exact resting frame', () => {
  const view = { w: 390, h: 844 };
  const geometry = horizonPlanetGeometry({ width: view.w, height: view.h }, { phone: true, composerTop: 270 });
  const options = { geometry, intensity: 'quiet', digits: false } as const;
  const input = { width: view.w, theme: 'dark', reducedMotion: false } as const;
  const paint = (layer: ReturnType<typeof planetGlyphLayer>) => glyphFrame({ view, dpr: 1, theme: input.theme, layers: [layer] });
  const rest = paint(planetGlyphLayer(options));
  expect(paint(sessionRippleLayer(options, 560, input)).sprites.glyph.length).toBeGreaterThan(0);
  expect(paint(sessionRippleLayer(options, 1600, input))).toEqual(rest);
  expect(paint(sessionRippleLayer(options, 75, { ...input, reducedMotion: true })).sprites).toEqual(rest.sprites);
});
