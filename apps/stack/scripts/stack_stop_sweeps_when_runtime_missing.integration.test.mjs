import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { isAlive, setupStackStopSweepFixture, spawnOwnedSleep, waitForProcessAlive, waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';

for (const remote of [false, true]) test(`stack stop closes its browser (${remote ? 'remote' : 'local'}) without runtime state and preserves another stack browser`, { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const fixture = await setupStackStopSweepFixture({ importMetaUrl: import.meta.url, t, stackName: 'browser-stop-fixture' });
  t.after(() => fixture.cleanup());
  const { binDir } = writeFakeBin({ root: fixture.tmp, name: 'agent-browser', content: `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a.includes('open'))fs.writeFileSync(path.join(a[a.indexOf('--profile')+1],'DevToolsActivePort'),'40201\\n/devtools/browser/fixture-browser\\n');
else setTimeout(()=>process.exit(0),2500);
` });
  let envPath = fixture.envPath;
  if (remote) {
    const target = { name: 'browser-remote-fixture', platform: 'posix', ssh: 'fixture', repoDir: join(fixture.rootDir, '../..'),
      cliHomeDir: join(fixture.tmp, 'remote-home'), remotePath: [binDir, dirname(process.execPath)] };
    envPath = resolveRemoteStackStatePaths(target, { stackName: fixture.stackName, runtimeMode: 'controlled' }).stackEnvPath;
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(envPath, '');
    await writeFile(join(fixture.baseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
    // Only SSH is replaced; Stack stop, remote command construction, process
    // inventory, browser worker and cleanup are the real production path.
    writeFakeBin({ root: fixture.tmp, name: 'ssh', content: `#!${process.execPath}
const result=require('node:child_process').spawnSync('/bin/bash',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env});process.exit(result.status??1);
` });
    fixture.baseEnv.PATH = `${binDir}:${process.env.PATH}`;
  }
  const env = { ...fixture.baseEnv, PATH: `${binDir}:${process.env.PATH}`, TMPDIR: fixture.tmp,
    HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_PROCESS_KIND: 'browser' };
  const worker = fixture.trackChild(spawn(process.execPath, [join(fixture.rootDir, 'scripts/utils/dev_targets/qa_browser.mjs'), '--worker', 'stack-stop'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  const completion = new Promise(resolve => worker.once('close', (code, signal) => resolve({ code, signal })));
  let output = '', error = '', ready;
  worker.stderr.on('data', chunk => { error += chunk; });
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('close', () => { if (!ready) reject(new Error(error)); });
    worker.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(value => value.startsWith('HSTACK_QA_BROWSER='));
      if (line) { ready = JSON.parse(line.slice('HSTACK_QA_BROWSER='.length)); resolve(); }
    });
  });
  const neighbor = fixture.trackChild(spawnOwnedSleep({ env: { ...env, HAPPIER_STACK_STACK: `${fixture.stackName}-neighbor` } }));
  await waitForProcessAlive({ pid: neighbor.pid });
  const result = await fixture.runStackStop(['--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(isAlive(worker.pid), false, 'stack stop must retire its browser worker');
  assert.deepEqual(await completion, { code: 0, signal: null }, error);
  await assert.rejects(access(ready.profile), { code: 'ENOENT' });
  assert.equal(isAlive(neighbor.pid), true, 'same env path with a different Stack binding must survive');
});

test('hstack stack stop sweeps owned processes when stack.runtime.json is missing', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-stack-stop-sweep-',
  });

  const owned = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  }));
  assert.ok(Number(owned.pid) > 1, 'expected child pid');
  await waitForProcessAlive({ pid: owned.pid, timeoutMs: 2_000, intervalMs: 25, label: 'infra process (pre-stop)' });
  assert.ok(isAlive(owned.pid), 'expected owned child to be alive');

  const sessionLike = fixture.trackChild(spawnOwnedSleep({
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: fixture.stackName,
      HAPPIER_STACK_ENV_FILE: fixture.envPath,
      HAPPIER_STACK_PROCESS_KIND: 'session',
    },
  }));
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
  await waitForProcessAlive({ pid: sessionLike.pid, timeoutMs: 2_000, intervalMs: 25, label: 'session-like process (pre-stop)' });
  assert.ok(isAlive(sessionLike.pid), 'expected session-like child to be alive');

  const res = await fixture.runStackStop(['--json']);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  await waitForProcessExit({ pid: owned.pid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process' });
  assert.ok(!isAlive(owned.pid), `expected owned pid ${owned.pid} to be stopped`);
  assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);
});
