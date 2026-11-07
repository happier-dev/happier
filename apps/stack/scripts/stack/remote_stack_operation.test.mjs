import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';
import { runRemoteStackOperation } from './remote_stack_operation.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeUpdate } from '../utils/stack/runtime_state.mjs';

for (const action of ['start', 'restart']) {
  for (const identity of ['default', 'broker']) {
    test(`remote source ${action} for ${identity} preserves the default daemon identity scope`, async t => {
      const fixture = await createTempFixture(t, { prefix: 'hstack-remote-identity-scope-' });
      const runtimeStatePath = fixture.path('stack.runtime.json');
      const daemon = { selected: 'default-source', loaded: 'default-source' };
      await recordStackRuntimeUpdate(runtimeStatePath, { sourceRuntimeIdentities: { daemon },
        remoteTargets: { worker: { sourceRuntimeIdentities: { daemon } } } });
      const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
        HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath };
      const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh',
        repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
      let sshCalls = 0;
      const observed = { daemon: { selected: 'worker-default', loaded: 'worker-default' } };
      await runRemoteStackOperation({
        rootDir: fileURLToPath(new URL('../../', import.meta.url)), stackName: 'fixture',
        placed: { target, runtimeMode: 'source-snapshot' }, operation: 'daemon',
        passthrough: [action, `--identity=${identity}`], env,
      }, { runProcess: async ({ command }) => command !== 'ssh' || ++sshCalls === 1
        ? { code: 0, out: '' }
        : { code: 0, out: JSON.stringify({ sourceRuntimeIdentities: observed }) } });
      const state = await readStackRuntimeStateFile(runtimeStatePath);
      const expected = identity === 'default' ? observed.daemon : daemon;
      assert.deepEqual(state.sourceRuntimeIdentities.daemon, expected);
      assert.deepEqual(state.remoteTargets.worker.sourceRuntimeIdentities.daemon, expected);
    });
  }
}

for (const stream of ['out', 'err']) {
  test(`remote Stack operation preserves redacted ${stream} failure context`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-remote-operation-failure-' });
    const secret = randomUUID();
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_TEST_SECRET: secret };
    const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh',
      repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
    await assert.rejects(runRemoteStackOperation({
      rootDir: fileURLToPath(new URL('../../', import.meta.url)), stackName: 'fixture',
      placed: { target, runtimeMode: 'source-snapshot' }, operation: 'daemon', passthrough: ['status'], env,
    }, { runProcess: async ({ command }) => command === 'mutagen' ? { code: 0 } : {
      code: 7, [stream]: `src/replacement.ts:12: Error: loader failed\nHAPPIER_TEST_SECRET=${secret}`,
    } }), error => {
      assert.match(error.message, /src\/replacement\.ts:12: Error: loader failed/);
      assert.equal(error.message.includes(secret), false);
      assert.match(error.message, /remote daemon failed.*code=7/);
      return true;
    });
  });
}
