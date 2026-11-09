import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';

test('server CPU profile flags belong to the source server launch and do not survive a new start', async t => {
  const stackBaseDir = await mkdtemp(join(tmpdir(), 'hstack-server-profile-args-'));
  t.after(() => rm(stackBaseDir, { recursive: true, force: true }));
  const sourceRuntimeLaunch = { entrypoint: '/server/main.mjs', serverDir: '/server', args: ['server-input'] };
  const env = { HAPPIER_STACK_SERVER_CPU_PROF: '1' };
  const spec = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch, env, stackBaseDir });
  assert.deepEqual(spec.args, ['--cpu-prof', `--cpu-prof-dir=${join(stackBaseDir, 'logs', 'server-cpu-prof')}`,
    '--cpu-prof-interval=10000', '--disable-sigusr1', '/server/main.mjs', 'server-input']);
  assert.deepEqual(env, { HAPPIER_STACK_SERVER_CPU_PROF: '1' });
  assert.deepEqual(sourceRuntimeLaunch.args, ['server-input']);
  for (const nextEnv of [{}, { HAPPIER_STACK_SERVER_CPU_PROF: '0' }]) {
    assert.deepEqual(resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch, env: nextEnv, stackBaseDir }).args,
      ['/server/main.mjs', 'server-input']);
  }
});
