import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stopLocalDaemon } from './daemon.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  // Ensure stopLocalDaemon launches via dist entrypoint (preferred).
  await writeFile(join(cliDir, 'bin', 'happier.mjs'), 'process.exit(0);\n', 'utf-8');

  const script = `
import { writeFileSync } from 'node:fs';

const markerPath = process.env.MARKER_PATH || '';
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'stop') {
  if (markerPath) {
    writeFileSync(markerPath, 'stopped\\n', 'utf8');
  }
  process.exit(0);
}
process.exit(0);
`.trimStart();

  await writeFile(join(cliDir, 'dist', 'index.mjs'), script, 'utf-8');
  return join(cliDir, 'bin', 'happier.mjs');
}

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
      },
    },
  );
  child.unref();
  return child.pid;
}

test('stopLocalDaemon skips stop when expectedPid does not match current daemon state pid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-expected-pid-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });

    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: 222, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 111,
      env: { ...process.env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), false);

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 222,
      env: { ...process.env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon stops a live daemon from daemon.state.json when cli dist is missing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-missing-dist-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(cliBin), "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    const daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      env: process.env,
    });

    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `expected daemon pid ${daemonPid} to be stopped`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
