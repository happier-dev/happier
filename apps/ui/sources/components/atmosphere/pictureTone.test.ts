import { describe, expect, it } from 'vitest';
import Color from 'color';
import { DEFAULT_GLASS_TINT_INTENSITY } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { glassContrastRatio, renderGlassOver } from '@/dev/testkit/glassBackdrop';
import { glassPresetMaterials, resolveGlassBackdropMap, resolveGlassReadingCoatOpacity, resolveGlassSurfaceMaterial, type GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';
import { darkTheme, lightTheme } from '@/theme';
import { glassAtmosphereTone, measurePictureColor, measurePictureTone, samePictureTone } from './pictureTone';
import { resolveWallpaperHaze } from './wallpaperHaze';

/** A 100 × 10 picture: a night sky on the left half, a pale sky on the right, the bottom rows dissolved. */
function picture() {
  const w = 100,
    h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      const [r, g, b] = x < 50 ? [20, 26, 40] : [235, 238, 240];
      rgba.set([r, g, b, y >= 8 ? 0 : 255], at);
    }
  }
  return { rgba, w, h };
}

describe('measurePictureTone', () => {
  it('reads the picture only where content sits, seeing a dissolved foot as the page', () => {
    const page = [245, 245, 245] as const;
    const night = measurePictureTone(picture(), page, {
      x0: 0,
      x1: 0.5,
      y0: 0,
      y1: 1,
    })!;
    // The night half is dark, but its dissolved foot (a fifth of it) reads as the light page.
    expect(night.dark).toBeLessThan(0.02);
    expect(night.focus).toBeLessThan(0.02);
    expect(night.light).toBeGreaterThan(0.85);
    const pale = measurePictureTone(picture(), page, {
      x0: 0.5,
      x1: 1,
      y0: 0,
      y1: 0.8,
    })!;
    expect(pale.dark).toBeGreaterThan(0.8);
    const whole = measurePictureTone(picture(), page, {
      x0: 0,
      x1: 1,
      y0: 0,
      y1: 0.8,
    })!;
    expect(whole.dark).toBeLessThan(0.02);
    expect(whole.light).toBeGreaterThan(0.8);
  });
  it('has no tone for an empty region', () => {
    expect(
      measurePictureTone(picture(), [0, 0, 0], {
        x0: 0.4,
        x1: 0.4,
        y0: 0,
        y1: 1,
      }),
    ).toBeUndefined();
  });
});

describe('measurePictureColor', () => {
  it('reads the mean colour of a region, a dissolved foot seen as the page', () => {
    const page = [245, 245, 245] as const;
    const night = Color(measurePictureColor(picture(), page, { x0: 0, x1: 0.5, y0: 0, y1: 0.8 })!).rgb().array();
    expect(night.map(Math.round)).toEqual([20, 26, 40]);
    // Half night, half page: the mean is taken in linear light, so it reads lighter than the sRGB midpoint.
    const half = Color(measurePictureColor(picture(), page, { x0: 0, x1: 0.5, y0: 0.6, y1: 1 })!);
    expect(half.luminosity()).toBeGreaterThan(Color.rgb(132, 135, 142).luminosity());
    expect(measurePictureColor(picture(), page, { x0: 0.4, x1: 0.4, y0: 0, y1: 1 })).toBeUndefined();
  });
});


describe('samePictureTone', () => {
  const tone = { dark: 0.1, light: 0.6, focus: 0.3, ink: 'theme' as const };
  it('treats sub-perceptual measurement jitter as the published tone, so glass is not re-solved', () => {
    expect(samePictureTone({ ...tone, dark: 0.103, light: 0.597, focus: 0.304 }, tone)).toBe(true);
  });
  it('publishes a real change in luminance or ink', () => {
    expect(samePictureTone({ ...tone, light: 0.65 }, tone)).toBe(false);
    expect(samePictureTone({ ...tone, ink: 'page' }, tone)).toBe(false);
    expect(samePictureTone(undefined, tone)).toBe(false);
  });
});

// Owner 2026-11-11 (#04, OWNER-1330-COAT): cards over a picture read as dark slabs. They stand on the Wallpaper haze
// and its veil, which already deepens the column for the head lines; solving them against the raw picture's
// extremes darkened them a second time.
describe('glassAtmosphereTone: cards solve against the haze they stand on', () => {
  type Rgb = [number, number, number];
  const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as Rgb;
  const grey = (luminance: number): Rgb => {
    const value = luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
    return [value * 255, value * 255, value * 255];
  };
  // Relative luminance of each render across the content column (near-darkest, near-lightest) and its middle.
  const pictures: Record<string, { picture: GlassAtmosphereTone; haze: GlassAtmosphereTone }> = {
    bright: { picture: { dark: 0.3, light: 0.88, focus: 0.6 }, haze: { dark: 0.34, light: 0.8, focus: 0.62 } },
    busy: { picture: { dark: 0.01, light: 0.85, focus: 0.2 }, haze: { dark: 0.03, light: 0.45, focus: 0.2 } },
    dark: { picture: { dark: 0.005, light: 0.1, focus: 0.03 }, haze: { dark: 0.008, light: 0.08, focus: 0.03 } },
  };
  for (const theme of [darkTheme, lightTheme]) {
    for (const tint of [DEFAULT_GLASS_TINT_INTENSITY, 50]) {
      // A built-in picture's haze carries an adaptive veil; a person's own picture has the haze alone.
      for (const [name, { picture, haze }] of Object.entries(pictures)) for (const adaptive of [true, false]) {
        it(`${theme.dark ? 'dark' : 'light'}, tint ${tint}, ${name} picture, ${adaptive ? 'veiled' : 'own'} haze: body ink holds 4.5:1 on the card, which is no darker than that needs`, () => {
          const { veil } = resolveWallpaperHaze({
            heads: { ...picture, focus: haze.focus }, adaptive, page: theme.colors.surface.base,
            primary: theme.colors.text.primary, secondary: theme.colors.text.secondary,
            column: { x: 0.3, y: 0.5 }, at: { x: 0.5, y: 0.5 },
          });
          // What a card's glass sees at its worst: the haze's extreme against the theme's ink, under the veil and the
          // page's reading coat.
          const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: tint };
          const extreme = grey(theme.dark ? haze.light : haze.dark);
          const veiled = (veil ? Color.rgb(extreme).mix(Color(veil.color), veil.alpha).rgb().array() : extreme) as Rgb;
          const coat = resolveGlassReadingCoatOpacity(settings, { atmosphereBehind: 'wallpaper' }, theme.dark);
          const page = rgb(theme.colors.surface.base);
          const backdrop = veiled.map((value, channel) => page[channel]! * coat + value * (1 - coat)) as Rgb;
          const ground = { page: theme.colors.surface.base, solid: theme.colors.edge.cardFill, ink: theme.colors.text.primary, controlFill: theme.colors.surface.selected };
          const card = (atmosphereTone: GlassAtmosphereTone | undefined) => {
            const environment = { atmosphereBehind: 'wallpaper', atmosphereTone } as const;
            const map = resolveGlassBackdropMap(settings, 'card', theme.dark, environment, ground)!;
            const opacity = map.opacity ?? resolveGlassSurfaceMaterial(settings, 'card', environment).material.opacity;
            return renderGlassOver({ filter: map.tone, coat: rgb(map.coat!), opacity, backdrop });
          };
          const solved = card(glassAtmosphereTone(picture, haze, veil));
          const ink = rgb(theme.colors.text.primary);
          expect(glassContrastRatio(solved, ink)).toBeGreaterThanOrEqual(4.5);
          // Where the raw picture's extreme forced the card below its material's own coat, the card was darkened
          // (dark) or washed (light) further than the backdrop it stands on requires.
          const own = card(undefined);
          const overRawPicture = card({ dark: Math.min(picture.dark, haze.dark), light: Math.max(picture.light, haze.light), focus: haze.focus });
          const rawForced = overRawPicture.some((value, channel) => Math.abs(value - own[channel]!) > 1);
          if (rawForced) expect(glassContrastRatio(solved, ink)).toBeLessThan(glassContrastRatio(overRawPicture, ink) - 0.05);
          else solved.forEach((value, channel) => expect(Math.abs(value - own[channel]!)).toBeLessThanOrEqual(1));
        });
      }
    }
  }
});
