import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readSourceSelectionRollbackPaths, recordSourceSelectionRollback, restoreSourceSelectionRollback,
  settleSourceSelectionRollback } from './source_selection_rollback.mjs';

// P03 ORCH 2026-11-17: a reload whose replacement fails readiness after the
// incumbent's retirement restarts the incumbent's revision, which is still prepared.
test('a reload restores the selection it replaced, and only while that revision still exists', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-rollback-' });
  const stackBaseDir = fixture.path('stack');
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  await mkdir(sourceRoot, { recursive: true });
  const entry = async name => { const path = fixture.path(`${name}/main.mjs`); await mkdir(fixture.path(name), { recursive: true }); await writeFile(path, ''); return path; };
  const selection = component => join(sourceRoot, `selected-${component}.json`);
  const read = async component => JSON.parse(await readFile(selection(component), 'utf8'));
  const incumbentServer = await entry('incumbent-server');
  await writeFile(selection('server'), JSON.stringify({ entrypoint: incumbentServer }));

  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });
  await recordSourceSelectionRollback({ stackBaseDir });
  assert.deepEqual(readSourceSelectionRollbackPaths(stackBaseDir), [incumbentServer]);
  // Activation then selects the replacement, including a component the incumbent never had.
  await writeFile(selection('server'), JSON.stringify({ entrypoint: await entry('replacement-server') }));
  await writeFile(selection('daemon'), JSON.stringify({ entrypoint: await entry('replacement-daemon') }));

  assert.deepEqual(await restoreSourceSelectionRollback({ stackBaseDir }), ['server', 'daemon']);
  assert.deepEqual(await read('server'), { entrypoint: incumbentServer });
  await assert.rejects(readFile(selection('daemon')), { code: 'ENOENT' });

  await settleSourceSelectionRollback({ stackBaseDir });
  assert.deepEqual(readSourceSelectionRollbackPaths(stackBaseDir), []);
  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });

  // A released incumbent revision cannot be restarted: refuse rather than select it.
  await recordSourceSelectionRollback({ stackBaseDir });
  await writeFile(selection('server'), JSON.stringify({ entrypoint: await entry('next-server') }));
  await rm(incumbentServer);
  await assert.rejects(restoreSourceSelectionRollback({ stackBaseDir }), { code: 'ESOURCEROLLBACKUNAVAILABLE' });
  assert.notEqual((await read('server')).entrypoint, incumbentServer, 'a refused restore keeps the current selection');
});

test('stale unchanged controller selections do not block restoring the incumbent on its execution host', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-placed-source-rollback-' });
  const controller = fixture.path('controller');
  const target = fixture.path('target');
  const controllerServerSelection = join(controller, 'source-runtime', 'selected-server.json');
  const targetServerSelection = join(target, 'source-runtime', 'selected-server.json');
  const stale = { entrypoint: fixture.path('released-controller-server.mjs') };
  const incumbent = { entrypoint: fixture.path('incumbent-server.mjs') };
  const replacement = { entrypoint: fixture.path('replacement-server.mjs') };
  await mkdir(dirname(controllerServerSelection), { recursive: true });
  await mkdir(dirname(targetServerSelection), { recursive: true });
  await writeFile(incumbent.entrypoint, '');
  await writeFile(replacement.entrypoint, '');
  await writeFile(controllerServerSelection, JSON.stringify(stale));
  await writeFile(targetServerSelection, JSON.stringify(incumbent));

  await recordSourceSelectionRollback({ stackBaseDir: controller });
  await recordSourceSelectionRollback({ stackBaseDir: target });
  await writeFile(targetServerSelection, JSON.stringify(replacement));

  // The controller restores its own changes before dispatching restore to the target.
  assert.deepEqual(await restoreSourceSelectionRollback({ stackBaseDir: controller }), []);
  assert.deepEqual(await restoreSourceSelectionRollback({ stackBaseDir: target }), ['server']);
  assert.deepEqual(JSON.parse(await readFile(controllerServerSelection, 'utf8')), stale);
  assert.deepEqual(JSON.parse(await readFile(targetServerSelection, 'utf8')), incumbent);
});

// P03 ORCH 2026-11-18: a shared-database stack's replacement re-establishes its CLI profiles on
// its own server's Home identity; if activation then fails, the incumbent revision's server
// (still on the shared identity) must be accepted again after rollback.
test('reload → activation fails → rollback: the incumbent server is accepted on the restored Home binding', async t => {
  const { waitForServerReady } = await import('../../utils/server/server.mjs');
  const { resolveStackActiveServerId } = await import('../../utils/auth/stable_scope_id.mjs');
  const fixture = await createTempFixture(t, { prefix: 'hstack-home-rollback-' });
  const env = { HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: 'qa',
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'repo-dev' };
  const stackBaseDir = fixture.path('stacks', 'qa');
  const cliHomeDir = join(stackBaseDir, 'cli');
  const serverId = resolveStackActiveServerId({ env });
  const url = 'http://127.0.0.1:41235';
  const descriptor = identity => ({ v: 1, homeServerIdentityId: identity, revision: 3, canonicalServerUrl: url,
    endpoints: [{ kind: 'https', url }] });
  const writeProfile = identity => writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({ schemaVersion: 6,
    activeServerId: serverId, servers: { [serverId]: { id: serverId, serverUrl: url, webappUrl: url,
      homeConnectionDescriptor: descriptor(identity), homeConnectionDescriptorAuthority: 'exact' } } }));
  await mkdir(join(cliHomeDir, 'servers', serverId), { recursive: true });
  await writeFile(join(cliHomeDir, 'servers', serverId, 'access.key'), JSON.stringify({ token: 'fixture-token' }));
  await writeProfile('srv_shared_source');
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  const incumbent = fixture.path('incumbent-server.mjs');
  await writeFile(incumbent, '');
  await writeFile(join(stackBaseDir, 'source-runtime', 'selected-server.json'), JSON.stringify({ entrypoint: incumbent }));
  let served = 'srv_stack_minted';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ features: {},
    capabilities: { serverIdentity: { serverIdentityId: served } }, homeConnectionDescriptor: descriptor(served) }));
  const ready = () => waitForServerReady(url, { env, cliHomeDir, intervalMs: 0, timeoutMs: 60_000 });

  await recordSourceSelectionRollback({ stackBaseDir, env });
  // The replacement's server mints its own identity; readiness admits it and names the record.
  const recordPath = join(stackBaseDir, 'server-light', 'runtime', 'server.identity');
  await mkdir(join(stackBaseDir, 'server-light', 'runtime'), { recursive: true });
  await writeFile(recordPath, 'srv_stack_minted\n');
  assert.deepEqual(await ready(), { status: 'ready', homeIdentityRecordPath: recordPath });
  // Daemon reconciliation re-established the profile (CLI owner), then activation failed.
  await writeProfile('srv_stack_minted');
  served = 'srv_shared_source';
  await assert.rejects(ready(), /does not match the established Home/, 'without restore the incumbent is refused');

  assert.deepEqual(await restoreSourceSelectionRollback({ stackBaseDir }), [`home:${serverId}`]);
  assert.deepEqual(await ready(), { status: 'ready' });
  const restored = JSON.parse(await readFile(join(cliHomeDir, 'settings.json'), 'utf8')).servers[serverId];
  assert.deepEqual(restored.homeConnectionDescriptor, descriptor('srv_shared_source'));
});
