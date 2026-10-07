import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as planet from './planet.mjs';
const { createPlanetFrame, planetFrameIntervalMs, planetRowsForColumns } = planet;

// Independently measured from PR #463, head a83d311b63f8ba5e1bba7f637fee5a90a61ed1b3.
// These cover eclipse, settled shading, the light theme and dimming, including RGB + 2x4 projection.
test('planet frames retain the approved upstream golden vectors', () => {
  for (const [options, expected] of [
    [{ columns: 24, seconds: 0.25 }, 'a3005308bb669573129624997c5328eef2c8ab6cc03da0d2f1776ac93179a2f3'],
    [{ columns: 24, seconds: 8 }, '150598003fa19157bc3379c3aa185fa5aab2a9c05a3ad057c5e1cc9428a18d28'],
    [{ columns: 24, seconds: 8, theme: 'light' }, 'bac395fdbec358ac3587065f0b6dd805b2aa1d588c017bf827cd5228fd749fe5'],
    [{ columns: 24, seconds: 8, dim: 1 }, '0afc923ab467dad23f7db3b7a53619f3d2d9352af18535f973d310703c044827'],
  ]) {
    assert.equal(createHash('sha256').update(JSON.stringify(createPlanetFrame(options))).digest('hex'), expected);
  }
});

test('static and continuing renders keep geometry while intro, theme and dim change shading', () => {
  const staticFrame = createPlanetFrame({ columns: 24 });
  assert.equal(staticFrame.length, planetRowsForColumns(24));
  assert.ok(staticFrame.flat().some(Boolean));
  assert.ok(staticFrame.every((row) => row.length === 24));
  assert.deepEqual(createPlanetFrame({ columns: 24, seconds: 8 }), createPlanetFrame({ columns: 24, seconds: 8 }));
  assert.ok(createPlanetFrame({ columns: 24, seconds: 0, intro: false }).flat().filter(Boolean).length
    > createPlanetFrame({ columns: 24, seconds: 0 }).flat().filter(Boolean).length);
  assert.equal(planetFrameIntervalMs(5.9), 66);
  assert.equal(planetFrameIntervalMs(6), 200);
});

test('approved mark tiers retain legible mic samples and exact deterministic morph endpoints', () => {
  for (const [size, columns, rows, count] of [[16, 7, 9, 28], [20, 7, 9, 28], [24, 9, 11, 50], [32, 11, 14, 62], [48, 15, 19, 105]]) {
    const tier = planet.planetMarkTier(size);
    assert.equal(tier.columns, columns);
    assert.equal(tier.rows, rows);
    const mic = planet.createMicDots({ size });
    assert.equal(mic.length, count);
    const dots = planet.createPlanetDots({ size });
    const pairs = planet.createPlanetDotCorrespondence({ size });
    assert.deepEqual(pairs.map((pair) => pair.planet), dots);
    assert.deepEqual(pairs, planet.createPlanetDotCorrespondence({ size }));
    const visibleMic = pairs.filter((pair) => pair.mic.opacity > 0).map((pair) => pair.mic);
    assert.equal(visibleMic.length, count);
    assert.deepEqual(visibleMic.sort((a, b) => a.id - b.id), mic);
    assert.equal(new Set(pairs.map((pair) => pair.id)).size, dots.length);
    assert.ok(dots.some((dot) => dot.opacity > 0));
    assert.ok(dots.every((dot) => dot.x >= 0 && dot.x <= size && dot.y >= 0 && dot.y <= size));
  }
});

test('planet poses and atmosphere depend on explicit light and energy, without time or randomness', () => {
  const ready = planet.createPlanetDots({ size: 48 });
  const shadow = planet.createPlanetDots({ size: 48, pose: 'shadow' });
  const shade = planet.createPlanetDots({ size: 48, pose: 'shade' });
  const light = planet.createPlanetDots({ size: 48, theme: 'light' });
  assert.deepEqual(ready, planet.createPlanetDots({ size: 48, energy: 0 }));
  assert.notDeepEqual(ready, shadow);
  assert.notDeepEqual(shadow, shade);
  assert.notDeepEqual(ready, light);
  assert.notDeepEqual(ready, planet.createPlanetDots({ size: 48, energy: 1 }));
  assert.deepEqual(ready, planet.createPlanetDots({ size: 48, energy: NaN }));
  assert.deepEqual(ready.map((dot) => dot.id), shadow.map((dot) => dot.id));
  assert.notDeepEqual(ready, planet.createPlanetDots({ size: 48, light: [-1, 0, 1] }));
});

test('retargeted mark shading preserves the displayed light at every audio sample and during regather', () => {
  const from = planet.createPlanetMarkGeometry({ size: 48, light: planet.planetLightForProgress(0.1) });
  const to = planet.createPlanetMarkGeometry({ size: 48, light: planet.planetLightForProgress(0.8) });
  const next = planet.createPlanetMarkGeometry({ size: 48, light: planet.planetLightForProgress(0.4) });
  const displayed = planet.interpolatePlanetMarkGeometry(to, from, 0.37);
  const frame = (target, start, progress, morph, energy) => {
    const dots = [];
    planet.drawPlanetMarkFrame(target, start, morph, progress, energy, 1, (...dot) => dots.push(dot));
    return dots;
  };
  for (const morph of [1, 0.91]) {
    for (const energy of [0, 0.27, 0.63, 1]) {
      const before = frame(to, from, 0.37, morph, energy);
      const after = frame(next, displayed, 0, morph, energy);
      assert.equal(after.length, before.length);
      after.forEach((dot, i) => dot.forEach((value, channel) => assert.ok(Math.abs(value - before[i][channel]) < 1e-12)));
    }
  }
});

test('the status cell has distinct truthful static poses and externally driven work progression', () => {
  const cells = ['thinking', 'working', 'needs_you', 'done', 'idle', 'off'].map((kind) => planet.createPlanetStatusCell({ kind }));
  assert.ok(cells.every((cell) => cell.length === 8));
  assert.equal(new Set(cells.map((cell) => JSON.stringify(cell))).size, cells.length);
  assert.deepEqual(cells[2].filter((dot) => dot.opacity === 1).map((dot) => dot.id), [2, 3, 4, 5]);
  assert.notDeepEqual(planet.createPlanetStatusCell({ kind: 'working', progress: 0 }), planet.createPlanetStatusCell({ kind: 'working', progress: 0.5 }));
});

test('readiness light moves the terminator only with explicit progress, and hero sizes keep a dense lattice', () => {
  const lit = (progress) => planet.createPlanetDots({ size: 96, light: planet.planetLightForProgress(progress) })
    .filter((dot) => dot.opacity > 0 && dot.rgb.reduce((sum, value) => sum + value, 0) > 300).length;
  assert.deepEqual(planet.planetLightForProgress(0.5), planet.planetLightForProgress(0.5));
  assert.deepEqual(planet.planetLightForProgress(-1), planet.planetLightForProgress(0));
  assert.deepEqual(planet.planetLightForProgress(2), planet.planetLightForProgress(1));
  assert.ok(lit(0) < lit(0.5) && lit(0.5) < lit(1));
  // Hero art keeps the lab's fine pitch instead of stretching the largest mark tier.
  const hero = planet.createPlanetDots({ size: 168 });
  assert.ok(Math.sqrt(hero.length) >= 50);
  assert.ok(hero.every((dot) => dot.x >= 0 && dot.x <= 168 && dot.y >= 0 && dot.y <= 168));
  assert.equal(planet.createPlanetDots({ size: 48 }).length, 19 * 19);
});

test('a mark that bleeds fills its box with the disc and puts the atmosphere outside it', () => {
  const size = 48;
  const contained = planet.createPlanetDots({ size, energy: 1 });
  const bleeding = planet.createPlanetDots({ size, energy: 1, bleed: 0.3 });
  const extent = (dots) => {
    const lit = dots.filter((dot) => dot.opacity > 0);
    return Math.max(...lit.map((dot) => Math.hypot(dot.x - size / 2, dot.y - size / 2)));
  };
  // The bleeding lattice extends past the box (same pitch, stable ids), and its lit disc reaches the box edge.
  assert.ok(bleeding.length > contained.length);
  assert.ok(bleeding.some((dot) => dot.x < 0 || dot.y < 0 || dot.x > size || dot.y > size));
  assert.ok(bleeding.filter((dot) => dot.opacity > 0).some((dot) => dot.x < 0 || dot.x > size || dot.y < 0 || dot.y > size));
  assert.ok(extent(bleeding) > extent(contained));
  // Silence draws nothing outside the disc's box; real energy does.
  const silent = planet.createPlanetDots({ size, energy: 0, bleed: 0.3 });
  const outside = (dots) => dots.filter((dot) => dot.opacity > 0 && Math.hypot(dot.x - size / 2, dot.y - size / 2) > size / 2 + 1).length;
  assert.ok(outside(bleeding) > outside(silent));
  assert.deepEqual(planet.createPlanetDotCorrespondence({ size, bleed: 0.3 }).map((pair) => pair.planet), planet.createPlanetDots({ size, bleed: 0.3 }));
});

test('light-theme dots carry more ink than the pastel artwork ramp they come from', () => {
  const saturation = (rgb) => Math.max(...rgb) - Math.min(...rgb);
  const mean = (dots) => dots.reduce((sum, dot) => sum + saturation(dot.rgb), 0) / dots.length;
  const lightMic = planet.createMicDots({ size: 48, theme: 'light' });
  const darkMic = planet.createMicDots({ size: 48, theme: 'dark' });
  assert.equal(lightMic.length, darkMic.length);
  // Dots on white paper read washed out at the artwork's pastel saturation (Daybreak lab note).
  assert.ok(mean(lightMic) >= 145);
});

test('every planet dot gathers from a microphone dot, so the morph reads as a flow, not a fade', () => {
  for (const size of [20, 24, 48]) {
    const mic = planet.createMicDots({ size });
    const micPoints = new Set(mic.map((dot) => `${dot.x},${dot.y}`));
    const pairs = planet.createPlanetDotCorrespondence({ size, bleed: 0.3 });
    assert.ok(pairs.every((pair) => micPoints.has(`${pair.mic.x},${pair.mic.y}`)));
    // Still one unique visible endpoint per microphone dot.
    assert.equal(pairs.filter((pair) => pair.mic.opacity > 0).length, mic.length);
  }
});

test('real energy spreads the atmosphere the way the Daybreak voice grammar does, and silence keeps only the resting halo', () => {
  const size = 48;
  const far = (energy) => planet.createPlanetDots({ size, energy, bleed: 0.3 })
    .filter((dot) => dot.opacity > 0 && Math.hypot(dot.x - size / 2, dot.y - size / 2) > (size / 2) * 1.25).length;
  // Speaking at full voice throws dots well past the limb; a quiet room barely stirs it.
  assert.ok(far(0.9) >= 40);
  assert.ok(far(0.9) > far(0.5) && far(0.5) > far(0.1));
  assert.ok(far(0) <= 2);
});

test('a mark frame draws the exact microphone at rest, the exact planet when gathered, and follows real energy', () => {
  const size = 24;
  const geometry = planet.createPlanetMarkGeometry({ size, pose: 'ready' });
  const frame = (morph, energy, flow = 0) => {
    const dots = [];
    planet.drawPlanetMarkFrame(geometry, geometry, morph, 1, energy, flow, (x, y, radius, r, g, b, a) => dots.push({ x, y, radius, r, g, b, a }));
    return dots;
  };
  const mic = planet.createMicDots({ size });
  const rest = frame(0, 1);
  // At rest the real level has no effect: only the microphone, at full opacity.
  assert.equal(rest.length, mic.length);
  assert.ok(rest.every((dot) => dot.a === 1));
  assert.deepEqual(rest.map((dot) => `${dot.x},${dot.y}`).sort(), mic.map((dot) => `${dot.x},${dot.y}`).sort());
  const silent = frame(1, 0);
  const lattice = planet.createPlanetDots({ size, energy: 0, bleed: planet.PLANET_MARK_BLEED }).filter((dot) => dot.opacity > 0);
  assert.equal(silent.length, lattice.length);
  // A voice throws more atmosphere, and silence draws no tint.
  assert.ok(frame(1, 1).length > silent.length);
  const loud = frame(1, 1, 1);
  const warm = loud.filter((dot) => dot.r > dot.b).length;
  assert.ok(warm >= frame(1, 1, -1).filter((dot) => dot.r > dot.b).length);
});

test('a voice throws visible atmosphere: dots a level lights carry the halo colour, never the background', () => {
  for (const theme of ['light', 'dark']) {
    const geometry = planet.createPlanetMarkGeometry({ size: 48, theme, pose: 'ready' });
    const background = planet.PLANET_PALETTES[theme].background.map((channel) => channel / 255);
    const loud = [];
    planet.drawPlanetMarkFrame(geometry, geometry, 1, 1, 0.9, 0, (x, y, radius, r, g, b, a) => {
      if (Math.hypot(x - 24, y - 24) > 24 * 1.15) loud.push({ r, g, b, a });
    });
    assert.ok(loud.length >= 40);
    const distance = (dot) => Math.hypot(dot.r - background[0], dot.g - background[1], dot.b - background[2]);
    // Every far atmosphere dot is a visible halo dot, not a background-coloured hole.
    assert.ok(loud.every((dot) => distance(dot) > 0.15), `${theme}: ${loud.filter((dot) => distance(dot) <= 0.15).length} background dots`);
  }
});

test('the live mark is the lab sphere: a round, slightly inset disc on the canvas lattice, with full-size dots', () => {
  const size = 48;
  const { pitch } = planet.planetMarkTier(size);
  const lit = planet.createPlanetDots({ size, energy: 0, bleed: planet.PLANET_MARK_BLEED })
    .filter((dot) => dot.opacity > 0 && Math.hypot(dot.x - size / 2, dot.y - size / 2) < size * 0.47);
  const rows = new Map();
  for (const dot of lit) rows.set(dot.y, (rows.get(dot.y) ?? 0) + 1);
  const ys = [...rows.keys()].sort((a, b) => a - b);
  // The lattice is the lab canvas's (origin at the bleed edge), so the limb never lands on a long flat row.
  assert.ok(rows.get(ys[0]) <= 5, `top row has ${rows.get(ys[0])} dots`);
  // Sphere dots are the lab's full dot (0.39 of the pitch), not the morph's smaller disc dot.
  assert.ok(lit.every((dot) => Math.abs(dot.radius - pitch * 0.39) < 1e-9));
  // The sphere is inset like the lab's (0.94 of the half box at rest).
  const farthest = Math.max(...lit.map((dot) => Math.hypot(dot.x - size / 2, dot.y - size / 2)));
  assert.ok(farthest <= size * 0.47 + 1e-9);
});

test('the tap morph streams every microphone dot out into an unlit disc before the light resolves', () => {
  const size = 48;
  const geometry = planet.createPlanetMarkGeometry({ size, pose: 'ready' });
  const frame = (morph) => {
    const dots = [];
    planet.drawPlanetMarkFrame(geometry, geometry, morph, 1, 0, 0, (x, y, radius, r, g, b, a) => dots.push({ x, y, a }));
    return dots;
  };
  const mic = planet.createMicDots({ size });
  const disc = planet.createPlanetDots({ size, energy: 0, bleed: planet.PLANET_MARK_BLEED })
    .filter((dot) => Math.hypot(dot.x - size / 2, dot.y - size / 2) <= size / 2 - planet.planetMarkTier(size).pitch * 0.15);
  // 35 %: far more dots than the microphone, already leaving it.
  const early = frame(0.35).filter((dot) => dot.a > 0.5);
  assert.ok(early.length > mic.length * 2, `35 %: ${early.length} dots`);
  // 70 %: the whole disc, full and unlit (the dark side is still there).
  const late = frame(0.7).filter((dot) => dot.a > 0.9);
  assert.ok(late.length >= disc.length * 0.95, `70 %: ${late.length} of ${disc.length}`);
  const litPlanet = planet.createPlanetDots({ size, energy: 0, bleed: planet.PLANET_MARK_BLEED }).filter((dot) => dot.opacity > 0);
  assert.ok(late.length > litPlanet.filter((dot) => Math.hypot(dot.x - size / 2, dot.y - size / 2) < size / 2).length);
});

test('a readiness planet at Light 0 shows the lab rim: Daybreak density and inked colour on paper', () => {
  const saturation = (rgb) => Math.max(...rgb) - Math.min(...rgb);
  const sphere = (size, theme) => planet.createPlanetDots({ size, theme, pose: 'ready', light: planet.planetLightForProgress(0), bleed: planet.PLANET_MARK_BLEED })
    .filter((dot) => dot.opacity > 0 && Math.hypot(dot.x - size / 2, dot.y - size / 2) < size * 0.47);
  // The setup glyph uses the Daybreak size→pitch rule (size / 13), not the microphone's legibility tier.
  assert.ok(sphere(24, 'light').length >= 24, `24 pt rim has ${sphere(24, 'light').length} dots`);
  // On paper the lit rim keeps its colour (the lab's light-theme gamma), instead of fading to the page.
  for (const size of [24, 120]) {
    const dots = sphere(size, 'light');
    const mean = dots.reduce((sum, dot) => sum + saturation(dot.rgb), 0) / dots.length;
    assert.ok(mean >= 125, `${size} pt rim saturation ${mean.toFixed(1)}`);
  }
});

test('the failed pose stays visible on the smallest mark tier and keeps its half-shade above it', () => {
  // Visibly lit = drawn and clearly apart from the sky it is shaded towards.
  const visibleShare = (size, theme) => {
    const background = planet.PLANET_PALETTES[theme].background;
    const disc = planet.createPlanetDots({ size, theme, pose: 'shade', bleed: planet.PLANET_MARK_BLEED })
      .filter((dot) => Math.hypot(dot.x - size / 2, dot.y - size / 2) < (size / 2) * 0.94);
    const visible = disc.filter((dot) => dot.opacity > 0
      && Math.hypot(dot.rgb[0] - background[0], dot.rgb[1] - background[1], dot.rgb[2] - background[2]) > 60);
    return visible.length / disc.length;
  };
  for (const theme of ['light', 'dark']) {
    for (const size of [16, 20]) {
      assert.equal(planet.planetMarkTier(size).rows, 9);
      assert.ok(visibleShare(size, theme) >= 0.4, `${theme} ${size}pt failed pose keeps 40% of its disc lit`);
      assert.ok(visibleShare(size, theme) < 0.6, `${theme} ${size}pt failed pose is still a partial shade`);
    }
    // Larger tiers keep the lab's half-reveal crescent.
    assert.ok(visibleShare(28, theme) < 0.4);
  }
});

test('"needs you" is the amber attention colour in both themes; rose stays for failure', () => {
  for (const theme of ['light', 'dark']) {
    const lit = planet.createPlanetStatusCell({ kind: 'needs_you', theme }).filter((dot) => dot.opacity === 1);
    const amber = planet.PLANET_PALETTES[theme].attention;
    assert.ok(lit.length > 0);
    lit.forEach((dot) => assert.deepEqual(dot.rgb, [...amber]));
    assert.notDeepEqual([...amber], [...planet.PLANET_PALETTES[theme].rose]);
  }
  const hex = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  assert.equal(hex(planet.PLANET_PALETTES.light.attention), planet.PLANET_ATTENTION_HEX.light.toUpperCase());
  assert.equal(hex(planet.PLANET_PALETTES.dark.attention), planet.PLANET_ATTENTION_HEX.dark.toUpperCase());
});

test('scene art samples the same planet on a finer lattice, with a quieter halo and golden-hour warmth', () => {
  const coarse = planet.createPlanetDots({ size: 30 });
  const fine = planet.createPlanetDots({ size: 30, rows: 24 });
  assert.equal(fine.length, 24 * 24);
  assert.ok(fine.length > coarse.length);
  const haloOf = (dots) => dots.filter((dot) => Math.hypot(dot.x - 15, dot.y - 15) >= 12 && dot.opacity > 0).length;
  assert.ok(haloOf(planet.createPlanetDots({ size: 30, rows: 24, halo: 0.55 })) < haloOf(fine));
  const sum = (dots) => dots.reduce((total, dot) => total + dot.rgb[0] - dot.rgb[2], 0);
  assert.ok(sum(planet.createPlanetDots({ size: 30, rows: 24, warmth: 0.25 })) > sum(fine));
});
