import { describe, expect, it } from 'vitest';
import {
  HOME_HERO_FULL_PANE_HEIGHT,
  homeAtmosphereSeam,
  homeHeroTop,
  homeHorizonBand,
  homeRiseFoot,
  homeRiseFootFade,
} from './homePlanetPlacement';

it('keeps the desktop hero seam at its full-pane height on a tall window', () => {
  expect(homeAtmosphereSeam(HOME_HERO_FULL_PANE_HEIGHT, false)).toBe(homeAtmosphereSeam(2400, false));
  expect(homeAtmosphereSeam(HOME_HERO_FULL_PANE_HEIGHT - 100, false)).toBeLessThan(homeAtmosphereSeam(2400, false));
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
      homeHorizonBand({ headlineTop: 334, headlineBottom: 378, composerBottom: 506, phone: false }),
    ).toEqual({ band: 534, horizonAt: 0.491 });
    expect(
      homeHorizonBand({ headlineTop: 60, headlineBottom: 104, composerBottom: 506, phone: false })
        .horizonAt,
    ).toBe(0.3);
    expect(
      homeHorizonBand({ headlineTop: 200, headlineBottom: 236, composerBottom: 300, phone: true }),
    ).toEqual({ band: 320, horizonAt: 0.5 });
    // Without the composer in the hero, the band ends the same step under the headline.
    expect(
      homeHorizonBand({ headlineTop: 334, headlineBottom: 378, composerBottom: null, phone: false }),
    ).toEqual({ band: 406, horizonAt: 0.645 });
  });
  it('ends a Rise hero so the first section stands just above the fold, never cutting the foot fade short', () => {
    // Lab at4-planet-rise: "Your Home" stands just above the fold of an 852 px pane.
    expect(homeRiseFoot({ paneHeight: 852, aboveBottom: 560 })).toBe(852 - 560 - 100);
    // A tall hero keeps the whole ordered fade (130 px) rather than reaching the fold.
    expect(homeRiseFoot({ paneHeight: 852, aboveBottom: 760 })).toBe(140);
    // A short hero on a tall window stops at the lab's 200 px foot instead of filling the window.
    expect(homeRiseFoot({ paneHeight: 1600, aboveBottom: 500 })).toBe(252);
  });
  it("ends the ordered planet fade 14 pixels above the next section", () => {
    expect(
      homeRiseFootFade({ aboveBottom: 560, nextTop: 760, phone: false }),
    ).toEqual({ from: 616, to: 746 });
    expect(
      homeRiseFootFade({ aboveBottom: 700, nextTop: 760, phone: false }),
    ).toEqual({ from: 704, to: 746 });
    expect(
      homeRiseFootFade({ aboveBottom: 500, nextTop: 760, phone: true }),
    ).toEqual({ from: 656, to: 746 });
  });
});
