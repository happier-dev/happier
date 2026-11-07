import { describe, expect, it } from 'vitest';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';

import {
  homeOrbitBotPoint,
  isHomeOrbitBotBehindPlanet,
  layoutHomeOrbitBots,
  layoutHomeOrbitRing,
  layoutHomeOrbitScene,
  placeOrbitMoonLabel,
  type HomeOrbitBody,
} from './homeOrbitScene';

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

describe('Home Bot moons (lab R6 "Bots orbit Home")', () => {
  // Home's Corner planet (1100 x 940 pane): its centre sits near the right edge, so half of each lane is off the page.
  const area = { width: 1100, height: 940 };
  const corner = { px: 1020, py: 160, pr: 320 };
  const restingPoints = (planet: { px: number; py: number; pr: number }, count: number) =>
    layoutHomeOrbitBots(
      area,
      planet,
      Array.from({ length: count }, (_, index) => ({ key: `bot-${index}`, activity: 'quiet' as const })),
    ).bots!.moons.map((moon) => ({ moon, point: homeOrbitBotPoint(planet.px, planet.py, moon.orbit, moon.angle) }));

  it('rests every quiet moon where it can be seen, even when the planet stands in a corner', () => {
    for (const count of [1, 3, 6]) {
      for (const { moon, point } of restingPoints(corner, count)) {
        const half = moon.size / 2;
        expect(point.x).toBeGreaterThanOrEqual(half);
        expect(point.x).toBeLessThanOrEqual(area.width - half);
        expect(point.y).toBeGreaterThanOrEqual(half);
        expect(point.y).toBeLessThanOrEqual(area.height - half);
        expect(isHomeOrbitBotBehindPlanet(corner.px, corner.py, corner.pr, point)).toBe(false);
      }
    }
  });

  it('keeps resting and waiting moons clear of the hero content they would block (the headline and composer)', () => {
    const bots = [
      ...Array.from({ length: 3 }, (_, index) => ({ key: `bot-${index}`, activity: 'quiet' as const })),
      { key: 'waits', activity: 'needsYou' as const },
    ];
    const box = (moon: { size: number }, at: { x: number; y: number }) =>
      ({ x: at.x - moon.size / 2, y: at.y - moon.size / 2, width: moon.size, height: moon.size });
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const where = (scene: ReturnType<typeof layoutHomeOrbitBots>) => scene.bots!.moons.map((moon) =>
      box(moon, moon.park ?? homeOrbitBotPoint(corner.px, corner.py, moon.orbit, moon.angle)));
    // Hero content laid over the places the moons take without it (BT-QA1 F1: a moon resting on the composer).
    const keepOut = where(layoutHomeOrbitBots(area, corner, bots)).map((moon) =>
      ({ x: moon.x - 40, y: moon.y - 20, width: moon.width + 80, height: moon.height + 40 }));
    const scene = layoutHomeOrbitBots(area, corner, bots, { keepOut });
    expect(scene.bots!.moons).toHaveLength(bots.length);
    for (const moon of where(scene)) {
      for (const content of keepOut) expect(overlaps(moon, content)).toBe(false);
      expect(moon.x).toBeGreaterThanOrEqual(0);
      expect(moon.y).toBeGreaterThanOrEqual(0);
      expect(moon.x + moon.width).toBeLessThanOrEqual(area.width);
      expect(moon.y + moon.height).toBeLessThanOrEqual(area.height);
    }
  });

  // Voice 13:33Z: a waiting moon's face rested just above the greeting line, and its name, drawn under
  // the face, sat over the headline and Brief me. The name is part of where the moon stands.
  it("keeps a waiting moon's name clear of the hero content too, not only its face", () => {
    const bots = [{ key: 'waits', activity: 'needsYou' as const }];
    const LABEL_LINE_PX = HAPPIER_TYPE_SCALE.meta.lineHeight;
    const first = layoutHomeOrbitBots(area, corner, bots).bots!.moons[0]!;
    expect(first.park).not.toBeNull();
    // The greeting row starts just under the face, where only the name reaches.
    const faceBottom = first.park!.y + first.size / 2;
    const headlineRow = { x: first.park!.x - 200, y: faceBottom + 4, width: 400, height: 40 };
    const moon = layoutHomeOrbitBots(area, corner, bots, { keepOut: [headlineRow] }).bots!.moons[0]!;
    expect(moon.park).not.toBeNull();
    const name = {
      x: moon.park!.x - moon.labelWidth / 2,
      y: moon.park!.y + moon.size / 2,
      width: moon.labelWidth,
      height: LABEL_LINE_PX + 4,
    };
    const crosses = name.x < headlineRow.x + headlineRow.width && headlineRow.x < name.x + name.width
      && name.y < headlineRow.y + headlineRow.height && headlineRow.y < name.y + name.height;
    expect(moon.labelWidth).toBeGreaterThan(0);
    expect(crosses).toBe(false);
  });

  // Owner 11-06: 50 Bots piled up in the hero with their names over each other. The hero shows the Bots
  // that fit, names that never overlap, and counts the rest for one "+N".
  it('shows the Bots that fit with names that never overlap, and counts the rest (50 Bots on a phone)', () => {
    const phone = { width: 390, height: 420 };
    const planet = { px: 330, py: 90, pr: 120 };
    const LABEL_LINE_PX = HAPPIER_TYPE_SCALE.meta.lineHeight;
    for (const activity of ['needsYou', 'working', 'quiet'] as const) {
      const bots = Array.from({ length: 50 }, (_, index) => ({ key: `bot-${index}`, activity }));
      const scene = layoutHomeOrbitBots(phone, planet, bots, { moonSize: 24, parkedSize: 34 });
      const moons = scene.bots!.moons;
      // One "+N" stands for the Bots with no room.
      const more = scene.bots!.more;
      expect(moons.length + (more?.count ?? 0), activity).toBe(50);
      expect(more?.count ?? 0, activity).toBeGreaterThan(0);
      // A few moons: they fold to four and "+N", as Home's Machine moons do (Store S1).
      expect(moons.length, activity).toBeLessThanOrEqual(4);
      const at = moons.map((moon) => ({ moon, point: moon.park ?? homeOrbitBotPoint(planet.px, planet.py, moon.orbit, moon.angle) }));
      at.forEach(({ moon, point }, index) => {
        expect(point.x - moon.size / 2, moon.key).toBeGreaterThanOrEqual(0);
        expect(point.x + moon.size / 2, moon.key).toBeLessThanOrEqual(phone.width);
        expect(point.y - moon.size / 2, moon.key).toBeGreaterThanOrEqual(0);
        expect(point.y + moon.size / 2, moon.key).toBeLessThanOrEqual(phone.height);
        for (const other of at.slice(index + 1)) {
          if (moon.park && other.moon.park) {
            expect(Math.hypot(point.x - other.point.x, point.y - other.point.y), `${moon.key}/${other.moon.key}`)
              .toBeGreaterThanOrEqual(moon.size);
          }
          if (moon.labelWidth > 0 && other.moon.labelWidth > 0
            && Math.abs(point.y + moon.size / 2 - (other.point.y + other.moon.size / 2)) < LABEL_LINE_PX) {
            expect(Math.abs(point.x - other.point.x), `${moon.key}/${other.moon.key} names`)
              .toBeGreaterThanOrEqual((moon.labelWidth + other.moon.labelWidth) / 2);
          }
        }
      });
      // Only a moon that rests where it stays is named: one in orbit would cross its neighbours' names.
      for (const moon of moons) expect(moon.labelWidth > 0, moon.key).toBe(moon.park !== null);
    }
  });

  it("keeps the lab's resting angles around a planet the page shows whole", () => {
    const centred = { px: 550, py: 470, pr: 140 };
    expect(restingPoints(centred, 3).map(({ moon }) => moon.angle)).toEqual([0.5, 3.75, 2.4]);
  });
});
