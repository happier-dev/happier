import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTempDir } from './tempdir.test_helper.mjs';

const stackRoot = fileURLToPath(new URL('..', import.meta.url));

test('hstack self status --json works without kv shadowing crash', (t) => {
  const tmp = createTempDir(t, 'hstack-self-status-');
  const res = spawnSync(process.execPath, [join('scripts', 'self.mjs'), 'status', '--no-check', '--json'], {
    cwd: stackRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    },
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (res.error) throw res.error;
  assert.equal(res.status, 0);
  assert.doesNotThrow(() => JSON.parse(res.stdout));
});
