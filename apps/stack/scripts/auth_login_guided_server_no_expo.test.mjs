import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authScriptPath, runNodeCapture } from './testkit/auth_testkit.mjs';

async function ensureMinimalMonorepoWithStubCli({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'bin'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli', 'dist'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  // startLocalDaemonWithAuth() checks for dist/index.mjs existence even if we never get there.
  await writeFile(join(monoRoot, 'apps', 'cli', 'dist', 'index.mjs'), 'export {};\n', 'utf-8');

  // Stub `happier` CLI: accept any args and exit 0 (keeps the test non-interactive).
  await writeFile(
    join(monoRoot, 'apps', 'cli', 'bin', 'happier.mjs'),
    "process.exit(0);\n",
    'utf-8'
  );
}

async function createHealthyServer() {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);
  return { server, port };
}

async function buildGuidedNoExpoFixture() {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-auth-guided-no-expo-'));
  const storageDir = join(tmp, 'storage');
  const monoRoot = join(tmp, 'happier');
  await ensureMinimalMonorepoWithStubCli({ monoRoot });

  const { server, port } = await createHealthyServer();
  await mkdir(join(storageDir, 'main'), { recursive: true });
  const envPath = join(storageDir, 'main', 'env');
  await writeFile(
    envPath,
    [
      'HAPPIER_STACK_STACK=main',
      `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
      `HAPPIER_STACK_SERVER_PORT=${port}`,
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      '',
    ].join('\n'),
    'utf-8'
  );

  await writeFile(join(storageDir, 'main', 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: 'main', ports: {} }) + '\n', 'utf-8');

  return {
    tmp,
    server,
    port,
    env: {
      ...process.env,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_TEST_TTY: '1',
      HAPPIER_STACK_AUTH_FLOW: '0',
      HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS: '1',
      HAPPIER_NO_BROWSER_OPEN: '1',
    },
    async cleanup() {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('guided auth login fails closed when Expo web UI is not ready (does not fall back to server URL)', async (t) => {
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
    assert.notStrictEqual(res.code, 0, `expected non-zero exit when Expo is unavailable\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
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
