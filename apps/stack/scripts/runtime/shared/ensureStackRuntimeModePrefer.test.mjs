import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { parseEnvToObject } from '../../utils/env/dotenv.mjs';
import { ensureStackRuntimeModePrefer } from './ensureStackRuntimeModePrefer.mjs';

test('ensureStackRuntimeModePrefer writes prefer when missing', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'ensure-runtime-mode-' });
  const envPath = join(fixture.root, 'env');
  await writeFile(envPath, 'FOO=bar\n', 'utf8');

  const res = await ensureStackRuntimeModePrefer({ envPath });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);

  const parsed = parseEnvToObject(await readFile(envPath, 'utf8'));
  assert.equal(parsed.HAPPIER_STACK_RUNTIME_MODE, 'prefer');
  assert.equal(parsed.FOO, 'bar');
});

test('ensureStackRuntimeModePrefer does not override existing runtime mode', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'ensure-runtime-mode-existing-' });
  const envPath = join(fixture.root, 'env');
  await writeFile(envPath, 'HAPPIER_STACK_RUNTIME_MODE=require\n', 'utf8');

  const res = await ensureStackRuntimeModePrefer({ envPath });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);

  const parsed = parseEnvToObject(await readFile(envPath, 'utf8'));
  assert.equal(parsed.HAPPIER_STACK_RUNTIME_MODE, 'require');
});
