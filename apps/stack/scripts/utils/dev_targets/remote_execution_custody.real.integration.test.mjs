import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { createAdmissionBroker } from '../proc/admission_broker.mjs';
import { requestAdmissionSample } from '../proc/admission_client.mjs';
const custody = new URL('./remote_execution_custody.sh', import.meta.url).pathname;
function running(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}
async function waitFor(predicate, message) {
  // Match the existing custody integration observation window.
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

// Requires the real systemd scope boundary: a detached worker remains in its
// cgroup even after its launcher process group has terminated. A dead SSH
// dispatcher also takes sshd's stdout/stderr readers with it, so custody's own
// teardown diagnostics must not end custody before it stops the scope.
for (const [admitted, dispatcherGone] of [[false, false], [true, false], [false, true], [true, true]]) test(`${dispatcherGone ? 'dispatcher death' : 'lifeline EOF'} ends ${admitted ? 'the owned scope including a detached worker' : 'a queued job without running its payload'}`, {
  skip: process.platform !== 'linux' || process.env.HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS !== '1',
}, async t => {
  const { root } = await createTempFixture(t, { prefix: 'custody-scope-' });
  const admissionRoot = join(root, 'admission');
  await mkdir(admissionRoot, { mode: 0o700 });
  // Only the OS resource sample is constructed; admission and slot sockets
  // are real and isolated from other lanes' host broker.
  const broker = createAdmissionBroker({ root: admissionRoot,
    oldLockPath: join(root, 'old.lock'),
    sampleResources: async () => ({ availableMemoryKiB: admitted ? 100 : 0, totalMemoryKiB: 100 }) });
  await broker.start();
  t.after(() => broker.close());
  const worker = join(root, 'worker.mjs');
  await writeFile(worker, `import { spawn } from 'node:child_process';
import { runAdmittedTask } from ${JSON.stringify(new URL('../proc/admission_client.mjs', import.meta.url).href)};
console.log('CLIENT ' + process.pid);
await runAdmittedTask({ root: ${JSON.stringify(admissionRoot)}, className: 'validation', floorKiB: 1,
  machine: 'fixture', repoDir: ${JSON.stringify(root)}, env: {} }, async (_env, signal) => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  console.log('READY ' + child.pid);
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
});
`);
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--slice=happier-critical.slice',
    'env', 'HAPPIER_REMOTE_EXEC_LIFELINE=1', '/bin/bash', custody, 'run',
    join(root, 'remote-exec', 'scope.pid'), 'native-scope-regression', process.execPath, worker], {
    env: { ...process.env, TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const completion = once(child, 'close');
  let output = '', error = '', workerPid;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  t.after(async () => {
    child.stdin.end();
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
    if (child.exitCode === null) child.kill('SIGTERM');
    await completion;
  });
  const ready = admitted ? /READY (\d+)/u : /CLIENT (\d+)/u;
  await waitFor(() => ready.test(output) || child.exitCode !== null, () => error);
  assert.match(output, ready, error);
  workerPid = Number(output.match(ready)[1]);
  await waitFor(async () => {
    const sample = await requestAdmissionSample(admissionRoot);
    return admitted ? sample.activeCount === 1 : sample.waitingCount === 1;
  }, 'job never reached its admission state');
  if (!admitted) assert.ok(!output.includes('READY'), 'queued payload ran before admission');
  const cgroup = (await readFile(`/proc/${workerPid}/cgroup`, 'utf8')).trim().split('/').at(-1);
  assert.match(cgroup, /^happier-jobs-.*\.scope$/u);
  assert.equal((await requestAdmissionSample(admissionRoot)).activeCount, admitted ? 1 : 0);
  if (dispatcherGone) { child.stdout.destroy(); child.stderr.destroy(); }
  child.stdin.end();
  await completion;
  await waitFor(async () => {
    const sample = await requestAdmissionSample(admissionRoot);
    return sample.activeCount === 0 && sample.waitingCount === 0;
  }, 'broker slot or queued request survived caller EOF');
  await waitFor(() => !running(workerPid), 'detached worker survived caller EOF after broker slot release');
  const scope = spawnSync('systemctl', ['--user', 'show', cgroup, '--property=ActiveState', '--value'], { encoding: 'utf8' });
  assert.notEqual(scope.stdout.trim(), 'active', 'job scope survived caller EOF');
  if (!dispatcherGone) assert.match(error, /"target_kind":"scope"/u);
});
