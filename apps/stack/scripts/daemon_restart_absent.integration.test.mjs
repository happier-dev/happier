import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLocalDaemonWithAuth } from './daemon.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

for (const [identity, publication, action = 'restart'] of [
  ['default', 'retained'], ['account-b', 'retained'], ['default', 'missing'], ['account-b', 'missing', 'start'],
  ['account-b', 'current'],
]) {
  const alreadySelected = publication === 'current';
  test(alreadySelected
    ? 'automatic participant refresh keeps a daemon already running the selected source'
    : `source ${action} starts the selected ${identity} daemon after its incumbent exits (${publication} state)`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-restart-absent-', registerCleanup: false });
    const stackName = 'restart-absent';
    const cliHomeDir = fixture.path(identity === 'default' ? 'cli' : 'cli-identities/account-b');
    await mkdir(cliHomeDir, { recursive: true });
    const token = randomUUID();
    await writeFile(join(cliHomeDir, 'access.key'), JSON.stringify({ token }));
    const scope = buildStackStableScopeId({ stackName, cliIdentity: identity });
    const statePath = join(cliHomeDir, 'servers', scope, 'daemon.state.json');
    const runtimeStatePath = fixture.path('stack.runtime.json');
    const entrypoint = fixture.path('successor.mjs');
    const home = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v2/sessions') {
        res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 401).end();
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise(resolve => home.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
    const serverUrl = `http://127.0.0.1:${home.address().port}`;
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_CLI_IDENTITY: identity, HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'daemon', HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: serverUrl,
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0', HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '15000',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0' };
    const helperUrl = new URL('./testkit/core/spawn_daemon_like_process.mjs', import.meta.url).href;
    const incumbent = spawnTestProcess(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { startDaemonLikeProcess } from ${JSON.stringify(helperUrl)};
      const statePath = ${JSON.stringify(statePath)};
      await startDaemonLikeProcess({ statePaths: [statePath] });
      if (${alreadySelected}) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        writeFileSync(statePath, JSON.stringify({ ...state, startedWithRuntimeEntrypoint: ${JSON.stringify(entrypoint)} }));
      }
      process.send('ready');
    `], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const owned = [incumbent];
    t.after(async () => {
      for (const child of owned) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      // The start wrapper publishes the exact child it creates for cleanup.
      try { process.kill(Number(await readFile(fixture.path('successor.pid'), 'utf8')), 'SIGTERM'); } catch {}
      if (alreadySelected) {
        // The daemon control fixture can replace its own PID through /restart.
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        if (state.pid !== incumbent.pid) {
          try { process.kill(state.pid, 'SIGTERM'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      }
      await fixture.cleanup();
    });
    await once(incumbent, 'message');
    const defaultIdentity = { selected: 'default-source', loaded: 'default-source' };
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      processes: { daemonPid: incumbent.pid }, sourceRuntimeIdentities: { daemon: defaultIdentity } }, {
      env: { ...env, HAPPIER_STACK_REPO_DIR: fileURLToPath(new URL('../../../', import.meta.url)) },
    });
    if (!alreadySelected) {
      const exited = once(incumbent, 'exit');
      incumbent.kill('SIGTERM');
      await exited;
    }
    if (publication === 'missing') await unlink(statePath);
    await writeFile(entrypoint, `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDaemonLikeProcess } from ${JSON.stringify(new URL('./testkit/core/spawn_daemon_like_process.mjs', import.meta.url).href)};
if (process.argv[2] === 'daemon' && process.argv[3] === 'start') {
  const child = spawnDaemonLikeProcess({ cliHomeDir: process.env.HAPPIER_HOME_DIR,
    statePaths: [${JSON.stringify(statePath)}], internalServerUrl: process.env.HAPPIER_SERVER_URL,
    env: { HAPPIER_TEST_RELOAD_CATALOG: JSON.stringify({ kind: 'available', plugins: [] }) } });
  const logDir = join(process.env.HAPPIER_HOME_DIR, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, child.pid + '-daemon.log'), 'Machine registered');
  writeFileSync(${JSON.stringify(fixture.path('successor.pid'))}, String(child.pid));
}
`);
    const result = await startLocalDaemonWithAuth({ cliBin: entrypoint, cliEntrypoint: entrypoint,
      cliHomeDir, internalServerUrl: serverUrl, publicServerUrl: serverUrl, runtimeStatePath,
      stackName, cliIdentity: identity, env, forceRestart: action === 'restart', preserveSessionsOnRestart: action === 'restart',
      refreshSelectedSource: alreadySelected,
      isShuttingDown: () => false,
      sourceRuntimeLaunchUpdate: { launch: { entrypoint, cliDir: fixture.root }, identity: 'successor' } });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (alreadySelected) {
      assert.deepEqual(result, { ok: true, started: false, reason: 'already_selected' });
      assert.equal(state.pid, incumbent.pid);
    } else {
      assert.equal(result.started, true);
      assert.notEqual(state.pid, incumbent.pid);
    }
    assert.doesNotThrow(() => process.kill(state.pid, 0));
    assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon,
      identity === 'default' ? { selected: 'successor', loaded: 'successor' } : defaultIdentity);
  });
}
