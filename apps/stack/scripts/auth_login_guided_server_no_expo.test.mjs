import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authScriptPath, runNodeCapture } from './testkit/auth_testkit.mjs';

async function ensureMinimalMonorepoWithStubCli({ monoRoot, includeSourceCli = true } = {}) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  if (!includeSourceCli) {
    return;
  }

  await mkdir(join(monoRoot, 'apps', 'cli', 'bin'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'dist'), { recursive: true });

  // startLocalDaemonWithAuth() checks for dist/index.mjs existence even if we never get there.
  await writeFile(join(monoRoot, 'apps', 'cli', 'dist', 'index.mjs'), 'export {};\n', 'utf-8');

  // Stub `happier` CLI: accept any args and exit 0 (keeps the test non-interactive).
  await writeFile(
    join(monoRoot, 'apps', 'cli', 'bin', 'happier.mjs'),
    "process.exit(0);\n",
    'utf-8'
  );
}

async function createHealthyServer({ rootBody = 'ok', rootContentType = 'text/plain' } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', rootContentType);
    res.end(rootBody);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);
  return { server, port };
}

async function reserveUnusedPort() {
  const server = createServer((_, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected reserved port, got ${String(port)}`);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function buildGuidedNoExpoFixture({
  publicServerUrl = '',
  runtimeSnapshot = false,
  runtimeOwnerAlive = false,
  startServer = true,
  stackName = 'main',
  rootBody = 'ok',
  rootContentType = 'text/plain',
  includeSourceCli = true,
  runtimeCliScript = '#!/bin/sh\nexit 0\n',
} = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-guided-no-expo-'));
  const storageDir = join(tmp, 'storage');
  const monoRoot = join(tmp, 'happier');
  await ensureMinimalMonorepoWithStubCli({ monoRoot, includeSourceCli });

  const serverFixture = startServer ? await createHealthyServer({ rootBody, rootContentType }) : null;
  const server = serverFixture?.server ?? null;
  const port = serverFixture?.port ?? (await reserveUnusedPort());
  await mkdir(join(storageDir, stackName), { recursive: true });
  const envPath = join(storageDir, stackName, 'env');
  await writeFile(
    envPath,
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_SERVER_PORT=${port}`,
      ...(publicServerUrl ? [`HAPPIER_STACK_SERVER_URL=${publicServerUrl}`] : []),
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n'),
    'utf-8'
  );

  await writeFile(
    join(storageDir, stackName, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName,
      ownerPid: runtimeOwnerAlive ? process.pid : undefined,
      ports: { server: port },
    }) + '\n',
    'utf-8'
  );
  if (runtimeSnapshot) {
    const snapshotDir = join(storageDir, stackName, 'runtime', 'builds', 'snap-auth');
    await mkdir(join(snapshotDir, 'ui'), { recursive: true });
    await mkdir(join(snapshotDir, 'server'), { recursive: true });
    await mkdir(join(snapshotDir, 'cli'), { recursive: true });
    await writeFile(join(snapshotDir, 'ui', 'index.html'), '<!doctype html><html><body>runtime ui</body></html>\n', 'utf-8');
    const serverBinaryPath = join(snapshotDir, 'server', 'happier-server');
    const cliBinaryPath = join(snapshotDir, 'cli', 'happier');
    await writeFile(serverBinaryPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    await writeFile(cliBinaryPath, runtimeCliScript, 'utf-8');
    await chmod(serverBinaryPath, 0o755);
    await chmod(cliBinaryPath, 0o755);
    await writeFile(
      join(snapshotDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        snapshotId: 'snap-auth',
        sourceFingerprint: 'src-auth',
        components: {
          web: { artifactFingerprint: 'web-auth', entrypoint: 'ui/index.html' },
          server: { artifactFingerprint: 'srv-auth', entrypoint: 'server/happier-server' },
          daemon: { artifactFingerprint: 'cli-auth', entrypoint: 'cli/happier' },
        },
      }) + '\n',
      'utf-8',
    );
    await writeFile(
      join(storageDir, stackName, 'runtime', 'current.json'),
      JSON.stringify({
        version: 1,
        snapshotId: 'snap-auth',
        snapshotPath: snapshotDir,
        sourceFingerprint: 'src-auth',
      }) + '\n',
      'utf-8',
    );
  }

  return {
    tmp,
    server,
    port,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_TEST_TTY: '1',
      HAPPIER_STACK_AUTH_FLOW: '0',
      HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '1',
      HAPPIER_STACK_AUTH_EXPO_SOFT_TIMEOUT_MS: '1',
      HAPPIER_NO_BROWSER_OPEN: '1',
    },
    async cleanup() {
      if (server) {
        await new Promise((resolvePromise) => server.close(resolvePromise));
      }
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('hstack auth login --webapp=expo fails closed when Expo web UI is not ready (does not fall back to server URL)', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=expo'], {
      cwd: rootDir,
      env: fixture.env,
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.match(
      res.stderr,
      /guid(ed)? login web UI is still not ready|startup failed/i,
      `stderr:\n${res.stderr}`
    );
    assert.match(res.stderr, /Stack runtime path:/i, `stderr:\n${res.stderr}`);
    assert.match(res.stderr, /server health:/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout, new RegExp(`URL: http://localhost:${fixture.port}\\b`), `stdout:\n${res.stdout}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) prefers the runtime-backed stack UI over Expo when a runtime snapshot is active', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
        fixture = await buildGuidedNoExpoFixture({
          stackName: 'dev-built',
          runtimeSnapshot: true,
          rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
          rootContentType: 'text/html',
        });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=stack'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for runtime-backed auth without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login uses the active runtime snapshot cli for the actual login flow', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      const markerPath = join(await mkdtemp(join(tmpdir(), 'hstack-auth-runtime-cli-marker-')), 'runtime-cli-args.log');
        fixture = await buildGuidedNoExpoFixture({
          stackName: 'dev-built',
          runtimeSnapshot: true,
          includeSourceCli: false,
          rootBody: '<!doctype html><html><body>runtime ui</body></html>\n<!-- Welcome to Happier Server! -->\n',
          rootContentType: 'text/html',
          runtimeCliScript:
          '#!/bin/sh\n' +
          'if [ -n "$RUNTIME_AUTH_MARKER" ]; then\n' +
          '  printf "%s\\n" "$@" >> "$RUNTIME_AUTH_MARKER"\n' +
          'fi\n' +
          'exit 0\n',
      });
      fixture.markerPath = markerPath;
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--no-open'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
        RUNTIME_AUTH_MARKER: fixture.markerPath,
      },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for runtime-backed auth\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const markerRaw = await readFile(fixture.markerPath, 'utf-8');
    assert.match(markerRaw, /^auth$/m, `expected runtime cli to receive auth command\n${markerRaw}`);
    assert.match(markerRaw, /^login$/m, `expected runtime cli to receive login command\n${markerRaw}`);
    assert.match(markerRaw, /^--no-open$/m, `expected runtime cli to receive --no-open\n${markerRaw}`);
    assert.match(markerRaw, /^--method$/m, `expected runtime cli to receive --method flag\n${markerRaw}`);
    assert.match(markerRaw, /^web$/m, `expected runtime cli to receive web method\n${markerRaw}`);
  } finally {
    if (fixture?.markerPath) {
      await rm(dirname(fixture.markerPath), { recursive: true, force: true }).catch(() => {});
    }
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login suggests runtime-backed start when a runtime-backed stack is already starting but unhealthy', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-built',
        runtimeSnapshot: true,
        runtimeOwnerAlive: true,
        startServer: false,
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_RUNTIME_MODE: 'prefer',
        HAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS: '1000',
      },
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when runtime-backed server stays unhealthy\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /stack runtime is already starting; waiting for health/i, `stderr:\n${res.stderr}`);
    assert.match(res.stderr, /hstack stack start dev-built --background --runtime/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /hstack stack dev dev-built --background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login suggests stack start for non-Expo guided login when the stack is unhealthy', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({
        stackName: 'dev-public',
        startServer: false,
        runtimeOwnerAlive: true,
        publicServerUrl: 'https://example.invalid',
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=stack'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_AUTH_SERVER_READY_TIMEOUT_MS: '1000',
      },
      input: '\n\n',
    });

    assert.notStrictEqual(res.code, 0, `expected non-zero exit when stack-backed server stays unhealthy\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /hstack stack start dev-public --background/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /hstack stack dev dev-public --background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) prefers Expo web UI in interactive mode and fails closed if Expo is not ready', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: fixture.env,
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable in auto mode\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.match(
      res.stderr,
      /guid(ed)? login web UI is still not ready|startup failed/i,
      `stderr:\n${res.stderr}`
    );
    assert.doesNotMatch(res.stdout, new RegExp(`URL: http://localhost:${fixture.port}\\b`), `stdout:\n${res.stdout}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) does not attempt Expo in service mode', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: { ...fixture.env, HAPPIER_STACK_SERVICE_MODE: '1' },
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for auto auth in service mode without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login (auto) falls back to hosted web app when Expo is not ready and a public URL exists', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture({ publicServerUrl: 'https://example.invalid' });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web'], {
      cwd: rootDir,
      env: fixture.env,
      input: '2\n',
    });
    assert.equal(res.code, 0, `expected exit 0 when auto auth falls back to hosted web app\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /falling back to hosted/i, `stderr:\n${res.stderr}`);
    assert.match(res.stdout, /Pick \[1-\d+\]/i, `expected interactive fallback prompt\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --method=mobile succeeds even when Expo web UI is not running', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'mobile'], {
      cwd: rootDir,
      env: fixture.env,
      input: '\n\n',
    });
    assert.equal(res.code, 0, `expected exit 0 for mobile auth without Expo\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Expo web UI/i, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr, /attempted to start stack UI in background/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});

test('hstack auth login --webapp=expo prints progress messages while waiting for Expo to become ready', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  let fixture;
  try {
    try {
      fixture = await buildGuidedNoExpoFixture();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }
    const res = await runNodeCapture([authScriptPath(rootDir), 'login', '--method', 'web', '--webapp=expo'], {
      cwd: rootDir,
      env: {
        ...fixture.env,
        HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '50',
        HAPPIER_STACK_AUTH_EXPO_PROGRESS_INTERVAL_MS: '1',
        HAPPIER_STACK_AUTH_UI_START_TIMEOUT_MS: '10',
      },
      input: '\n\n',
    });
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /still starting|Expo dev server is running/i, `stderr:\n${res.stderr}`);
  } finally {
    if (fixture) await fixture.cleanup();
  }
});
