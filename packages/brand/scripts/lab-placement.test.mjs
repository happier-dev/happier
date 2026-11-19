import test from 'node:test';
import assert from 'node:assert/strict';
import { horizonPlanetGeometry } from '../planet-placement.mjs';

// Final first-open lab's Horizon pose with measured composer coordinates.
test('Horizon matches the desktop and phone lab poses', () => {
  for (const [width, height, composerTop, phone, radius] of [
    [1180, 940, 433, false, 708],
    [390, 844, 284, true, 358.8],
  ]) {
    const planet = horizonPlanetGeometry({ width, height }, { composerTop, phone });
    assert.ok(Math.abs(planet.R - radius) < 1e-9);
    assert.equal(planet.cx, width / 2);
    assert.equal(planet.limb, composerTop + 10);
  }
});
