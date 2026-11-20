import test from 'node:test';
import assert from 'node:assert/strict';
import { horizonPlanetGeometry, interpolateWelcomePlanetPose, welcomePlanetPose } from './planet-placement.mjs';

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

test('the Welcome pose samples continuously and lands on the exact step pose', () => {
  const pane = { width: 1440, height: 900 };
  const welcome = welcomePlanetPose('welcome', pane);
  const night = welcomePlanetPose('night', pane);
  assert.deepEqual(interpolateWelcomePlanetPose(welcome, night, 0), welcome);
  assert.deepEqual(interpolateWelcomePlanetPose(welcome, night, 1), night);
  const early = interpolateWelcomePlanetPose(welcome, night, 0.25);
  assert.equal(early.limb, welcome.limb + (night.limb - welcome.limb) * 0.25);
  assert.equal(early.cy - early.R, early.limb);
  assert.ok(early.reveal > night.reveal && early.reveal < 1);
  assert.ok(early.spin > welcome.spin && early.spin < night.spin);
});

test('the signed-out step limb clears the Approve ways at the first-launch desktop size', () => {
  const firstLaunch = { width: 1224, height: 765 };
  const short = welcomePlanetPose('deep', firstLaunch);
  assert.ok(short.limb > 618, 'the rendered ways row ends at y=618');
  assert.equal(short.limb, welcomePlanetPose('deeper', firstLaunch).limb);
  assert.equal(welcomePlanetPose('deep', { width: 1440, height: 900 }).limb, 684);
  assert.ok(welcomePlanetPose('deep', { width: 390, height: 844 }, { phone: true }).limb > 401);
});
