import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { recordStackRuntimeStart } from '../stack/runtime_state.mjs';
import { buildRemoteStackAttachCommand, resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { parseDaemonReadinessLine } from './daemon_readiness.mjs';
import { allocateAvailableLocalhostPort } from '../../testkit/core/ephemeral_port.mjs';
import { waitForServerReady } from '../server/server.mjs';

test('generated attachment owns scoped readiness without inherited Stack environment', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-attach-readiness-' });
  const target = { name: 'attach-readiness', platform: 'posix', repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)), cliHomeDir: fixture.path('remote') };
  for (const runtimeMode of ['source', 'source-snapshot']) {
    const stackName = `attach-${runtimeMode}`;
    const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
    const statePath = join(paths.stackBaseDir, 'stack.runtime.json');
    const runtime = await recordStackRuntimeStart(statePath, { stackName, ownerPid: process.pid,
      ...(runtimeMode === 'source-snapshot' ? { sourceRuntimeIdentities: { daemon: { selected: 'daemon-new', loaded: null } } } : {}),
    });
    // Execute the actual SSH payload. A remote login does not inherit the
    // controller's scoped identity; only the command producer can supply it.
    const child = spawn('bash', ['-c', buildRemoteStackAttachCommand(target, { stackName, runtimeMode })], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ended = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      await ended;
    });
    const states = [];
    let reload;
    const reloadRequired = new Promise(resolve => { reload = resolve; });
    let ready;
    const running = new Promise(resolve => { ready = resolve; });
    let starting;
    const awaitingIdentity = new Promise(resolve => { starting = resolve; });
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const fact = parseDaemonReadinessLine(line);
        if (fact) states.push(fact.state);
        if (fact?.state === 'running') ready();
        if (fact?.state === 'starting') starting();
        if (fact?.state === 'reload-required') reload();
      }
    });
    await Promise.race([
      new Promise(resolve => child.stderr.on('data', chunk => {
        if (String(chunk).includes('observing runtime')) resolve();
      })),
      ended.then(() => { throw new Error('generated attachment exited before observing its owner'); }),
    ]);
    assert.deepEqual(states, ['sign-in-required']);
    const serverDir = join(paths.cliHomeDir, 'servers', paths.activeServerId);
    await mkdir(serverDir, { recursive: true });
    await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid }));
    // A retained daemon is already alive. Login itself must wake readiness,
    // without requiring an unrelated runtime-state publication afterwards.
    await writeFile(join(serverDir, 'access.key'), randomBytes(32));
    if (runtimeMode === 'source-snapshot') {
      await Promise.race([awaitingIdentity, running.then(() => { throw new Error('daemon reported running before loaded identity publication'); })]);
      await writeFile(`${statePath}.next`, JSON.stringify({ ...runtime,
        sourceRuntimeIdentities: { daemon: { selected: 'daemon-new', loaded: 'daemon-new' } } }));
      await rename(`${statePath}.next`, statePath);
    }
    await Promise.race([running, ended.then(() => { throw new Error('attachment ended before native daemon readiness'); })]);
    assert.deepEqual(states, runtimeMode === 'source-snapshot' ? ['sign-in-required', 'starting', 'running'] : ['sign-in-required', 'running']);
    await writeFile(join(serverDir, 'daemon.state.json.next'), JSON.stringify({ pid: process.pid,
      sourceRuntimeReloadRequired: { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'closure_changed' } }));
    await rename(join(serverDir, 'daemon.state.json.next'), join(serverDir, 'daemon.state.json'));
    await Promise.race([reloadRequired, ended.then(() => { throw new Error('attachment ended before dependency refusal'); })]);
    assert.deepEqual(states, runtimeMode === 'source-snapshot'
      ? ['sign-in-required', 'starting', 'running', 'reload-required']
      : ['sign-in-required', 'running', 'reload-required']);
    child.kill('SIGTERM');
    await ended;
  }
});

test('runtime observation can disconnect and reattach without killing its detached HTTP owner', { timeout: 15_000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-runtime-observer-' });
  const statePath = join(root, 'stack.runtime.json');
  const logPath = join(root, 'logs', 'run.log');
  const port = await allocateAvailableLocalhostPort();
  await mkdir(join(root, 'logs'));
  await writeFile(logPath, 'initial-runtime-line\n');
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    createServer((req, res) => res.end(req.url === '/health' ? JSON.stringify({ service: 'happier-server', status: 'ok' }) : 'same-owner')).listen(Number(process.argv[1]), '127.0.0.1');
  `, String(port)], { detached: process.platform !== 'win32', stdio: 'ignore' });
  const children = [owner];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode != null || child.signalCode != null) return;
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }));
  });
  await waitForServerReady(`http://127.0.0.1:${port}`);
  const runtime = await recordStackRuntimeStart(statePath, { stackName: 'fixture', ownerPid: owner.pid, logs: { runner: logPath } });
  const attach = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./runtime_observer.mjs', import.meta.url)),
      statePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const ready = new Promise((resolve, reject) => {
      child.stderr.on('data', chunk => { if (String(chunk).includes('observing runtime')) resolve(); });
      child.once('exit', code => reject(new Error(`observer exited before attachment (${code})`)));
    });
    await ready;
    return { child, output: () => output };
  };
  const first = await attach();
  assert.doesNotMatch(first.output(), /initial-runtime-line/, 'initial observation does not replay completed startup phases');
  const firstExit = once(first.child, 'exit');
  first.child.kill('SIGTERM');
  await firstExit;
  assert.equal(owner.exitCode, null, 'disconnecting observation must not retire the runtime owner');
  const second = await attach();
  const appended = new Promise(resolve => second.child.stdout.on('data', () => {
    if (second.output().includes('new-runtime-line')) resolve();
  }));
  await appendFile(logPath, 'new-runtime-line\n');
  await appended;
  assert.doesNotMatch(second.output(), /initial-runtime-line/, 'reattachment does not replay historical output');
  const rotated = new Promise(resolve => second.child.stdout.on('data', () => {
    if (second.output().includes('rotated-runtime-line')) resolve();
  }));
  await rename(logPath, `${logPath}.1`);
  await writeFile(logPath, 'rotated-runtime-line\n');
  await rotated;
  assert.equal(second.child.exitCode, null, 'log rotation must not end observation of a healthy owner');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'same-owner');
  const ended = once(second.child, 'exit');
  await rm(statePath);
  assert.equal((await ended)[0], 1, 'normal lifecycle removal wakes observation without a new polling loop');
  assert.equal(owner.pid, runtime.ownerPid);
});

for (const runtimeMode of ['source-snapshot', 'controlled']) {
  test(`server-only ${runtimeMode} attachment streams logs without asking for daemon sign-in`,
    { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
      const fixture = await createTempFixture(t, { prefix: 'hstack-server-attachment-' });
      const target = { name: 'server-only', platform: 'posix',
        repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)), cliHomeDir: fixture.path('remote') };
      const stackName = 'server-only';
      const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode });
      const statePath = join(paths.stackBaseDir, 'stack.runtime.json');
      const logPath = join(paths.stackBaseDir, 'logs', 'run.log');
      await mkdir(join(paths.stackBaseDir, 'logs'), { recursive: true });
      await writeFile(logPath, '');
      await recordStackRuntimeStart(statePath, { stackName, ownerPid: process.pid,
        placement: { server: 'local', daemon: 'disabled' }, logs: { runner: logPath } });
      const child = spawn('bash', ['-c', buildRemoteStackAttachCommand(target, { stackName, runtimeMode })], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const ended = once(child, 'exit');
      t.after(async () => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
        await ended;
      });
      let output = '';
      let observed;
      const attached = new Promise(resolve => { observed = resolve; });
      child.stderr.on('data', chunk => { if (String(chunk).includes('observing runtime')) observed(); });
      let streamed;
      const logSeen = new Promise(resolve => { streamed = resolve; });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('server-still-running')) streamed();
      });
      const prematureExit = ended.then(() => { throw new Error('server attachment exited before streaming'); });
      await Promise.race([attached, prematureExit]);
      await appendFile(logPath, 'server-still-running\n');
      await Promise.race([logSeen, prematureExit]);
      assert.deepEqual(output.split('\n').map(parseDaemonReadinessLine).filter(Boolean), [],
        'a server-only host has no daemon sign-in authority');
      assert.equal(child.exitCode, null);
    });
}
