import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOME_SCENARIO_CATALOG,
  HOME_SCENARIO_IDS,
  HOME_SCENARIO_OWNER_GLOBS,
} from './homesScenarioInventory.ts';

test('Lane 09 acceptance catalog has every required scenario ID exactly once', () => {
  const ids = HOME_SCENARIO_CATALOG.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...HOME_SCENARIO_IDS].sort());
  assert.equal(ids.length, 41);
  for (const scenario of HOME_SCENARIO_CATALOG) {
    assert.ok(scenario.ownerGlob.length > 0, scenario.id);
    assert.ok(scenario.dependency.length > 0, scenario.id);
    assert.ok(scenario.reason.length > 0, scenario.id);
    assert.ok(['contract-tested', 'blocked', 'not-verified'].includes(scenario.status), scenario.id);
  }
});

test('every acceptance owner family maps to an existing lane-09 scenario glob', () => {
  const ownerGlobs = new Set(Object.values(HOME_SCENARIO_OWNER_GLOBS));
  for (const scenario of HOME_SCENARIO_CATALOG) {
    assert.ok(ownerGlobs.has(scenario.ownerGlob), scenario.id);
  }
});
