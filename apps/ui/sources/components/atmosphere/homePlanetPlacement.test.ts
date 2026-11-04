import { describe, expect, it } from 'vitest';
import {
  homeAtmosphereSeam,
  homeHeroTop,
  homeHorizonBand,
  homePlanetGeometry,
  homePlanetSceneOptions,
  homeRiseFootFade,
  homeRiseLimb,
} from './homePlanetPlacement';

const desk = { width: 1100, height: 852 };
const phone = { width: 390, height: 760 };
const sides = (top: number, right: number, bottom: number, left: number) => ({
  top,
  right,
  bottom,
  left,
});

describe('Home planet placement (plan §4.3, lab geom())', () => {
  it('places each desktop placement from the pane', () => {
    const H = desk.height,
      W = desk.width;
    expect(homePlanetGeometry('corner', desk)).toMatchObject({
      R: 0.34 * H,
      cx: W - 0.25 * 0.34 * H,
      cy: 0.5 * 0.34 * H,
      rotate: -1.5,
      halo: sides(1, 1, 0.8, 1),
      reach: sides(3.2, 3.2, 2.7, 2.7),
    });
    expect(homePlanetGeometry('side', desk)).toMatchObject({
      R: 0.3 * H,
      cx: W + 0.4 * 0.3 * H,
      cy: 0.33 * H,
      rotate: -1,
      halo: sides(1.4, 1, 0.8, 0.8),
      reach: sides(3.2, 3.2, 2.5, 2.5),
    });
    expect(homePlanetGeometry('side', desk, { widgets: false })).toMatchObject({
      R: 0.38 * H,
      cx: W + 0.5 * 0.38 * H,
      cy: 0.5 * H,
      halo: sides(1.4, 1, 1.4, 0.8),
      reach: sides(3.2, 3.2, 3.2, 2.5),
    });
    expect(homePlanetGeometry('rise', desk, { limb: 420 })).toMatchObject({
      R: 0.8 * W,
      cx: 0.5 * W,
      cy: 420 + 0.8 * W,
      rotate: -1.5,
      halo: sides(0, 0.7, 1, 0.7),
      reach: sides(1.03, 2.1, 1.2, 2.1),
      around: 1,
    });
  });
  it('uses the phone placements', () => {
    const W = phone.width,
      H = phone.height;
    expect(homePlanetGeometry('corner', phone, { phone: true })).toMatchObject({
      R: 0.38 * W,
      cx: W - 0.36 * 0.38 * W,
      cy: 0.38 * (0.38 * W),
      halo: sides(1, 1, 0.6, 1),
      reach: sides(3.2, 3.2, 1.9, 2.7),
    });
    expect(homePlanetGeometry('side', phone, { phone: true })).toMatchObject({
      R: 0.36 * W,
      cx: W + 0.3 * 0.36 * W,
      cy: 0.13 * H,
      halo: sides(1.2, 1, 0.5, 0.7),
      reach: sides(3.2, 3.2, 2, 2.2),
    });
    expect(
      homePlanetGeometry('side', phone, { phone: true, widgets: false }),
    ).toMatchObject({
      R: 0.5 * W,
      cy: 0.6 * H,
      halo: sides(1.2, 1, 1.2, 0.7),
      reach: sides(3.2, 3.2, 3, 2.2),
    });
  });
  it('carries the Home digit field, or none with digits off', () => {
    const geometry = homePlanetGeometry('corner', desk);
    expect(
      homePlanetSceneOptions(geometry, desk, {
        theme: 'light',
        style: 'balanced',
        digits: true,
      }),
    ).toMatchObject({
      view: { w: desk.width, h: desk.height },
      tail: 1.6,
      fullness: 1,
      style: 'balanced',
      field: {
        around: 1,
        fall: 0.8,
        ink: 1.15,
        start: 0.3,
        ramp: 0.6,
        over: 0.62,
        overStyle: 'ink',
        reach: geometry.reach,
      },
    });
    expect(
      homePlanetSceneOptions(geometry, desk, {
        theme: 'dark',
        style: 'rich',
        digits: true,
      }).field,
    ).toMatchObject({ ink: 0.8 });
    expect(
      homePlanetSceneOptions(geometry, desk, {
        theme: 'dark',
        style: 'airy',
        digits: false,
      }).field,
    ).toEqual({ around: 0, over: 0 });
  });
});

describe('Home planet placement against the lab\'s measured shots (at2-metrics.json, at4-planet-*)', () => {
  // The lab records each painted planet rounded to the pixel; the product must land on the same pixels.
  const rounded = (g: { R: number; cx: number; cy: number }) => ({ R: Math.round(g.R), cx: Math.round(g.cx), cy: Math.round(g.cy) });
  const pane = { width: 1096, height: 852 };
  it('matches Corner, Side and Rise at the 1440 × 900 window', () => {
    expect(rounded(homePlanetGeometry('corner', pane))).toEqual({ R: 290, cx: 1024, cy: 145 });
    expect(rounded(homePlanetGeometry('side', pane))).toEqual({ R: 256, cx: 1198, cy: 281 });
    // Composer at 388, the widgets' header at 802 (200 px lower under Rise).
    expect(rounded(homePlanetGeometry('rise', pane, { limb: homeRiseLimb(388) }))).toEqual({ R: 877, cx: 548, cy: 1275 });
    expect(homeRiseFootFade({ aboveBottom: 538, nextTop: 802, phone: false })).toEqual({ from: 666, to: 796 });
  });
  it('matches the phone Corner and Rise at 390 × 844', () => {
    const phone = { width: 390, height: 844 };
    expect(rounded(homePlanetGeometry('corner', phone, { phone: true }))).toEqual({ R: 148, cx: 337, cy: 56 });
    expect(rounded(homePlanetGeometry('rise', phone, { phone: true, limb: homeRiseLimb(257) }))).toEqual({ R: 507, cx: 195, cy: 774 });
  });
});

describe('Home hero top', () => {
  it('stands the greeting on the seam only when the composer straddles it', () => {
    const seam = homeAtmosphereSeam(892, false);
    expect(homeHeroTop({ paneHeight: 892, phone: false, composer: true })).toBe(seam - 92);
    // With nothing to straddle the seam, the greeting does not hold real work under the fold.
    const bare = homeHeroTop({ paneHeight: 892, phone: false, composer: false });
    expect(bare).toBeLessThan(seam / 2);
    expect(homeHeroTop({ paneHeight: 1400, phone: false, composer: false })).toBe(bare);
  });

  it('never makes a short pane lower a bare greeting than the composer hero would, and clears the phone bar', () => {
    expect(homeHeroTop({ paneHeight: 260, phone: false, composer: false }))
      .toBeLessThanOrEqual(homeHeroTop({ paneHeight: 260, phone: false, composer: true }));
    expect(homeHeroTop({ paneHeight: 760, phone: true, composer: false })).toBeGreaterThanOrEqual(44);
  });
});

describe('Home atmosphere rhythm (lab layout())', () => {
  it('clamps the desktop seam and puts the phone seam at a third', () => {
    expect(homeAtmosphereSeam(300, false)).toBe(220);
    expect(homeAtmosphereSeam(852, false)).toBe(426);
    expect(homeAtmosphereSeam(1400, false)).toBe(500);
    expect(homeAtmosphereSeam(760, true)).toBe(253);
  });
  it('ends the band below the composer and sets the horizon above the headline, clamped', () => {
    expect(
      homeHorizonBand({ headlineTop: 334, composerBottom: 506, seam: 426, phone: false }),
    ).toEqual({ band: 534, horizonAt: 0.491 });
    expect(
      homeHorizonBand({ headlineTop: 60, composerBottom: 506, seam: 426, phone: false })
        .horizonAt,
    ).toBe(0.3);
    expect(
      homeHorizonBand({ headlineTop: 200, composerBottom: 300, seam: 253, phone: true }),
    ).toEqual({ band: 320, horizonAt: 0.5 });
    // Without the composer in the hero, the band is the seam.
    expect(
      homeHorizonBand({ headlineTop: 334, composerBottom: null, seam: 426, phone: false }),
    ).toEqual({ band: 426, horizonAt: 0.615 });
  });
  it("puts Rise's limb under the composer top and fades its body before the widgets", () => {
    expect(homeRiseLimb(390)).toBe(400);
    expect(
      homeRiseFootFade({ aboveBottom: 560, nextTop: 760, phone: false }),
    ).toEqual({ from: 624, to: 754 });
    expect(
      homeRiseFootFade({ aboveBottom: 700, nextTop: 760, phone: false }),
    ).toEqual({ from: 704, to: 754 });
    expect(
      homeRiseFootFade({ aboveBottom: 500, nextTop: 760, phone: true }),
    ).toEqual({ from: 664, to: 754 });
  });
});
