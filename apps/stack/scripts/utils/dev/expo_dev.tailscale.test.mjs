import test from 'node:test';
import assert from 'node:assert/strict';

function killChildren(children) {
  for (const child of children) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}

test('ensureDevExpoServer exports the Tailscale proxy URL before spawning Expo', async () => {
  const { mkdtemp, mkdir, rm, writeFile, chmod, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const net = await import('node:net');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-proxy-'));
  const children = [];

  try {
    const metroPort = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        server.close(() => {
          if (!addr || typeof addr === 'string') {
            reject(new Error('failed to allocate test port'));
          } else {
            resolve(Number(addr.port));
          }
        });
      });
    });
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const tailscaleBin = join(tmp, 'tailscale');
    const envOut = join(tmp, 'expo-env.json');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TEST_EXPO_ENV_OUT, JSON.stringify({
  EXPO_PACKAGER_PROXY_URL: process.env.EXPO_PACKAGER_PROXY_URL ?? '',
  EXPO_PUBLIC_HAPPIER_SERVER_URL: process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL ?? ''
}));
setInterval(() => {}, 1000);
`,
      'utf-8'
    );
    await writeFile(
      tailscaleBin,
      `#!${process.execPath}
if (process.argv.slice(2).join(' ') === 'ip -4') {
  console.log('127.0.0.1');
  process.exit(0);
}
process.exit(1);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_EXPO_DEV_PORT: String(metroPort),
        HAPPIER_STACK_EXPO_HOST: 'localhost',
        TEST_EXPO_ENV_OUT: envOut,
      },
      apiServerUrl: 'http://localhost:3005',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-tailscale',
      envPath: join(tmp, 'stack.env'),
      children,
      expoTailscale: true,
      quiet: true,
    });

    assert.equal(result.ok, true);
    let envSnapshotRaw = '';
    const deadline = Date.now() + 2_000;
    while (!envSnapshotRaw && Date.now() < deadline) {
      try {
        envSnapshotRaw = await readFile(envOut, 'utf-8');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(envSnapshotRaw, `expected Expo stub to write env snapshot at ${envOut}`);
    const envSnapshot = JSON.parse(envSnapshotRaw);
    assert.equal(envSnapshot.EXPO_PACKAGER_PROXY_URL, `http://127.0.0.1:${metroPort}`);
    assert.equal(envSnapshot.EXPO_PUBLIC_HAPPIER_SERVER_URL, 'http://127.0.0.1:3005');
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer keeps existing Expo when requested Tailscale is unavailable', async () => {
  const { mkdtemp, mkdir, rm, writeFile, chmod, access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');
  const { getExpoStatePaths } = await import('../expo/expo.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-unavailable-'));
  const children = [];

  try {
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const tailscaleBin = join(tmp, 'tailscale');
    const spawnOut = join(tmp, 'expo-spawned');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.TEST_EXPO_SPAWN_OUT, 'spawned');
setInterval(() => {}, 1000);
`,
      'utf-8'
    );
    await writeFile(
      tailscaleBin,
      `#!${process.execPath}
process.exit(1);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    await mkdir(dirname(paths.statePath), { recursive: true });
    await writeFile(
      paths.statePath,
      JSON.stringify(
        {
          pid: process.pid,
          port: 8081,
          uiDir,
          projectDir: uiDir,
          startedAt: new Date().toISOString(),
          webEnabled: false,
          devClientEnabled: true,
          host: 'localhost',
          apiServerUrl: 'http://localhost:3005',
          scheme: 'happy',
          tailscaleEnabled: false,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_EXPO_HOST: 'localhost',
        TEST_EXPO_SPAWN_OUT: spawnOut,
      },
      apiServerUrl: 'http://localhost:3005',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-tailscale-unavailable',
      envPath: join(tmp, 'stack.env'),
      children,
      expoTailscale: true,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_running');
    await assert.rejects(() => access(spawnOut, constants.F_OK));
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});

test('ensureDevExpoServer records Tailscale disabled when the forwarder is unavailable', async () => {
  const { mkdtemp, mkdir, rm, writeFile, chmod, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ensureDevExpoServer } = await import('./expo_dev.mjs');
  const { getExpoStatePaths } = await import('../expo/expo.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-ts-state-'));
  const children = [];

  try {
    const uiDir = join(tmp, 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    const tailscaleBin = join(tmp, 'tailscale');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
      expoBin,
      `#!${process.execPath}
setInterval(() => {}, 1000);
`,
      'utf-8'
    );
    await writeFile(
      tailscaleBin,
      `#!${process.execPath}
process.exit(1);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
      await chmod(tailscaleBin, 0o755);
    }

    const result = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: {
        ...process.env,
        HAPPIER_TAILSCALE_BIN: tailscaleBin,
        HAPPIER_STACK_EXPO_HOST: 'localhost',
      },
      apiServerUrl: 'http://localhost:3005',
      restart: false,
      stackMode: true,
      runtimeStatePath: null,
      stackName: 'qa-agent-tailscale-state',
      envPath: join(tmp, 'stack.env'),
      children,
      expoTailscale: true,
      quiet: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.tailscale?.ok, false);

    const paths = getExpoStatePaths({
      baseDir: tmp,
      kind: 'expo-dev',
      projectDir: uiDir,
      stateFileName: 'expo.state.json',
    });
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    assert.equal(state.tailscaleEnabled, false);
    assert.equal(state.tailscaleForwarderPid, null);
    assert.equal(state.tailscaleIp, null);
  } finally {
    killChildren(children);
    await rm(tmp, { recursive: true, force: true });
  }
});
