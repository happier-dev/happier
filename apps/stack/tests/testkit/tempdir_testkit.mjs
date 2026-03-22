import { createTempFixtureSync } from '../../scripts/testkit/core/temp_fixture.mjs';

export function createTempDir(t, prefix) {
  return createTempFixtureSync(t, { prefix }).root;
}
