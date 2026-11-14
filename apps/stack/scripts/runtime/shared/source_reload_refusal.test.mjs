// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { diagnoseSourceReloadFailure, formatSourceReloadRefusal, parseSourceReloadRefusalLine, readSourceReloadRefusal } from './source_reload_refusal.mjs';

test('module diagnosis reuses the component entry graph only when a failure has no location', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refusal-entry-' });
  const cli = fixture.path('apps/cli');
  const leaf = join(cli, 'src/daemon/failing-leaf.mjs');
  const witness = fixture.path('entry-loads');
  await mkdir(join(cli, 'src/daemon'), { recursive: true });
  await writeFile(join(cli, 'package.json'), '{"type":"module"}');
  await writeFile(join(cli, 'tsconfig.runtime.json'), '{}');
  await writeFile(join(cli, 'src/daemon/startDaemon.ts'), 'import "./failing-leaf.mjs";');
  await writeFile(leaf, `import {appendFileSync} from 'node:fs';
    appendFileSync(${JSON.stringify(witness)}, ${JSON.stringify('loaded\n')});
    throw new ReferenceError('constructed-entry-refusal');`);

  const compilerError = Object.assign(new Error('compile failed'), { errors: [{ location: { file: leaf } }] });
  await diagnoseSourceReloadFailure(compilerError, { component: 'daemon', repoDir: fixture.root });
  assert.equal(compilerError.firstFailingModule, leaf);
  await assert.rejects(readFile(witness), { code: 'ENOENT' });

  const opaque = new Error('component preparation failed without a location');
  await diagnoseSourceReloadFailure(opaque, { component: 'daemon', repoDir: fixture.root });
  assert.equal(opaque.entryGraph, 'daemon');
  assert.equal(opaque.firstFailingModule, leaf);
  assert.equal(await readFile(witness, 'utf8'), 'loaded\n');
  // The same failure crosses preparation, reload and presentation owners.
  await diagnoseSourceReloadFailure(opaque, { component: 'daemon', repoDir: fixture.root });
  assert.equal(await readFile(witness, 'utf8'), 'loaded\n');
});

test('refusal transport retains typed migration and module facts without copying error payloads', () => {
  const failure = Object.assign(new Error('private failure payload'), {
    component: 'server', entryGraph: 'server', firstFailingModule: 'apps/server/sources/failing.ts',
    code: 'SHARED_DATABASE_MIGRATIONS_PENDING', sourceStack: 'repo-dev-a1cc5e0671',
    missingMigrations: ['20261029_first', '20261029_second'], ignoredPayload: { content: 'private' },
  });
  const projected = readSourceReloadRefusal(failure);
  const restored = parseSourceReloadRefusalLine('HSTACK_SOURCE_RELOAD_REFUSAL=' + JSON.stringify(projected));
  assert.deepEqual(restored, projected);
  assert.equal('ignoredPayload' in restored, false);
  assert.equal('message' in restored, false);
  assert.match(formatSourceReloadRefusal(restored), /firstFailingModule=/);
  assert.match(formatSourceReloadRefusal(restored), /missingMigrations=/);
});

test('producer refusal retains its reason and next action across the prepared worker transport', () => {
  const failure = Object.assign(new Error('producer input failure'), {
    code: 'source_runtime_producer_unavailable', phase: 'source-producer', retryable: true,
    sourceStack: 'repo-producer', reason: 'ENOENT',
    nextAction: 'Repair repository producer inputs and retry the Stack reload',
  });
  const restored = parseSourceReloadRefusalLine('HSTACK_SOURCE_RELOAD_REFUSAL=' + JSON.stringify(readSourceReloadRefusal(failure)));
  assert.equal(restored.reason, failure.reason);
  assert.equal(restored.nextAction, failure.nextAction);
  assert.equal(restored.sourceStack, failure.sourceStack);
  assert.equal(restored.code, failure.code);
  assert.equal(restored.retryable, true);
});

test('preparation refusal keeps the Node loader code instead of the child exit status', async () => {
  const importer = '/constructed/packages/cli-common/registerSourceRuntime.mjs';
  const diagnostic = `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from ${importer}`;
  const failure = Object.assign(new Error('Source preparation failed (exit 1)'), { code: 1 });
  await diagnoseSourceReloadFailure(failure, { component: 'server', diagnostic });
  const refusal = parseSourceReloadRefusalLine('HSTACK_SOURCE_RELOAD_REFUSAL=' + JSON.stringify(readSourceReloadRefusal(failure)));
  assert.equal(refusal.code, 'ERR_MODULE_NOT_FOUND');
  assert.equal(refusal.firstFailingModule, importer);
  assert.equal(refusal.entryGraph, 'server');
  const typed = Object.assign(new Error('original structured refusal'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  await diagnoseSourceReloadFailure(typed, { component: 'server', diagnostic });
  assert.equal(typed.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'an existing typed failure remains authoritative');
});

test('unavailable diagnostic scratch space preserves the original opaque refusal', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refusal-scratch-' });
  const absent = fixture.path('absent');
  const restore = withPatchedProcessEnv(t, { TMPDIR: absent, TEMP: absent, TMP: absent });
  const original = new Error('original component preparation failure');
  try {
    assert.equal(await diagnoseSourceReloadFailure(original, { component: 'daemon', repoDir: fixture.root }), original);
    assert.equal(original.entryGraph, 'daemon');
  } finally { restore(); }
});
