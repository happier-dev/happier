import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readSourceRuntimeSourceTime } from './source_bundle_record.mjs';
import { readLoadedSourceRuntimeIdentities } from './loaded_runtime_identity.mjs';
import { projectStackReloadVerification } from '../../stack/reload_verdict.mjs';

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

test('reload READY reports the payload belonging to the loaded source bundle locally and on a target', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-guest-payload-identity-' });
  const entrypoint = fixture.path('runtime/apps/cli/src/index.mjs');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, 'export {};');
  const sourceCapture = { inputIdentity: 'c'.repeat(64), capturedAt: '2026-11-04T09:00:00.000Z' };
  const guestPayload = { root: fixture.path('runtime/guest-payload'), identity: 'd'.repeat(64), sourceCapture };
  await writeFile(fixture.path('runtime/source-bundle.json'), JSON.stringify({ identity: 'daemon-new', entrypoint,
    sourceCapture, guestPayload }));
  await mkdir(fixture.path('source-runtime'));
  await writeFile(fixture.path('source-runtime/selected-daemon.json'), JSON.stringify({ entrypoint }));
  const runtimeState = { sourceRuntimeIdentities: {
    server: { selected: 'server-new', loaded: 'server-new' },
    daemon: { selected: 'daemon-new', loaded: 'daemon-new' },
  } };
  const options = { stackBaseDir: fixture.root, runtimeState, sourceSnapshot: true, runtimeLifecycleLive: true,
    serverRunning: true, daemonRunning: true, uiRunning: false };
  const local = await readLoadedSourceRuntimeIdentities(options);
  assert.deepEqual(local.daemon.guestPayload, guestPayload);
  const managedCli = { status: 'installed', binaryPath: '/managed/happier' };
  const info = { runtime: { mode: 'source-snapshot', running: true, valid: true,
    sourceRuntimeIdentities: local, components: { daemon: { running: true } },
    daemonEntry: { selected: entrypoint, loaded: entrypoint }, health: { status: 'healthy' }, managedCli } };
  const ready = projectStackReloadVerification({ info, beforeManagedCli: managedCli, auth: { authenticated: true } });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.identities.daemon.loaded, 'daemon-new');
  assert.deepEqual(ready.identities.daemon.guestPayload, guestPayload);

  runtimeState.placement = { daemon: 'worker' };
  runtimeState.remoteTargets = { worker: { serviceStatus: { daemon: 'running' }, sourceRuntimeIdentities: { daemon: local.daemon } } };
  const remote = await readLoadedSourceRuntimeIdentities({ ...options, stackBaseDir: fixture.path('no-local-copy') });
  assert.deepEqual(remote.daemon.guestPayload, guestPayload, 'target observation carries its own completion without a controller copy');
  runtimeState.remoteTargets.worker.serviceStatus.daemon = 'stopped';
  assert.equal((await readLoadedSourceRuntimeIdentities({ ...options, daemonRunning: false })).daemon.guestPayload, undefined,
    'a retained payload record does not attest a stopped target');
  delete runtimeState.placement;
  delete runtimeState.remoteTargets;
  runtimeState.sourceRuntimeIdentities.daemon.loaded = 'daemon-old';
  assert.equal((await readLoadedSourceRuntimeIdentities(options)).daemon.guestPayload, undefined,
    'the next selected bundle cannot attest a different loaded runtime');
});
