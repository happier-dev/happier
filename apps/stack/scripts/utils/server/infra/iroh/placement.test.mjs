import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from '../../../../testkit/core/temp_fixture.mjs';
import { readyDevTargetSyncResult } from '../../../../testkit/core/dev_target_sync.mjs';
import { inspectStackRelay } from './runtime.mjs';
import { prepareRelayOnTarget } from './placement.mjs';

const repoDir = fileURLToPath(new URL('../../../../../../../', import.meta.url));

for (const platform of ['posix', 'windows']) {
  test(`remote relay observation reads live state without Mutagen admission on ${platform}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'relay-observation-' });
    const target = { name: 'worker', platform, ssh: 'fixture-worker',
      repoDir: platform === 'windows' ? 'C:/repo' : '/remote/repo',
      cliHomeDir: platform === 'windows' ? 'C:/home' : '/remote/home' };
    const relay = { status: 'ready', httpsUrl: 'https://relay.example.test' };
    const captures = [];
    const executions = [];
    const executorDependencies = {
      runCaptureResult: async input => {
        captures.push(input);
        return input.args.includes('list')
          ? readyDevTargetSyncResult(input.args[input.args.indexOf('list') + 1])
          : { ok: true, exitCode: 0, out: '', err: '' };
      },
      spawnProcess: input => {
        executions.push(input);
        input.onLine({ stream: 'stdout', line: JSON.stringify(relay) });
        return { completion: Promise.resolve({ code: 0, signal: null }) };
      },
    };
    const options = { serverTarget: target, repoDir, stackBaseDir: fixture.root,
      env: { HAPPIER_STACK_STACK: 'fixture' }, executorDependencies };

    const observed = await inspectStackRelay({ ...options,
      runtimeState: { irohRelay: { ...relay, target: target.name } } });
    assert.deepEqual(observed, { ...relay, target: target.name });
    assert.equal(executions.length, 1, 'inspection must still reach the live host');
    assert.equal(captures.length, 0, 'runtime observation must perform zero Mutagen reads or flushes');

    await prepareRelayOnTarget(options);
    assert.equal(executions.length, 2, 'preparation must still reach the host');
    assert.equal(captures.filter(input => input.args.includes('flush')).length, 1,
      'source-consuming relay preparation retains its freshness barrier');
  });
}
