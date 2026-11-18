import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { createTempFixture } from './temp_fixture.mjs';
import { prepareRuntimeSnapshotFixtureLifetime } from './runtime_snapshot_lifetime.mjs';
import { stopRuntimeSnapshotFixture } from './runtime_snapshot_cleanup.mjs';
import { killDetachedProcessGroup, spawnDaemonLikeProcess } from './spawn_daemon_like_process.mjs';
import { removeDirForce } from '../../utils/test/test_cleanup.mjs';

test('started snapshot fixture cleanup retains its directory when its configuration disappears', async t => {
  const stackName = 'missing-config-fixture';
  const fixture = await createTempFixture(null, {
    beforeCleanup: root => stopRuntimeSnapshotFixture({ root, stackName }),
  });
  const stackDir = fixture.path('storage', stackName);
  const envPath = join(stackDir, 'env');
  await prepareRuntimeSnapshotFixtureLifetime(stackDir);
  await writeFile(envPath, '');
  const child = spawnDaemonLikeProcess({
    cliHomeDir: join(stackDir, 'cli'),
    statePaths: [join(stackDir, 'cli', 'daemon.state.json')],
    env: { HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      killDetachedProcessGroup(child.pid, 'SIGKILL');
      await exited;
    }
    await removeDirForce(fixture.root);
  });
  await rm(envPath);
  await assert.rejects(fixture.cleanup(), { code: 'ESTACKFIXTURECLEANUPINCOMPLETE' });
  await access(fixture.root);
});

test('fixture cleanup retains evidence when its resource teardown fails and permits retry', async t => {
  let resourceRunning = true;
  const fixture = await createTempFixture(null, {
    beforeCleanup: async root => {
      if (resourceRunning) {
        assert.equal(await readFile(`${root}/owner`, 'utf8'), 'fixture owner');
        throw Object.assign(new Error('resource is still running'), { code: 'ECLEANUPINCOMPLETE' });
      }
    },
  });
  t.after(async () => {
    resourceRunning = false;
    await fixture.cleanup();
  });
  await writeFile(fixture.path('owner'), 'fixture owner');
  await assert.rejects(fixture.cleanup(), { code: 'ECLEANUPINCOMPLETE' });
  assert.equal(await readFile(fixture.path('owner'), 'utf8'), 'fixture owner');
  resourceRunning = false;
  await fixture.cleanup();
  await assert.rejects(readFile(fixture.path('owner')), { code: 'ENOENT' });
});

test('a terminated test process removes its fixture roots, so a broker it started on one exits', { skip: process.platform !== 'linux' }, async t => {
  // P03-BROKER-W2 (2026-11-18): four fixture brokers (native admission roots /tmp/ha-*) outlived
  // test runs that were stopped with SIGTERM, because node:test runs no after hooks on a signal.
  const script = `
    import { createTempFixture } from ${JSON.stringify(new URL('./temp_fixture.mjs', import.meta.url).href)};
    import { connectAdmissionBroker } from ${JSON.stringify(new URL('../../utils/proc/admission_client.mjs', import.meta.url).href)};
    const fixture = await createTempFixture({ after() {} }, { parentDir: '/tmp', prefix: 'ha-' });
    (await connectAdmissionBroker(fixture.root)).destroy();
    process.stdout.write(fixture.root + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = await once(child.stdout, 'data');
  const root = String(line).trim();
  const listener = () => /pid=(\d+)/.exec(spawnSync('ss', ['-xlpn'], { encoding: 'utf8' }).stdout
    .split('\n').find(row => row.includes(` ${root}/broker.sock `)) ?? '')?.[1];
  const broker = Number(listener());
  assert.ok(broker > 1, 'the fixture client started a broker on its root');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    // Never leave the RED run's broker behind: stop only the PID that listens on this root.
    if (alive(broker) && listener() === String(broker)) process.kill(broker, 'SIGTERM');
    await removeDirForce(root);
  });
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  await assert.rejects(access(root), { code: 'ENOENT' }, 'the terminated test removed its fixture root');
  for (let i = 0; i < 100 && alive(broker); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(broker), false, 'the broker on the removed root exits');
});
