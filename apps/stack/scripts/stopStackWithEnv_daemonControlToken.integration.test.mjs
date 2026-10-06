import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { spawnOwnedSleep, waitForProcessAlive } from './testkit/stack_stop_sweeps_testkit.mjs';

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function startDaemonControlServer({ token, stopResult = { status: 'stopped' } }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = req.url || '';
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    const seenToken = String(req.headers['x-happier-daemon-token'] || '');
    calls.push({ url, token: seenToken });
    if (seenToken !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url === '/stop') {
      assert.equal((await readJson(req)).stopSessions, true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: stopResult.status === 'stopped' ? 'stopping' : 'session_cleanup_incomplete' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  assert.ok(port > 0, 'expected an ephemeral port');
  return {
    port,
    calls,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

for (const stopResult of [{ status: 'stopped' }, { status: 'incomplete', reason: 'runner_exit_timeout' }]) {
test(`explicit child stop handles ${stopResult.status} before signaling the lifecycle owner`, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-stop-token-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const token = 'token-123';
  const daemon = await startDaemonControlServer({ token, stopResult });
  t.after(async () => {
    await daemon.close();
  });

  const repoRoot = join(tmp, 'repo');
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf8');

  const baseDir = join(tmp, 'stack');
  await mkdir(baseDir, { recursive: true });
  const cliHomeDir = join(tmp, 'cli-home');
  await mkdir(cliHomeDir, { recursive: true });
  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: repoRoot,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_SERVER_PORT: '4101',
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'),
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const child = spawnOwnedSleep({ env });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await waitForProcessAlive({ pid: child.pid });
  const scopedEnv = applyStackDaemonLifecycleScopeEnv({ env, stackName: 'test-stack', cliIdentity: 'default' });
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: 'http://127.0.0.1:4101', env: scopedEnv });
  await mkdir(join(statePath, '..'), { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: child.pid, httpPort: daemon.port, controlToken: token }));
  await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ ownerPid: child.pid, processes: {} }));

  let ownerSignaled = false;
  const res = await stopStackWithEnv({
    rootDir: repoRoot,
    baseDir,
    stackName: 'test-stack',
    env,
    json: true,
    noDocker: true,
  }, {
    requestLifecycleOwnerShutdownImpl: async (pid) => {
      assert.deepEqual(daemon.calls.map((call) => call.url), ['/ping', '/stop']);
      ownerSignaled = true;
      child.kill('SIGTERM');
      return { killed: true, reason: 'killed' };
    },
  });

  assert.equal(res.daemonSessionsStopped?.skipped, false);
  assert.equal(ownerSignaled, stopResult.status === 'stopped');
  assert.deepEqual(res.daemonSessionsStopped?.stoppedSessionIds, []);
  if (stopResult.status === 'incomplete') {
    assert.equal(res.finalization?.finalized, false);
    assert.equal(res.finalization?.reason, 'session_cleanup_incomplete');
    assert.equal(res.daemonSessionsStopped.reason, 'session_cleanup_incomplete');
  }

  const stopCalls = daemon.calls.filter((c) => c.url === '/stop');
  const listCalls = daemon.calls.filter((c) => c.url === '/list');
  const stopSessionCalls = daemon.calls.filter((c) => c.url === '/stop-session');
  assert.equal(stopCalls.length, 1);
  assert.equal(listCalls.length, 0);
  assert.equal(stopSessionCalls.length, 0);
  assert.ok(daemon.calls.every((call) => call.token === token));
});
}

test('stopStackWithEnv preserveDaemon skips daemon shutdown and keeps daemon control untouched', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-stop-preserve-daemon-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const token = 'token-keep';
  const daemon = await startDaemonControlServer({ token });
  t.after(async () => {
    await daemon.close();
  });

  const repoRoot = join(tmp, 'repo');
  await mkdir(join(repoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(repoRoot, 'apps', 'server'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf8');
  await writeFile(join(repoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf8');

  const baseDir = join(tmp, 'stack');
  await mkdir(baseDir, { recursive: true });
  const cliHomeDir = join(tmp, 'cli-home');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(
    join(cliHomeDir, 'daemon.state.json'),
    JSON.stringify({ pid: process.pid, httpPort: daemon.port, controlToken: token }) + '\n',
    'utf8',
  );
  await writeFile(
    join(baseDir, 'stack.runtime.json'),
    JSON.stringify({
      ownerPid: 999999,
      processes: { daemonPid: process.pid },
    }) + '\n',
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: repoRoot,
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
    HAPPIER_STACK_SERVER_PORT: '4101',
  };

  const res = await stopStackWithEnv({
    rootDir: repoRoot,
    baseDir,
    stackName: 'test-stack',
    env,
    json: true,
    aggressive: true,
    noDocker: true,
    preserveDaemon: true,
  });

  assert.equal(res.daemonStopped, false);
  assert.deepEqual(daemon.calls, []);
});
