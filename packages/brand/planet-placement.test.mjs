import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOME_HERO_FULL_PANE_HEIGHT, homePlanetGeometry, homePlanetSceneOptions } from './planet-placement.mjs';

// Independent pre-extraction inputs already stored with the scene capture; do not regenerate them.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/planet-scene-parity.json', import.meta.url), 'utf8'));
test('canonical Home placement retains every independently captured placement and digit field input', () => {
  for (const ref of fixture.scenes) {
    const match = /^(light|dark)-(1440|390)-(corner|side|rise)-(airy|balanced|rich)$/.exec(ref.id);
    if (!match) continue;
    const [, theme, width, place, style] = match;
    const pane = { width: Number(width), height: width === '390' ? 844 : 900 };
    const geometry = homePlanetGeometry(place, pane, { phone: width === '390' });
    const options = homePlanetSceneOptions(geometry, pane, { theme, style, digits: true });
    for (const key of ['R', 'cx', 'cy', 'rotate', 'fullness', 'halo', 'tail', 'field']) {
      assert.deepEqual(options[key], ref.options[key], `${ref.id}/${key}`);
    }
    assert.deepEqual(homePlanetSceneOptions(geometry, pane, { theme, style, digits: false }).field, { around: 0, over: 0 });
  }
});

test('a Rise band can keep its planet round: a given radius sits its limb where asked', () => {
  const pane = { width: 1440, height: 420 };
  const home = homePlanetGeometry('rise', pane, { limb: 120 });
  const band = homePlanetGeometry('rise', pane, { limb: 120, radius: 600 });
  assert.equal(band.R, 600);
  assert.equal(band.cy - band.R, 120);
  assert.equal(home.R, 0.8 * pane.width);
  assert.equal(homePlanetGeometry('corner', pane, { radius: 600 }).R, homePlanetGeometry('corner', pane).R);
});

test('Corner and Side stop growing where the hero does, so the planet stays an object on a tall pane', () => {
  const full = { width: 1100, height: HOME_HERO_FULL_PANE_HEIGHT };
  for (const height of [HOME_HERO_FULL_PANE_HEIGHT + 1, 1400, 2400]) {
    const tall = { width: 1100, height };
    for (const place of ['corner', 'side']) {
      const { R, cx, cy } = homePlanetGeometry(place, tall);
      assert.deepEqual({ R, cx, cy }, (({ R, cx, cy }) => ({ R, cx, cy }))(homePlanetGeometry(place, full)), `${place}@${height}`);
    }
    // Without widgets nothing sits under Side: it keeps its size but stays truly centred on the pane.
    const alone = homePlanetGeometry('side', tall, { widgets: false });
    assert.equal(alone.R, homePlanetGeometry('side', full, { widgets: false }).R);
    assert.equal(alone.cy, height / 2);
  }
  const short = { width: 1100, height: 900 };
  assert.equal(homePlanetGeometry('corner', short).R, 0.34 * 900);
  assert.equal(homePlanetGeometry('rise', { width: 1100, height: 2400 }, { limb: 480 }).R, 0.8 * 1100);
});
