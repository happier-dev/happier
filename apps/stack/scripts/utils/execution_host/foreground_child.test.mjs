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
