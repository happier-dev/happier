import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPidAlive } from './pids.mjs';
import { killProcessGroupOwnedByStack } from './ownership.mjs';

function spawnOwnedGracefulExit({ env, exitFile, readyFile }) {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v == null) continue;
    cleanEnv[k] = String(v);
  }

  // Wait for SIGINT/SIGTERM, then write a marker file right before exiting.
  const code = `
    const fs = require('fs');
    const exitFile = process.argv[1];
    const readyFile = process.argv[2];
    function onStop() {
      setTimeout(() => {
        try { fs.writeFileSync(exitFile, 'ok'); } catch {}
        process.exit(0);
      }, 120);
    }
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    try { fs.writeFileSync(readyFile, 'ready'); } catch {}
    setInterval(() => {}, 1000);
  `;

  const child = spawn(process.execPath, ['-e', code, exitFile, readyFile], {
    env: cleanEnv,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child;
}

async function waitForCondition({ description, timeoutMs, intervalMs = 30, fn }) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for condition: ${description}`);
}

async function waitForFile(path, timeoutMs) {
  await waitForCondition({
    description: `file to exist at ${path}`,
    timeoutMs,
    fn: async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  });
}

async function waitForFileContent(path, timeoutMs) {
  let content = '';
  await waitForCondition({
    description: `file content at ${path}`,
    timeoutMs,
    fn: async () => {
      try {
        content = (await readFile(path, 'utf-8')).trim();
        return Boolean(content);
      } catch {
        return false;
      }
    },
  });
  return content;
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

test('killProcessGroupOwnedByStack allows graceful exit before SIGKILL', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-grace-'));
  const envPath = join(tmp, 'env');
  const exitFile = join(tmp, 'exited.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawnOwnedGracefulExit({
    readyFile,
    exitFile,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: 't',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
  });

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');

    await waitForFile(readyFile, 1200);

    const res = await killProcessGroupOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      cliHomeDir: '',
      json: true,
      graceMs: 600,
    });

    assert.equal(res.killed, true);
    assert.equal(isPidAlive(child.pid), false, 'expected child to exit');

    await waitForFile(exitFile, 1200);
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('killProcessGroupOwnedByStack honors requested initial signal when provided', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signaling semantics');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-kill-signal-'));
  const envPath = join(tmp, 'env');
  const signalFile = join(tmp, 'signal.txt');
  const readyFile = join(tmp, 'ready.txt');

  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const fs = require('fs');
      const signalFile = process.argv[1];
      const readyFile = process.argv[2];
      let done = false;
      function onSignal(sig) {
        if (done) return;
        done = true;
        try { fs.writeFileSync(signalFile, sig); } catch {}
        setTimeout(() => process.exit(0), 30);
      }
      process.on('SIGINT', () => onSignal('SIGINT'));
      process.on('SIGTERM', () => onSignal('SIGTERM'));
      try { fs.writeFileSync(readyFile, 'ready'); } catch {}
      setInterval(() => {}, 1000);
    `,
      signalFile,
      readyFile,
    ],
    {
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: 't',
        HAPPIER_STACK_ENV_FILE: envPath,
      },
      stdio: 'ignore',
      detached: true,
    }
  );
  child.unref();

  try {
    assert.ok(Number(child.pid) > 1, 'expected child pid');
    assert.ok(isPidAlive(child.pid), 'expected child alive before kill');
    await waitForFile(readyFile, 1200);

    const res = await killProcessGroupOwnedByStack(child.pid, {
      stackName: 't',
      envPath,
      signal: 'SIGTERM',
      graceMs: 600,
      json: true,
    });
    assert.equal(res.killed, true);

    const firstSignal = await waitForFileContent(signalFile, 1200);
    assert.ok(firstSignal, 'expected signal marker file to be written');
    assert.equal(firstSignal, 'SIGTERM');
  } finally {
    killGroup(child.pid);
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
