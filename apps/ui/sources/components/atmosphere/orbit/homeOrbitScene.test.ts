import { describe, expect, it } from 'vitest';

import { layoutHomeOrbitRing, layoutHomeOrbitScene, placeOrbitMoonLabel, type HomeOrbitBody } from './homeOrbitScene';

const body = (
  key: string,
  online: boolean,
  tones: readonly HomeOrbitBody['dots'][number]['tone'][] = [],
): HomeOrbitBody => ({
  key,
  online,
  dots: tones.map((tone, index) => ({ key: `${key}-${index}`, tone })),
});

describe('Home orbit scene (lab at-widget.js scene())', () => {
  it('places moons on their orbits and trails dots behind them, dimming offline orbits', () => {
    const scene = layoutHomeOrbitScene(
      262,
      196,
      [body('mbp', true, ['active', 'attention']), body('win', false)],
      {
        pr: 40,
        radii: [1.55, 1.97, 2.4].map((k) => k * 40),
        angles: [-38, 214, 128],
      },
    );
    expect(scene.orbits).toEqual([
      { r: 62, off: false },
      { r: 79, off: true },
    ]);
    expect(scene.moons[0]!.x).toBeCloseTo(
      131 + Math.cos((-38 * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.moons.map((moon) => [moon.key, moon.off])).toEqual([
      ['mbp', false],
      ['win', true],
    ]);
    // Dots carry their body and tone, so a preview can light one skill's dots on every machine.
    expect(scene.dots.map((dot) => [dot.bodyKey, dot.key, dot.tone])).toEqual([
      ['mbp', 'mbp-0', 'active'],
      ['mbp', 'mbp-1', 'attention'],
    ]);
    // The first dot trails 11 px of arc behind its moon (counter-clockwise on the right side).
    const angle = -38 - (11 / 62) * (180 / Math.PI);
    expect(scene.dots[0]!.x).toBeCloseTo(
      131 + Math.cos((angle * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.canvas).toEqual({ left: 131 - 84, top: 98 - 84, size: 168 });
  });

  it('draws an offline body’s last-known dots when the caller supplies them', () => {
    const scene = layoutHomeOrbitScene(
      300,
      300,
      [body('win', false, ['quiet', 'quiet'])],
      { pr: 40, dotGap: 8.6 },
    );
    expect(scene.dots.map((dot) => dot.bodyKey)).toEqual(['win', 'win']);
  });

  it('draws two quiet orbits around an empty Home', () => {
    const scene = layoutHomeOrbitScene(262, 120, [], { pr: 18, small: true });
    expect(scene.orbits).toEqual([
      { r: 35, off: true },
      { r: 62, off: true },
    ]);
    expect(scene.moons).toEqual([]);
  });

  it('past the orbit count, bodies share the outer orbit (drawn once) and spread evenly', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((key) => body(key, true));
    const scene = layoutHomeOrbitScene(300, 300, five, {
      pr: 40,
      radii: [62, 79, 96],
      angles: [-38, 214, 128],
    });
    expect(scene.orbits.map((orbit) => orbit.r)).toEqual([62, 79, 96]);
    const outer = scene.moons
      .slice(2)
      .map((moon) =>
        Math.round(
          (Math.atan2(moon.y - scene.py, moon.x - scene.px) * 180) / Math.PI,
        ),
      );
    expect(outer).toEqual([128, -112, 8]);
  });
});

describe('Home orbit ring (lab hm-A tetherMap)', () => {
  it('spaces N marks evenly from the top and keeps every mark outside the planet glow', () => {
    const marks = ['a', 'b', 'c', 'd'].map((key) => ({ key, tether: 'account' as const }));
    const scene = layoutHomeOrbitRing(300, 268, marks, { pr: 36, r: 60 });
    const ring = scene.ring!;
    expect(ring.marks.map((mark) => mark.key)).toEqual(['a', 'b', 'c', 'd']);
    // The top first, then a quarter turn each.
    expect(ring.marks[0]!.x).toBeCloseTo(150, 6);
    expect(ring.marks[0]!.y).toBeLessThan(134);
    expect(ring.marks[1]!.x).toBeGreaterThan(150);
    expect(ring.marks[1]!.y).toBeCloseTo(134, 6);
    expect(ring.marks[2]!.x).toBeCloseTo(150, 6);
    expect(ring.marks[2]!.y).toBeGreaterThan(134);
    expect(ring.marks[3]!.x).toBeLessThan(150);
    expect(ring.marks[3]!.y).toBeCloseTo(134, 6);
    // r 60 would put marks inside the glow (2.1 × 36 = 75.6): the ring grows past it.
    for (const mark of ring.marks) {
      const distance = Math.hypot(mark.x - scene.px, mark.y - scene.py);
      expect(distance - ring.markSize / 2).toBeGreaterThan(36 * 2.1);
    }
    expect(scene.moons).toEqual([]);
    expect(scene.orbits).toEqual([{ r: ring.r, off: false }]);
  });

});

describe('Home orbit moon labels', () => {
  it("keeps a moon's name off the planet and keeps a same-name suffix whole when the name must shorten", () => {
    // A phone map: planet at the centre, a moon just right of it on the planet's row.
    const planet = { width: 358, px: 179, py: 100, pr: 34 };
    const moon = { x: 223, y: 92, r: 5 };
    const placed = placeOrbitMoonLabel(moon, 'NLDW6-3-11-20 · 0371', planet, 12);
    // The left side would run across the planet, so the name stays after the moon and shortens.
    expect(placed.textAnchor).toBe('start');
    expect(placed.text.endsWith(' · 0371')).toBe(true);
    expect(placed.text).toContain('…');
    // A moon well above the planet may still take the roomier side before it.
    const high = placeOrbitMoonLabel({ x: 330, y: 10, r: 5 }, 'NLDW6-3-11-20 · 0371', planet, 12);
    expect(high).toEqual({ x: 319, textAnchor: 'end', text: 'NLDW6-3-11-20 · 0371' });
  });
});
