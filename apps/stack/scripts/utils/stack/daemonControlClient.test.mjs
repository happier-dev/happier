import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  pingDaemon,
  readDaemonControlState,
  resolveDaemonRestartConfirmTimeoutMs,
  restartDaemonViaControlServer,
} from './daemonControlClient.mjs';
import { resolvePreferredStackDaemonStatePaths } from '../auth/credentials_paths.mjs';

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writeDaemonState({ cliHomeDir, serverUrl, env, state }) {
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), 'utf8');
}

test('pingDaemon posts /ping with the daemon control token from state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hstack-daemon-control-client-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  let observedToken = '';
  await withServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ping') {
      observedToken = String(req.headers['x-happier-daemon-token'] ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  }, async ({ port }) => {
    const serverUrl = 'http://127.0.0.1:3009';
    await writeDaemonState({
      cliHomeDir: home,
      serverUrl,
      state: { pid: process.pid, httpPort: port, controlToken: 'state-token' },
    });

    const result = await pingDaemon({ cliHomeDir: home, serverUrl });
    assert.equal(result.ok, true);
    assert.equal(observedToken, 'state-token');
  });
});

test('readDaemonControlState rejects a live daemon pid that is not owned by the current stack', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hstack-daemon-control-unowned-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const serverUrl = 'http://127.0.0.1:3009';
  const env = {
    HAPPIER_STACK_STACK: 'remote-dev',
    HAPPIER_STACK_ENV_FILE: join(home, 'env'),
  };
  const ownershipCalls = [];
  await writeDaemonState({
    cliHomeDir: home,
    serverUrl,
    env,
    state: { pid: process.pid, httpPort: 12345, controlToken: 'state-token' },
  });

  const result = await readDaemonControlState({
    cliHomeDir: home,
    serverUrl,
    env,
    stackName: 'remote-dev',
    resolvePidStackOwnershipImpl: async (pid, context) => {
      ownershipCalls.push({ pid: Number(pid), context });
      return { owned: false, reason: 'stack_name_mismatch' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon_not_owned');
  assert.equal(result.pid, process.pid);
  assert.equal(result.ownershipReason, 'stack_name_mismatch');
  assert.deepEqual(ownershipCalls, [{
    pid: process.pid,
    context: {
      stackName: 'remote-dev',
      envPath: env.HAPPIER_STACK_ENV_FILE,
      cliHomeDir: home,
    },
  }]);
});

test('restartDaemonViaControlServer posts /restart without leaking token in failures', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hstack-daemon-control-restart-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  await withServer((req, res) => {
    if (req.method === 'POST' && req.url === '/restart') {
      res.statusCode = 500;
      res.end('nope');
      return;
    }
    res.statusCode = 404;
    res.end();
  }, async ({ port }) => {
    const serverUrl = 'http://127.0.0.1:3009';
    await writeDaemonState({
      cliHomeDir: home,
      serverUrl,
      state: { pid: process.pid, httpPort: port, controlToken: 'super-secret-token' },
    });

    await assert.rejects(
      () => restartDaemonViaControlServer({ cliHomeDir: home, internalServerUrl: serverUrl }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /daemon control \/restart failed/);
        assert.doesNotMatch(error.message, /super-secret-token/);
        return true;
      },
    );
  });
});

test('restartDaemonViaControlServer resolves only after the replacement daemon is pingable', async () => {
  const observed = [];
  let readCount = 0;

  const result = await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    timeoutMs: 100,
    pollMs: 1,
    delayImpl: async () => {},
    readDaemonControlStateImpl: async () => {
      readCount += 1;
      const pid = readCount < 3 ? 111 : 222;
      const httpPort = pid === 111 ? 5001 : 5002;
      observed.push(`read:${pid}`);
      return {
        ok: true,
        statePath: '/tmp/daemon.state.json',
        state: { pid, httpPort, controlToken: 'state-token' },
        pid,
        httpPort,
        controlToken: 'state-token',
      };
    },
    daemonControlPostImpl: async ({ path, httpPort }) => {
      observed.push(`${path}:${httpPort}`);
      if (path === '/restart') return { status: 'restarting' };
      if (path === '/ping') return { status: 'ok' };
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.equal(result.status, 'restarting');
  assert.equal(result.pid, 222);
  assert.deepEqual(observed, [
    'read:111',
    '/restart:5001',
    'read:111',
    'read:222',
    '/ping:5002',
  ]);
});

test('restartDaemonViaControlServer always posts an empty restart body', async () => {
  const observedBodies = [];
  let readCount = 0;

  await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    restartSessionRunners: false,
    timeoutMs: 100,
    pollMs: 1,
    delayImpl: async () => {},
    readDaemonControlStateImpl: async () => {
      readCount += 1;
      const pid = readCount < 3 ? 111 : 222;
      return {
        ok: true,
        statePath: '/tmp/daemon.state.json',
        state: { pid, httpPort: 5000 + readCount, controlToken: 'state-token' },
        pid,
        httpPort: 5000 + readCount,
        controlToken: 'state-token',
      };
    },
    daemonControlPostImpl: async ({ path, body }) => {
      if (path === '/restart') {
        observedBodies.push(body);
        return { status: 'restarting' };
      }
      if (path === '/ping') return { status: 'ok' };
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.deepEqual(observedBodies, [{}]);
});

test('restartDaemonViaControlServer passes stack identity to initial and replacement control-state reads', async () => {
  const observedContexts = [];
  let readCount = 0;
  const env = {
    HAPPIER_STACK_STACK: 'remote-dev',
    HAPPIER_STACK_ENV_FILE: '/tmp/remote-dev-env',
  };

  await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    stackName: 'remote-dev',
    env,
    timeoutMs: 100,
    pollMs: 1,
    delayImpl: async () => {},
    readDaemonControlStateImpl: async (context) => {
      observedContexts.push(context);
      readCount += 1;
      const pid = readCount < 3 ? 111 : 222;
      return {
        ok: true,
        statePath: '/tmp/daemon.state.json',
        state: { pid, httpPort: 5000 + readCount, controlToken: 'state-token' },
        pid,
        httpPort: 5000 + readCount,
        controlToken: 'state-token',
      };
    },
    daemonControlPostImpl: async ({ path }) => {
      if (path === '/restart') return { status: 'restarting' };
      if (path === '/ping') return { status: 'ok' };
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.equal(observedContexts.length, 3);
  for (const context of observedContexts) {
    assert.equal(context.cliHomeDir, '/tmp/hstack-home');
    assert.equal(context.serverUrl, 'http://127.0.0.1:3009');
    assert.equal(context.stackName, 'remote-dev');
    assert.equal(context.env, env);
  }
});

test('restartDaemonViaControlServer keeps daemon control posts bounded while using a longer replacement budget', async () => {
  const observedPosts = [];
  let readCount = 0;

  await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    env: { HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS: '45000' },
    pollMs: 1,
    delayImpl: async () => {},
    readDaemonControlStateImpl: async () => {
      readCount += 1;
      const pid = readCount < 3 ? 111 : 222;
      return {
        ok: true,
        statePath: '/tmp/daemon.state.json',
        state: { pid, httpPort: 5000 + readCount, controlToken: 'state-token' },
        pid,
        httpPort: 5000 + readCount,
        controlToken: 'state-token',
      };
    },
    daemonControlPostImpl: async ({ path, timeoutMs }) => {
      observedPosts.push({ path, timeoutMs });
      if (path === '/restart') return { status: 'restarting' };
      if (path === '/ping') return { status: 'ok' };
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.deepEqual(observedPosts, [
    { path: '/restart', timeoutMs: 1500 },
    { path: '/ping', timeoutMs: 1500 },
  ]);
});

test('resolveDaemonRestartConfirmTimeoutMs shares the daemon restart verification budget', () => {
  assert.equal(resolveDaemonRestartConfirmTimeoutMs({}), 60_000);
  assert.equal(
    resolveDaemonRestartConfirmTimeoutMs({ HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS: '45000' }),
    45_000,
  );
  assert.equal(
    resolveDaemonRestartConfirmTimeoutMs({ HAPPIER_DAEMON_RESTART_VERIFY_TIMEOUT_MS: 'not-a-number' }),
    60_000,
  );
  assert.equal(
    resolveDaemonRestartConfirmTimeoutMs({}, 250),
    250,
  );
});
