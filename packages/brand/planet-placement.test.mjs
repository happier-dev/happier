import test from 'node:test';
import assert from 'node:assert/strict';
import { horizonPlanetGeometry } from './planet-placement.mjs';

test('Horizon follows the composer in a tall pane without enlarging the desktop planet', () => {
  for (const height of [900, 1400, 2400]) {
    const planet = horizonPlanetGeometry({ width: 2400, height }, { composerTop: 420 });
    assert.equal(planet.R, 1300);
    assert.equal(planet.cx, 1200);
    assert.equal(planet.cy - planet.R, 430);
    assert.equal(planet.halo.top, 0);
  }
});

test('a media band sets the Horizon limb and radius independently of its pane', () => {
  const planet = horizonPlanetGeometry({ width: 1440, height: 420 }, { limb: 120, radius: 600 });
  assert.equal(planet.R, 600);
  assert.equal(planet.cy - planet.R, 120);
});
