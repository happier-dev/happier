import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';
import { buildServerLightEnv, createServerLightFixture } from './startup_server_light_testkit.mjs';

test('ensureServerLightSchemaReady runs migrate:sqlite:deploy by default when not best-effort', async (t) => {
  const { binDir, markerPath, root, serverDir } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-migrate-',
    socketPort: 54322,
  });
  const env = buildServerLightEnv({ binDir, root });
  const res = await ensureServerLightSchemaReady({ serverDir, env });
  assert.equal(res.ok, true);
  assert.equal(res.migrated, true);
  assert.equal(res.accountCount, 0);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to be invoked (${markerPath})`);
});
