import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalDaemonWithAuth } from './daemon.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { allocateAvailableLocalhostPort } from './testkit/core/ephemeral_port.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

for (const [identity, publication] of [['default', 'retained'], ['account-b', 'retained'], ['default', 'missing']]) {
  test(`source restart starts the selected ${identity} daemon after its incumbent exits (${publication} state)`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-restart-absent-', registerCleanup: false });
    const stackName = 'restart-absent';
    const cliHomeDir = fixture.path(identity === 'default' ? 'cli' : 'cli-identities/account-b');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), JSON.stringify({ token: randomUUID() }));
    const scope = buildStackStableScopeId({ stackName, cliIdentity: identity });
    const statePath = join(cliHomeDir, 'servers', scope, 'daemon.state.json');
    const runtimeStatePath = fixture.path('stack.runtime.json');
    const serverUrl = `http://127.0.0.1:${await allocateAvailableLocalhostPort()}`;
    const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
      HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_CLI_IDENTITY: identity, HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_PROCESS_KIND: 'daemon', HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0', HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '15000',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0' };
    const helperUrl = new URL('./testkit/core/spawn_daemon_like_process.mjs', import.meta.url).href;
    const incumbent = spawnTestProcess(process.execPath, ['--input-type=module', '-e', `
      import { startDaemonLikeProcess } from ${JSON.stringify(helperUrl)};
      await startDaemonLikeProcess({ statePaths: [${JSON.stringify(statePath)}] });
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
      await fixture.cleanup();
    });
    await once(incumbent, 'message');
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      processes: { daemonPid: incumbent.pid } });
    const exited = once(incumbent, 'exit');
    incumbent.kill('SIGTERM');
    await exited;
    if (publication === 'missing') await unlink(statePath);
    const entrypoint = fixture.path('successor.mjs');
    await writeFile(entrypoint, `
import { writeFileSync } from 'node:fs';
import { spawnDaemonLikeProcess } from ${JSON.stringify(new URL('./testkit/core/spawn_daemon_like_process.mjs', import.meta.url).href)};
if (process.argv[2] === 'daemon' && process.argv[3] === 'start') {
  const child = spawnDaemonLikeProcess({ cliHomeDir: process.env.HAPPIER_HOME_DIR,
    statePaths: [${JSON.stringify(statePath)}], internalServerUrl: process.env.HAPPIER_SERVER_URL });
  writeFileSync(${JSON.stringify(fixture.path('successor.pid'))}, String(child.pid));
}
`);
    const result = await startLocalDaemonWithAuth({ cliBin: entrypoint, cliEntrypoint: entrypoint,
      cliHomeDir, internalServerUrl: serverUrl, publicServerUrl: serverUrl, runtimeStatePath,
      stackName, cliIdentity: identity, env, forceRestart: true, preserveSessionsOnRestart: true,
      isShuttingDown: () => false,
      sourceRuntimeLaunchUpdate: { launch: { entrypoint, cliDir: fixture.root }, identity: 'successor' } });
    assert.equal(result.started, true);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.notEqual(state.pid, incumbent.pid);
    assert.doesNotThrow(() => process.kill(state.pid, 0));
    assert.deepEqual((await readStackRuntimeStateFile(runtimeStatePath)).sourceRuntimeIdentities.daemon,
      { selected: 'successor', loaded: 'successor' });
  });
}
