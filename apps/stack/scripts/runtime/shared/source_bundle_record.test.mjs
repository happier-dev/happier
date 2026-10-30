import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readSourceRuntimeSourceTime } from './source_bundle_record.mjs';

test('source times belong to the matching immutable runtime or web completion', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-times-' });
  const entrypoint = fixture.path('runtime/apps/cli/src/index.mjs');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, 'export {};');
  const runtimeRecord = fixture.path('runtime/source-bundle.json');
  const runtimeTime = '2026-10-29T12:01:00.000Z';
  await writeFile(runtimeRecord, JSON.stringify({ identity: 'runtime-code', entrypoint,
    sourceCapture: { inputIdentity: 'a'.repeat(64), capturedAt: runtimeTime } }));
  const completedAt = new Date('2026-10-29T13:00:00.000Z');
  await utimes(runtimeRecord, completedAt, completedAt);
  assert.equal(await readSourceRuntimeSourceTime({ entrypoint, identity: 'runtime-code' }), runtimeTime);
  assert.equal(await readSourceRuntimeSourceTime({ entrypoint, identity: 'other-code' }), null);

  const uiDir = fixture.path('web/web');
  await mkdir(uiDir, { recursive: true });
  const webRecord = join(dirname(uiDir), 'source-bundle.json');
  const webTime = '2026-10-29T12:03:00.000Z';
  await writeFile(webRecord, JSON.stringify({ component: 'web', uiDir,
    sourceCapture: { inputIdentity: 'b'.repeat(64), capturedAt: webTime } }));
  await utimes(webRecord, completedAt, completedAt);
  assert.equal(await readSourceRuntimeSourceTime({ uiDir }), webTime);
  assert.equal(await readSourceRuntimeSourceTime({ uiDir: fixture.path('private/web') }), null);
  await writeFile(webRecord, JSON.stringify({ component: 'web', uiDir: fixture.path('other/web') }));
  assert.equal(await readSourceRuntimeSourceTime({ uiDir }), null, 'a neighboring completion cannot attest this export');
  await writeFile(runtimeRecord, JSON.stringify({ identity: 'runtime-code', entrypoint, retiredField: true }));
  assert.equal(await readSourceRuntimeSourceTime({ entrypoint, identity: 'runtime-code' }), null,
    'an older completion without capture metadata remains readable, but its capture time is unknown');
});
