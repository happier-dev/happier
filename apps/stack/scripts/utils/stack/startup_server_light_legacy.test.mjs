import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ensureServerLightSchemaReady } from './startup.mjs';
import { buildServerLightEnv, createServerLightFixture } from './startup_server_light_testkit.mjs';

test('ensureServerLightSchemaReady bestEffort=true skips migrate:sqlite:deploy by default', async (t) => {
  const { binDir, markerPath, root, serverDir } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-best-effort-',
    socketPort: 54323,
  });
  const env = buildServerLightEnv({ binDir, root });

  const res = await ensureServerLightSchemaReady({ serverDir, env, bestEffort: true });
  assert.equal(res.ok, true);
  assert.equal(res.migrated, true);
  assert.equal(res.accountCount, 0);
  assert.equal(existsSync(markerPath), false, `expected bestEffort to skip migrate:sqlite:deploy (${markerPath})`);
});

test('ensureServerLightSchemaReady honors HAPPY_SERVER_LIGHT_DATA_DIR legacy fallback', async (t) => {
  const { binDir, markerPath, root, serverDir } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-legacy-data-dir-',
    socketPort: 54324,
  });

  const dataDir = join(root, 'legacy-data');
  const env = buildServerLightEnv({
    binDir,
    root,
    extraEnv: {
      HAPPIER_SERVER_LIGHT_DATA_DIR: undefined,
      HAPPIER_SERVER_LIGHT_FILES_DIR: undefined,
      HAPPIER_SERVER_LIGHT_DB_DIR: undefined,
      HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
      DATABASE_URL: undefined,
    },
  });

  assert.equal(existsSync(dataDir), false);
  assert.equal(Boolean(env.DATABASE_URL), false);

  const res = await ensureServerLightSchemaReady({ serverDir, env });
  assert.equal(res.ok, true);
  assert.equal(existsSync(dataDir), true);
  assert.equal(env.DATABASE_URL, `file:${join(dataDir, 'happier-server-light.sqlite')}`);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to be invoked (${markerPath})`);
});

test('ensureServerLightSchemaReady falls back to HAPPY_SERVER_LIGHT_DATA_DIR when HAPPIER value is empty', async (t) => {
  const { binDir, markerPath, root, serverDir } = await createServerLightFixture(t, {
    prefix: 'hs-startup-light-empty-prefers-legacy-',
    socketPort: 54325,
  });

  const dataDir = join(root, 'legacy-data-empty-fallback');
  const env = buildServerLightEnv({
    binDir,
    root,
    extraEnv: {
      HAPPIER_SERVER_LIGHT_DATA_DIR: '',
      HAPPIER_SERVER_LIGHT_FILES_DIR: '',
      HAPPIER_SERVER_LIGHT_DB_DIR: '',
      HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
      DATABASE_URL: undefined,
    },
  });

  assert.equal(existsSync(dataDir), false);
  assert.equal(Boolean(env.DATABASE_URL), false);

  const res = await ensureServerLightSchemaReady({ serverDir, env });
  assert.equal(res.ok, true);
  assert.equal(existsSync(dataDir), true);
  assert.equal(env.DATABASE_URL, `file:${join(dataDir, 'happier-server-light.sqlite')}`);
  assert.equal(existsSync(markerPath), true, `expected migrate:sqlite:deploy to be invoked (${markerPath})`);
});
