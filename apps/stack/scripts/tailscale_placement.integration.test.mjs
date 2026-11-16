// @happier-test-preparation source-condition
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

test('placed tailscale enable and url use the server host and retain its public URL', async t => {
  const fixture = await createTempFixture(t, { prefix: 'tailscale-placement-' });
  const stackName = 'placed-fixture';
  const baseDir = fixture.path('storage', stackName);
  await mkdir(baseDir, { recursive: true });
  await writeFile(baseDir + '/env', '');
  await writeFile(baseDir + '/stack.runtime.json', JSON.stringify({
    placement: { server: 'worker' }, ports: { server: 3009 },
    remoteTargets: { worker: { runtimeMode: 'source-snapshot' } },
  }));
  await writeFile(baseDir + '/dev-targets.json', JSON.stringify({
    version: 3, runtimePlacement: { server: { mode: 'prefer-target', target: 'worker' } }, targets: [{ name: 'worker', platform: 'posix', ssh: 'placed-worker',
      repoDir: '/remote/repo', cliHomeDir: '/remote/state' }],
  }));
  const publicUrl = 'https://' + 'worker.example.ts.net';
  const controller = writeFakeBin({ root: fixture.root, name: 'tailscale', content: `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PLACEMENT_LOCAL_CALLS, 'controller\\n');
console.log(JSON.stringify({Web:{}}));
` });
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PLACEMENT_SSH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.PLACEMENT_REMOTE_FAIL === '1') {
 console.log(JSON.stringify({ok:false, failure:{code:'tailscale_operator_authorization_refused', retryable:false, remediation:'configure the operator on the server host'}}));
 process.exit(7);
}
console.log(JSON.stringify({ok:true, httpsUrl:process.env.PLACEMENT_PUBLIC_URL, url:process.env.PLACEMENT_PUBLIC_URL}));
` });
  writeFakeBin({ root: fixture.root, name: 'mutagen', content: `#!/usr/bin/env node
(async () => {
const { captureDevTargetSyncFixture } = await import(${JSON.stringify(new URL('./testkit/core/dev_target_sync.mjs', import.meta.url).href)});
const result = captureDevTargetSyncFixture('mutagen', process.argv.slice(2));
process.stdout.write(result?.out ?? '');
})();
` });
  const env = buildStackFixtureEnv({ stripStackEnv: true, stackName,
    homeDir: fixture.path('home'), storageDir: fixture.path('storage'),
    extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '0', HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1', HAPPIER_TAILSCALE_BIN: controller.binPath,
      PATH: ssh.binDir + ':' + process.env.PATH, PLACEMENT_PUBLIC_URL: publicUrl,
      PLACEMENT_LOCAL_CALLS: fixture.path('local-calls'), PLACEMENT_SSH_CALLS: fixture.path('ssh-calls') } });
  for (const action of ['url', 'enable', 'status', 'disable', 'reset']) {
    const result = await runNodeCapture(['apps/stack/scripts/tailscale.mjs', action, '--json'], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env });
    assert.equal(await readFile(fixture.path('local-calls'), 'utf8').catch(() => ''), '',
      'remote placement must never run tailscale on the controller');
    assert.equal(result.code, 0, result.stderr);
    const calls = await readFile(fixture.path('ssh-calls'), 'utf8');
    assert.match(calls, /placed-worker/);
    assert.match(calls, /tailscale/);
    assert.match(calls, /stack-state/);
    assert.equal(calls.includes('3009'), false, 'controller forward is not a remote upstream');
    if (action === 'enable') assert.match(await readFile(baseDir + '/env', 'utf8'), /HAPPIER_PUBLIC_SERVER_URL=/);
  }
  const wrapped = await runNodeCapture([
    'apps/stack/scripts/stack.mjs', 'tailscale:enable', stackName,
    '--', '--https-port=9447', '--json',
  ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env });
  assert.equal(wrapped.code, 0, wrapped.stderr);
  assert.equal(JSON.parse(wrapped.stdout).httpsUrl, publicUrl);
  const remoteArgs = JSON.parse((await readFile(fixture.path('ssh-calls'), 'utf8')).trim().split('\n').at(-1));
  assert.match(remoteArgs.join(' '), /--https-port=9447/,
    'the stack wrapper must retain the listener operand through placed-server dispatch');
  await unlink(baseDir + '/stack.runtime.json');
  const cold = await runNodeCapture(['apps/stack/scripts/tailscale.mjs', 'url', '--json'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env,
  });
  assert.equal(cold.code, 0, cold.stderr);
  assert.equal(JSON.parse(cold.stdout).url, publicUrl);

  const retainedEnv = await readFile(baseDir + '/env', 'utf8');
  const refused = await runNodeCapture(['apps/stack/scripts/tailscale.mjs', 'enable', '--json'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...env, PLACEMENT_REMOTE_FAIL: '1' },
  });
  assert.equal(refused.code, 7);
  assert.equal(JSON.parse(refused.stdout).failure.code, 'tailscale_operator_authorization_refused');
  assert.equal(await readFile(baseDir + '/env', 'utf8'), retainedEnv);
  assert.equal(await readFile(fixture.path('local-calls'), 'utf8').catch(() => ''), '');

  const sshCalls = await readFile(fixture.path('ssh-calls'), 'utf8');
  await writeFile(baseDir + '/stack.runtime.json', JSON.stringify({ placement: { server: 'local' } }));
  await runNodeCapture(['apps/stack/scripts/tailscale.mjs', 'url', '--json'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env,
  });
  assert.match(await readFile(fixture.path('local-calls'), 'utf8'), /controller/);
  assert.equal(await readFile(fixture.path('ssh-calls'), 'utf8'), sshCalls);

});
