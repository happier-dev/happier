import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { isPidAlive } from './utils/proc/pids.mjs';

const stackRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureOwner = new URL('./testkit/runtime_snapshot_start_testkit.mjs', import.meta.url).href;

for (const { failedCaller, withDaemon } of [
  { failedCaller: false, withDaemon: false },
  { failedCaller: true, withDaemon: false },
  { failedCaller: false, withDaemon: true },
]) {
test(`native test ${failedCaller ? 'failure' : 'completion'} retires every runtime fixture process ${withDaemon ? 'with daemon ' : ''}before removing its directory`, async t => {
  const evidence = await createTempFixture(t, { prefix: 'hstack-fixture-cleanup-proof-' });
  const reportPath = evidence.path('processes.json');
  const testPath = evidence.path('failing.test.mjs');
  await writeFile(testPath, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createStartableRuntimeSnapshotFixture, runNode } from ${JSON.stringify(fixtureOwner)};
test('fixture delegates shutdown to native teardown', async t => {
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'fixture-cleanup-proof', listenerDiscoveryMode: 'delayed-group-proof',
  });
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1', HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'), ...fixture.listenerDiscoveryEnv };
  await writeFile(${JSON.stringify(reportPath)}, JSON.stringify({ root: fixture.root,
    serverPidCapturePath: fixture.serverPidCapturePath, pids: [] }));
  const started = await runNode([${JSON.stringify(join(stackRoot, 'bin', 'hstack.mjs'))},
    'stack', 'start', fixture.stackName, '--background', '--runtime', ...${JSON.stringify(withDaemon ? [] : ['--no-daemon'])}, '--no-ui', '--no-browser'],
    { cwd: ${JSON.stringify(stackRoot)}, env });
  assert.equal(started.code, 0, started.stderr);
  const runtime = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
  assert.ok(Number(runtime.processes?.serverPid) > 1 || Number(runtime.processes?.serverWrapperPid) > 1,
    'background readiness must publish the process the fixture teardown owns');
  const serverPid = Number(await readFile(fixture.serverPidCapturePath, 'utf8'));
  await writeFile(${JSON.stringify(reportPath)}, JSON.stringify({ root: fixture.root,
    serverPidCapturePath: fixture.serverPidCapturePath,
    pids: [...new Set([runtime.ownerPid, serverPid, ...Object.values(runtime.processes).flat()].filter(pid => Number.isInteger(pid) && pid > 1))] }));
  if (process.env.HAPPIER_FIXTURE_FAIL_CALLER === '1') assert.fail('intentional caller failure before shutdown');
});
`);
  let recorded;
  try {
    const result = await runNodeCapture(['--test', testPath], {
      cwd: stackRoot,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined,
        HAPPIER_TEST_PRESERVE_RUNTIME_FIXTURE: '0', HAPPIER_FIXTURE_FAIL_CALLER: failedCaller ? '1' : '0' },
    });
    recorded = await readFile(reportPath, 'utf8').then(JSON.parse, () => null);
    assert.ok(recorded, result.stdout + result.stderr);
    assert.equal(result.code, failedCaller ? 1 : 0, result.stdout + result.stderr);
    if (failedCaller) assert.match(result.stdout, /intentional caller failure before shutdown/);
    assert.ok(recorded.pids.length > 0, 'the composed fixture must start real processes');
    const survivors = recorded.pids.filter(isPidAlive);
    assert.equal(survivors.length, 0, `owned fixture processes surviving native teardown: ${survivors.join(', ')}`);
    await assert.rejects(readFile(join(recorded.root, 'storage', 'fixture-cleanup-proof', 'env')), { code: 'ENOENT' }, result.stdout + result.stderr);
  } finally {
    // The RED control deliberately exposes newly created detached processes.
    // Never leave that control's processes behind when its assertion fails.
    const retained = recorded && await readFile(join(recorded.root, 'storage', 'fixture-cleanup-proof', 'stack.runtime.json'), 'utf8').then(JSON.parse, () => null);
    const captured = recorded && await readFile(recorded.serverPidCapturePath, 'utf8').then(Number, () => null);
    const pids = new Set([...(recorded?.pids ?? []), captured, retained?.ownerPid,
      ...Object.values(retained?.processes ?? {}).flat()]);
    for (const pid of pids) if (Number.isInteger(pid) && pid > 1 && isPidAlive(pid)) killDetachedProcessGroup(pid, 'SIGKILL');
  }
});
}
