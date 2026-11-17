import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import { runForegroundChild } from './foreground_child.mjs';

test('foreground child forwarding keeps the wrapper alive until delegated cleanup closes', async () => {
  let signalHandler;
  let closeChild;
  const kills = [];
  const child = {
    once(event, listener) {
      if (event === 'close') closeChild = listener;
      return this;
    },
    kill(signal) {
      kills.push(signal);
    },
  };

  const running = runForegroundChild({
    command: '/usr/bin/node',
    args: ['child.mjs'],
    options: { stdio: 'inherit' },
    boundary: {
      spawn() { return child; },
      onSignal(handler) {
        signalHandler = handler;
        return () => {};
      },
    },
  });

  signalHandler('SIGINT');
  assert.deepEqual(kills, ['SIGINT']);

  let settled = false;
  void running.then(() => { settled = true; });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(settled, false, 'the wrapper must wait for descendant cleanup instead of exiting on the signal');

  closeChild(255, null);
  assert.deepEqual(await running, { exitCode: null, signal: 'SIGINT' });
});


test('the public Stack launcher forwards interruption and waits for external-command cleanup', { skip: process.platform === 'win32' ? 'POSIX SIGINT cleanup contract' : false }, async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-foreground-signal-' });
  const bin = fixture.path('bin');
  const pidFile = fixture.path('pid');
  const cleanup = fixture.path('cleanup');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'xcrun');
  // xcrun is an external OS boundary. It models cleanup that must finish after
  // SIGINT, while the real public Stack launcher remains in the path.
  await writeFile(executable, '#!/usr/bin/env node\n' + `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(cleanup)}, 'done'); process.exit(255); });
console.log('FIXTURE_READY');
// Finite external work also lets a broken launcher reach an assertion.
setTimeout(() => process.exit(0), 5000);
`);
  await chmod(executable, 0o755);
  const child = spawn(process.execPath, [new URL('../../../bin/hstack.mjs', import.meta.url).pathname, 'mobile:devices'], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_STACK_CLI_ROOT_DISABLE: '1', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', HAPPIER_STACK_UPDATE_CHECK: '0', HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1' },
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  try {
    let output = '';
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('FIXTURE_READY')) resolve(); });
      closed.then(() => { if (!output.includes('FIXTURE_READY')) reject(new Error('external fixture did not start')); });
    });
    child.kill('SIGINT');
    const result = await closed;
    assert.equal(result.signal, 'SIGINT', 'interruption must survive a transport reporting its own exit code');
    assert.equal(existsSync(cleanup), true, 'host interruption must reach the command and await its cleanup');
  } finally {
    child.kill('SIGKILL');
    if (existsSync(pidFile)) {
      const pid = Number(await readFile(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    }
    await closed;
  }
});

test('a Node foreground child observes its launcher being killed as a hangup', { skip: process.platform === 'win32' ? 'SIGKILL of a POSIX launcher' : false, timeout: 20_000 }, async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-foreground-lifeline-' });
  const launcher = fixture.path('launcher.mjs');
  const payload = fixture.path('payload.mjs');
  // The payload stands in for a retained foreground command (a QA browser
  // holder): it runs until its owner hangs up, then reports that it saw it.
  const pidFile = fixture.path('payload.pid');
  await writeFile(payload, `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
process.on('SIGHUP', () => { process.stdout.write('HANGUP\\n'); process.exit(129); });
require('node:fs').writeFileSync(process.env.PAYLOAD_PID_FILE, String(process.pid));
process.stdout.write('PAYLOAD_READY\\n');
setInterval(() => {}, 1 << 30);
`);
  await writeFile(launcher, `
import { runForegroundChild } from ${JSON.stringify(new URL('./foreground_child.mjs', import.meta.url).href)};
await runForegroundChild({ command: process.execPath, args: [${JSON.stringify(payload)}],
  options: { stdio: 'inherit', detached: true } });
`);
  const child = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PAYLOAD_PID_FILE: pidFile } });
  let payloadPid;
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    // Stop only the payload this test recorded, so a RED run leaves nothing behind.
    if (payloadPid) try { process.kill(payloadPid, 'SIGKILL'); } catch {}
  });
  let output = '';
  const seen = text => new Promise(resolve => {
    const check = () => { if (output.includes(text)) { child.stdout.off('data', onData); resolve(); } };
    const onData = chunk => { output += chunk; check(); };
    child.stdout.on('data', onData);
    check();
  });
  await seen('PAYLOAD_READY');
  payloadPid = Number(await readFile(pidFile, 'utf8'));
  // An agent tool that cancels with SIGKILL gives the launcher no chance to
  // forward a signal; the detached payload is in its own process group.
  process.kill(child.pid, 'SIGKILL');
  await Promise.race([seen('HANGUP'), new Promise((_, reject) => setTimeout(
    () => reject(new Error('payload outlived its killed launcher without a hangup')), 10_000).unref())]);
});
