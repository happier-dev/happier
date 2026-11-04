import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { buildStackFixtureEnv, withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';
import { recordStackRuntimeDaemonDesiredState } from './utils/stack/runtime_daemon_state.mjs';

test('stack info presents owner stop locally and through the existing remote status projection', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-daemon-stop-info-' });
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const stackName = 'owner-stop-info';
  const statePath = fixture.path(stackName, 'stack.runtime.json');
  await mkdir(fixture.path(stackName));
  await writeFile(fixture.path(stackName, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source\nHAPPIER_STACK_SERVE_UI=0\n');
  const env = buildStackFixtureEnv({ stripStackEnv: true, storageDir: fixture.root,
    extraEnv: { HAPPIER_STACK_UPDATE_CHECK: '0', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' } });
  withPatchedProcessEnv(t, env);
  await recordStackRuntimeDaemonDesiredState(statePath, 'stopped');
  const local = await readStackInfoSnapshot({ rootDir, stackName });
  assert.equal(local.runtime.components.daemon.status, 'stopped-by-owner');
  const cli = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./stack_commands.mjs', import.meta.url)), 'info', stackName], { env, signal: t.signal });
  assert.ok(cli.stdout.includes('daemon stopped by owner'));
  // The production worker probe projects this exact local status; the
  // controller must consume it without inventing another desired-state store.
  await recordStackRuntimeUpdate(statePath, { daemon: null,
    placement: { server: 'worker', daemon: 'worker' }, remoteTargets: { worker: {
      runtimeMode: 'controlled', services: { server: true, daemon: true },
      serviceStatus: { server: 'running', daemon: local.runtime.components.daemon.status },
    } } });
  const remote = await readStackInfoSnapshot({ rootDir, stackName });
  assert.equal(remote.runtime.running, true, 'the remote server remains running');
  assert.equal(remote.runtime.components.daemon.desiredState, 'stopped');
  assert.equal(remote.runtime.components.daemon.status, 'stopped-by-owner');
  assert.equal(remote.runtime.health.issues.includes('daemon_unknown'), false);
  assert.equal(remote.runtime.health.issues.includes('daemon_down'), false);
  await recordStackRuntimeUpdate(statePath, { remoteTargets: { worker: { serviceStatus: { daemon: 'unknown' } } } });
  const unknown = await readStackInfoSnapshot({ rootDir, stackName });
  assert.equal(unknown.runtime.components.daemon.desiredState, null, 'missing worker intent stays unknown');
  assert.equal(unknown.runtime.components.daemon.status, 'unknown');
});
