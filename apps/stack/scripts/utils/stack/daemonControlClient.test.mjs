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
import { applyStackDaemonLifecycleScopeEnv } from '../auth/stable_scope_id.mjs';

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
      res.end(JSON.stringify({ ok: true, distClosureFingerprint: 'abcdef1234567890' }));
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
    assert.equal(result.distClosureFingerprint, 'abcdef1234567890');
    assert.equal(observedToken, 'state-token');
  });
});

test('pingDaemon bootstraps Windows ownership from an authenticated matching daemon runtime', async () => {
  const state = {
    pid: 4242,
    httpPort: 4321,
    controlToken: 'state-token',
    runtimeId: 'runtime-windows',
  };
  const ownershipAttempts = [];
  const fingerprints = ['win32-cim:stable', 'win32-cim:stable'];

  const result = await pingDaemon(
    {
      cliHomeDir: 'C:/Users/test/.happier/target',
      serverUrl: 'http://127.0.0.1:3009',
      stackName: 'remote-windows',
    },
    {
      platform: 'win32',
      readDaemonControlStateImpl: async (input) => {
        ownershipAttempts.push(input.resolvePidStackOwnershipImpl);
        return input.resolvePidStackOwnershipImpl === null
          ? { ok: true, state, pid: state.pid, httpPort: state.httpPort, controlToken: state.controlToken }
          : {
              ok: false,
              reason: 'daemon_not_owned',
              ownershipReason: 'process-identity-unsupported',
              pid: state.pid,
            };
      },
      daemonControlPostImpl: async () => ({ status: 'ok', runtimeId: state.runtimeId }),
      readProcessInstanceFingerprintImpl: () => fingerprints.shift() ?? null,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pid, state.pid);
  assert.equal(result.processInstanceFingerprint, 'win32-cim:stable');
  assert.equal(ownershipAttempts.length, 2);
  assert.equal(ownershipAttempts[1], null);
});

test('restartDaemonViaControlServer reuses the authenticated Windows runtime proof before restarting', async () => {
  let restartPosted = false;
  const ownershipAttempts = [];
  const fingerprints = [
    'win32-cim:old',
    'win32-cim:old',
    'win32-cim:new',
    'win32-cim:new',
  ];

  const result = await restartDaemonViaControlServer({
    cliHomeDir: 'C:/Users/test/.happier/target',
    internalServerUrl: 'http://127.0.0.1:3009',
    stackName: 'remote-windows',
    timeoutMs: 100,
    pollMs: 1,
    delayImpl: async () => {},
    platform: 'win32',
    readDaemonControlStateImpl: async (input) => {
      ownershipAttempts.push(input.resolvePidStackOwnershipImpl);
      const state = restartPosted
        ? {
            pid: 4343,
            httpPort: 4322,
            controlToken: 'replacement-token',
            runtimeId: 'runtime-new',
          }
        : {
            pid: 4242,
            httpPort: 4321,
            controlToken: 'state-token',
            runtimeId: 'runtime-old',
          };
      return input.resolvePidStackOwnershipImpl === null
        ? {
            ok: true,
            state,
            pid: state.pid,
            httpPort: state.httpPort,
            controlToken: state.controlToken,
          }
        : {
            ok: false,
            reason: 'daemon_not_owned',
            ownershipReason: 'process-identity-unsupported',
            pid: state.pid,
          };
    },
    daemonControlPostImpl: async ({ path, httpPort }) => {
      if (path === '/restart') {
        assert.equal(httpPort, 4321);
        restartPosted = true;
        return { status: 'restarting' };
      }
      if (path === '/ping') {
        return {
          status: 'ok',
          runtimeId: httpPort === 4321 ? 'runtime-old' : 'runtime-new',
        };
      }
      throw new Error(`unexpected path ${path}`);
    },
    readProcessInstanceFingerprintImpl: () => fingerprints.shift() ?? null,
  });

  assert.equal(result.status, 'restarting');
  assert.equal(result.previousPid, 4242);
  assert.equal(result.pid, 4343);
  assert.equal(result.processInstanceFingerprint, 'win32-cim:new');
  assert.ok(ownershipAttempts.includes(null));
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
    env: applyStackDaemonLifecycleScopeEnv({ env, stackName: 'remote-dev', cliIdentity: 'default' }),
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

test('readDaemonControlState resolves the exact named-stack lifecycle scope instead of ambient state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hstack-daemon-control-named-scope-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const serverUrl = 'http://127.0.0.1:3009';
  const stackName = 'target-stack';
  const env = {
    HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_ambient__id_default',
    HAPPIER_STACK_CLI_IDENTITY: 'account-b',
  };
  const targetEnv = applyStackDaemonLifecycleScopeEnv({
    env,
    stackName,
    cliIdentity: 'account-b',
  });
  await writeDaemonState({
    cliHomeDir: home,
    serverUrl,
    env: targetEnv,
    state: { pid: process.pid, httpPort: 12345, controlToken: 'target-token' },
  });

  const result = await readDaemonControlState({
    cliHomeDir: home,
    serverUrl,
    env,
    stackName,
    resolvePidStackOwnershipImpl: async () => ({ owned: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.controlToken, 'target-token');
  assert.equal(result.statePath, resolvePreferredStackDaemonStatePaths({
    cliHomeDir: home,
    serverUrl,
    env: targetEnv,
  }).statePath);
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

test('restartDaemonViaControlServer posts the normalized successor dist fingerprint and confirms it', async () => {
  const observedBodies = [];
  let readCount = 0;

  await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
    successorDistClosureFingerprint: ' ABC123DEF4567890 ',
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
      if (path === '/ping') return { status: 'ok', distClosureFingerprint: 'abc123def4567890' };
      throw new Error(`unexpected path ${path}`);
    },
  });

  assert.deepEqual(observedBodies, [{ successorDistClosureFingerprint: 'abc123def4567890' }]);
});

test('restartDaemonViaControlServer rejects malformed successor fingerprints before control mutation', async () => {
  let readCalls = 0;
  let postCalls = 0;

  await assert.rejects(
    () => restartDaemonViaControlServer({
      cliHomeDir: '/tmp/hstack-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      successorDistClosureFingerprint: 'not-a-fingerprint',
      readDaemonControlStateImpl: async () => {
        readCalls += 1;
        throw new Error('must not read daemon state');
      },
      daemonControlPostImpl: async () => {
        postCalls += 1;
      },
    }),
    /successor dist closure fingerprint/i,
  );

  assert.equal(readCalls, 0);
  assert.equal(postCalls, 0);
});

test('restartDaemonViaControlServer keeps the empty request compatible when no fingerprint is provided', async () => {
  const observedBodies = [];
  let readCount = 0;

  await restartDaemonViaControlServer({
    cliHomeDir: '/tmp/hstack-home',
    internalServerUrl: 'http://127.0.0.1:3009',
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

test('restartDaemonViaControlServer does not confirm a successor with a different dist fingerprint', async () => {
  let readCount = 0;

  await assert.rejects(
    () => restartDaemonViaControlServer({
      cliHomeDir: '/tmp/hstack-home',
      internalServerUrl: 'http://127.0.0.1:3009',
      successorDistClosureFingerprint: 'abcdef1234567890',
      timeoutMs: 1,
      pollMs: 0,
      delayImpl: async () => {},
      readDaemonControlStateImpl: async () => {
        readCount += 1;
        const pid = readCount === 1 ? 111 : 222;
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
        if (path === '/ping') {
          return { status: 'ok', distClosureFingerprint: '0000000000000000' };
        }
        throw new Error(`unexpected path ${path}`);
      },
    }),
    /fingerprint/i,
  );
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

test('restartDaemonViaControlServer keeps daemon control posts bounded but long enough for loaded local daemons', async () => {
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
    { path: '/restart', timeoutMs: 10_000 },
    { path: '/ping', timeoutMs: 10_000 },
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
