import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { cleanupStaleDaemonState } from './daemon.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

async function spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl }) {
  const logDir = join(cliHomeDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const { createWriteStream } = require('node:fs'); const { join } = require('node:path'); const s = createWriteStream(join(process.env.HAPPIER_HOME_DIR, 'logs', 'daemon-owned.log'), { flags: 'a' }); s.write('ready\\n'); setInterval(() => {}, 1000);",
      'daemon',
      'start-sync',
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: internalServerUrl,
        PATH: '', // Make lsof unavailable
      },
    },
  );
  child.unref();
  return child.pid;
}

test('cleanupStaleDaemonState must not remove lock/state when lsof is unavailable and daemon is running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cleanup-lsof-unavailable-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });

    // Spawn a daemon-like process
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });

    // Write lock and state files pointing to the running daemon
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(daemonPid) + '\n', 'utf-8');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    // Verify files exist before cleanup
    assert.equal(existsSync(lockPath), true, 'lock file should exist before cleanup');
    assert.equal(existsSync(statePath), true, 'state file should exist before cleanup');

    // Run cleanup with PATH set to empty (lsof unavailable)
    await cleanupStaleDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: { PATH: '' } });

    // CRITICAL: Files must NOT be removed when lsof is unavailable and daemon is running
    // This prevents a second daemon from starting while the first is still running
    assert.equal(existsSync(lockPath), true, 'lock file must not be removed when lsof is unavailable and daemon is running');
    assert.equal(existsSync(statePath), true, 'state file must not be removed when lsof is unavailable and daemon is running');

    // Verify the daemon is still running
    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, `daemon pid ${daemonPid} should still be running`);
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('cleanupStaleDaemonState removes lock/state when daemon is not running', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cleanup-stale-'));
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });

    // Write lock and state files pointing to a non-existent PID
    const stalePid = 999999;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(stalePid) + '\n', 'utf-8');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: stalePid, httpPort: 0 }) + '\n', 'utf-8');

    // Verify files exist before cleanup
    assert.equal(existsSync(lockPath), true, 'lock file should exist before cleanup');
    assert.equal(existsSync(statePath), true, 'state file should exist before cleanup');

    // Run cleanup
    await cleanupStaleDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: {} });

    // Files should be removed when daemon is not running
    assert.equal(existsSync(lockPath), false, 'lock file should be removed when daemon is not running');
    assert.equal(existsSync(statePath), false, 'state file should be removed when daemon is not running');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

