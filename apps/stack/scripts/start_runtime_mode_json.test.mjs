import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntimeSnapshotFixture, runNode } from './testkit/runtime_snapshot_testkit.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeManagedRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { selectActiveProducerRuntimeSnapshot } from './build/activate_runtime_snapshot.mjs';
import { killDetachedProcessGroup } from './testkit/core/spawn_daemon_like_process.mjs';
import { writeStubCliDistBuildManifest } from './testkit/core/stub_happier_cli_files.mjs';
import { buildStubHappierServerSetSource } from './testkit/core/stub_happier_cli_server_set.mjs';

test('shared QA start composes a local daemon snapshot independently of its Darwin server and command pool', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const { root } = await createTempFixture(t, { prefix: 'hstack-mixed-qa-start-' });
  const storageDir = join(root, 'storage');
  const producer = join(storageDir, 'producer');
  const consumer = join(storageDir, 'qa');
  const source = join(root, 'source');
  const launcher = join(source, 'apps/stack/bin/hstack-exec');
  await mkdir(dirname(launcher), { recursive: true });
  // The process/SSH boundary reports observed hosts; placement and snapshot
  // admission remain real beneath the public start command.
  await writeFile(launcher, '#!/bin/sh\ncase "$*" in *--target=mac-host*) printf \'HSTACK_QA_HOST={"platform":"darwin","arch":"arm64","remote":true}\\n\' ;; *) printf \'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\\n\'; printf \'[preferred-execution] selected worker (load=0.1)\\n\' >&2 ;; esac\n');
  await chmod(launcher, 0o755);
  const server = await writeManagedRuntimeSnapshotLayout({ stackDir: producer, snapshotId: 'darwin-server', target: { platform: 'darwin', arch: 'arm64' } });
  await writeManagedRuntimeSnapshotLayout({ stackDir: producer, snapshotId: 'linux-daemon', target: { platform: process.platform, arch: process.arch } });
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SHARED_DB_SOURCE_STACK=producer\nHAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=producer\n');
  const targets = ['mac-host', 'worker'].map(name => ({ name, platform: 'posix', ssh: name, repoDir: '/mirror', cliHomeDir: `/state/${name}/cli` }));
  await writeFile(join(producer, 'dev-targets.json'), JSON.stringify({ version: 3, targets, runtimePlacement: { qa: { mode: 'local' } }, commandExecution: { mode: 'auto', targets: ['worker'] } }));
  await writeFile(join(consumer, 'dev-targets.json'), JSON.stringify({ version: 3, targets, runtimePlacement: { server: { mode: 'prefer-target', target: 'mac-host' } } }));
  await selectActiveProducerRuntimeSnapshot({ consumerStackBaseDir: consumer, producerStackBaseDir: producer,
    producerStackName: 'producer', consumerStackName: 'qa', snapshotId: server.snapshotId,
    target: server.manifest.target, requiredComponents: ['server'] });
  const res = await runNode([join(rootDir, 'scripts/run.mjs'), '--json', '--runtime'], { cwd: rootDir, env: {
    ...process.env, HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_ENV_FILE: join(consumer, 'env'),
    HAPPIER_STACK_REPO_DIR: source, HAPPIER_STACK_DAEMON_AUTOSTART: '1',
  } });
  assert.equal(res.code, 0, res.stderr);
  const result = JSON.parse(res.stdout);
  assert.equal(result.target, 'mac-host');
  assert.equal(result.runtimeSnapshotId, 'darwin-server');
  assert.equal(result.daemonPlacement, 'local');
  assert.equal(result.daemonSnapshotId, 'linux-daemon');
});

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('source snapshot preview selects frozen export rather than implicitly borrowed Expo', async t => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'direct-source-qa' });
  await appendFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_EXPO_SOURCE_STACK=producer\n');
  const env = { ...process.env, HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir, HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir, HAPPIER_STACK_EXPO_SOURCE_STACK: 'producer' };
  const result = await runNode([join(rootDir, 'scripts/run.mjs'), '--json', '--runtime=source', '--no-dev-targets', '--mobile'], { cwd: rootDir, env });
  assert.equal(result.code, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.launchMode, 'source-snapshot');
  assert.equal(preview.runtimeSnapshotId, null);
  assert.equal(preview.serveUi, true);
  assert.equal(preview.sourceUi, 'export');
  assert.equal(preview.startOwnedExpo, false);
  assert.equal(preview.expoOwnership, 'disabled');
  assert.equal(preview.cliDir, join(rootDir, '..', 'cli'));
  assert.equal(preview.serverDir, join(rootDir, '..', 'server'));
  await assert.rejects(stat(join(fixture.stackDir, 'source-runtime')), { code: 'ENOENT' });
});

test('source QA borrowed UI is explicit and headless source workers do not export UI', async t => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-ui-choice' });
  await appendFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_EXPO_SOURCE_STACK=producer\n');
  const env = { ...process.env, HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir, HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir, HAPPIER_STACK_EXPO_SOURCE_STACK: 'producer' };
  const args = [join(rootDir, 'scripts/run.mjs'), '--json', '--runtime=source', '--no-dev-targets'];
  const borrowed = await runNode([...args, '--ui=borrowed'], { cwd: rootDir, env });
  assert.equal(borrowed.code, 0, borrowed.stderr);
  assert.equal(JSON.parse(borrowed.stdout).sourceUi, 'borrowed');
  assert.equal(JSON.parse(borrowed.stdout).serveUi, false);
  assert.equal(JSON.parse(borrowed.stdout).expoOwnership, 'borrowed');
  const headless = await runNode([...args, '--no-ui'], { cwd: rootDir, env });
  assert.equal(headless.code, 0, headless.stderr);
  assert.equal(JSON.parse(headless.stdout).sourceUi, 'disabled');
  assert.equal(JSON.parse(headless.stdout).serveUi, false);
  const invalid = await runNode([...args, '--ui=watch'], { cwd: rootDir, env });
  assert.notEqual(invalid.code, 0);
  await assert.rejects(stat(join(fixture.stackDir, 'source-runtime')), { code: 'ENOENT' });
});

test('source QA with local server honors its pinned remote daemon instead of starting a local Machine', async t => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-local-server-' });
  const storageDir = join(root, 'storage');
  const source = join(root, 'source');
  const consumer = join(storageDir, 'qa');
  const producer = join(storageDir, 'producer');
  const launcher = join(source, 'apps/stack/bin/hstack-exec');
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\nprintf \'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\\n\'\n');
  await chmod(launcher, 0o755);
  await mkdir(consumer, { recursive: true });
  await mkdir(producer, { recursive: true });
  const targets = [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/state/cli' }];
  await writeFile(join(producer, 'dev-targets.json'), JSON.stringify({ version: 3, targets }));
  await writeFile(join(consumer, 'env'), 'HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=producer\n');
  await writeFile(join(consumer, 'dev-targets.json'), JSON.stringify({ version: 3, targets,
    runtimePlacement: { qa: { mode: 'local' }, daemon: { mode: 'prefer-target', target: 'worker', fallback: 'local' } } }));
  const result = await runNode([join(rootDir, 'scripts/run.mjs'), '--json', '--runtime=source'], { cwd: rootDir, env: {
    ...process.env, HAPPIER_STACK_STACK: 'qa', HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_ENV_FILE: join(consumer, 'env'),
    HAPPIER_STACK_REPO_DIR: source, HAPPIER_STACK_DAEMON: '1',
  } });
  assert.equal(result.code, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.startDaemon, false);
  assert.equal(preview.daemonPlacement, 'worker');
});

test('daemon-only runtime start consumes an external Home without resolving or adopting a local server', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-daemon-only' });
  await mkdir(join(fixture.stackDir, 'workspace'));
  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.components.server;
  delete manifest.components.web;
  await writeFile(manifestPath, JSON.stringify(manifest));
  // HTTP is a genuine external process boundary; launch/admission logic stays real.
  const home = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
  });
  await new Promise(resolve => home.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => home.close(resolve)));
  const serverUrl = `http://127.0.0.1:${home.address().port}`;
  const env = { ...process.env, CI: '1', HAPPIER_PUBLIC_SERVER_URL: '', HAPPIER_SERVER_URL: '',
    HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'), HAPPIER_STACK_REPO_DIR: rootDir,
  };
  const args = [join(rootDir, 'scripts/run.mjs'), '--runtime', '--no-dev-targets', '--no-server', `--server-url=${serverUrl}`, '--no-ui'];
  const preview = await runNode([...args, '--json'], { cwd: rootDir, env });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).internalServerUrl, serverUrl);
  // With no local service requested, the real runner must not create runtime
  // ownership or start/adopt the external Home (not just pass its JSON preview).
  const result = await runNode([...args, '--no-daemon'], { cwd: rootDir, env });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(stat(join(fixture.stackDir, 'stack.runtime.json')), { code: 'ENOENT' });
});

test('hstack start --json --runtime reports runtime-backed launch paths', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode([join(rootDir, 'scripts', 'run.mjs'), '--json', '--runtime'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.mode, 'start');
  assert.equal(parsed.launchMode, 'runtime');
  assert.equal(parsed.runtimeSnapshotId, 'snap-1');
  assert.equal(parsed.cliDir, join(fixture.snapshotDir, 'cli'));
  assert.equal(parsed.serverDir, join(fixture.snapshotDir, 'server'));
  assert.equal(parsed.uiBuildDir, join(fixture.snapshotDir, 'ui'));
  assert.notEqual(parsed.cliDir, join(fixture.stackDir, 'runtime', 'current', 'cli'));
  assert.notEqual(parsed.serverDir, join(fixture.stackDir, 'runtime', 'current', 'server'));
  assert.notEqual(parsed.uiBuildDir, join(fixture.stackDir, 'runtime', 'current', 'ui'));
});

for (const alreadyRunning of [false, true]) {
test(alreadyRunning ? 'already-running daemon custody retains selected runtime ownership and stops on its own signal' : 'daemon-only foreground custody stays alive after detached startup and stops on its own signal', { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'daemon-custody' });
  const cliSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDaemonLikeProcess } from ${JSON.stringify(join(rootDir, 'scripts/testkit/core/spawn_daemon_like_process.mjs'))};
const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
const home = process.env.HAPPIER_HOME_DIR;
const statePath = join(home, 'servers/stack_daemon-custody__id_default/daemon.state.json');
if (args[0] === 'daemon' && args[1] === 'start') {
  const child = spawnDaemonLikeProcess({ cliHomeDir: home, statePaths: [statePath],
    internalServerUrl: process.env.HAPPIER_SERVER_URL, publicServerUrl: process.env.HAPPIER_WEBAPP_URL });
  writeFileSync(join(home, '.fixture-daemon.pid'), String(child.pid));
}
if (args[0] === 'daemon' && args[1] === 'stop') {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    await fetch('http://127.0.0.1:' + state.httpPort + '/stop', { method: 'POST', headers: { 'x-happier-daemon-token': state.controlToken } });
  } catch {}
}
`;
  const nodeEntrypoint = join(fixture.snapshotDir, 'cli/package-dist/index.mjs');
  await writeFile(nodeEntrypoint, cliSource);
  writeStubCliDistBuildManifest(join(fixture.snapshotDir, 'cli'), { entrypointDir: 'package-dist' });
  // This POSIX executable stands in for the external native CLI boundary.
  await writeFile(join(fixture.snapshotDir, 'cli/happier'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(nodeEntrypoint)} "$@"\n`);
  await mkdir(join(fixture.stackDir, 'workspace'));
  await appendFile(join(fixture.stackDir, 'env'), [
    'HAPPIER_STACK_SERVICE_MODE=1', 'HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1',
    'HAPPIER_DEV_TARGET_EXECUTION=1',
    'HAPPIER_STACK_DAEMON=1', `HAPPIER_STACK_REPO_DIR=${dirname(dirname(rootDir))}`,
    `HAPPIER_STACK_CLI_HOME_DIR=${join(fixture.stackDir, 'cli')}`, '',
  ].join('\n'));
  const cliHome = join(fixture.stackDir, 'cli');
  await mkdir(join(cliHome, 'servers/stack_daemon-custody__id_default'), { recursive: true });
  await writeFile(join(cliHome, 'servers/stack_daemon-custody__id_default/access.key'), JSON.stringify({ token: 'fixture-account-token', secret: 'fixture-account-secret' }));
  const home = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
  });
  await new Promise(resolve => home.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => home.close(resolve)));
  const serverUrl = `http://127.0.0.1:${home.address().port}`;
  if (alreadyRunning) {
    const daemonDir = join(cliHome, 'servers/stack_daemon-custody__id_default');
    const ready = new Promise(resolve => {
      const watcher = watch(daemonDir, (_event, file) => {
        if (file === 'daemon.state.json') { watcher.close(); resolve(); }
      });
      t.after(() => watcher.close());
    });
    const seed = spawn(process.execPath, [nodeEntrypoint, 'daemon', 'start'], {
      stdio: 'ignore', env: { ...process.env, HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: serverUrl,
        HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
      },
    });
    assert.equal(await new Promise(resolve => seed.once('exit', resolve)), 0);
    await ready;
  }
  // The native process boundary uses the canonical daemon-like testkit; admission,
  // auth scoping, startup verification and owner lifecycle remain real.
  const child = spawn(process.execPath, [join(rootDir, 'scripts/run.mjs'), '--runtime', '--no-dev-targets', '--no-server', `--server-url=${serverUrl}`, '--no-ui'], {
    cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HAPPIER_SERVER_URL: '', HAPPIER_PUBLIC_SERVER_URL: '',
      HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
      HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
      HAPPIER_STACK_REPO_DIR: dirname(dirname(rootDir)), HAPPIER_STACK_SERVICE_MODE: '1',
      HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1', HAPPIER_STACK_DAEMON: '1',
      HAPPIER_STACK_CLI_HOME_DIR: join(fixture.stackDir, 'cli'),
    },
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    const fixturePid = await readFile(join(cliHome, '.fixture-daemon.pid'), 'utf8').then(Number, () => null);
    if (fixturePid) killDetachedProcessGroup(fixturePid);
  });
  let output = '';
  child.stderr.on('data', chunk => { output += String(chunk); });
  child.stdout.on('data', chunk => { output += String(chunk); });
  await new Promise((resolve, reject) => {
    let ready = false;
    const inspect = async () => {
      const state = await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8').then(JSON.parse, () => null);
      if (state?.processes?.daemonPid) { ready = true; resolve(); }
    };
    const watcher = watch(fixture.stackDir, (_event, file) => {
      if (file === 'stack.runtime.json') void inspect();
    });
    t.after(() => watcher.close());
    child.once('error', reject);
    child.once('exit', () => void inspect().then(() => {
      if (!ready) reject(new Error(`runner exited before daemon readiness: ${output}`));
    }));
    void inspect();
  });
  assert.equal(await Promise.race([exited.then(() => 'exited'), delay(1000).then(() => 'alive')]), 'alive', output);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
});
}

test('hstack start --mobile does not request an owned Expo process when the stack borrows Expo', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-borrowed-start' });
  await appendFile(
    join(fixture.stackDir, 'env'),
    'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer\n',
    'utf8',
  );
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_REPO_DIR: rootDir,
  };

  const res = await runNode(
    [join(rootDir, 'scripts', 'run.mjs'), '--json', '--runtime', '--mobile'],
    { cwd: rootDir, env },
  );
  assert.equal(res.code, 0, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.startMobile, true);
  assert.equal(parsed.startOwnedExpo, false);
  assert.equal(parsed.expoOwnership, 'borrowed');
});
