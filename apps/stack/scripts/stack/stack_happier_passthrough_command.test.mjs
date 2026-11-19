// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as stackHappierPassthrough from './stack_happier_passthrough_command.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createStackHappierCliCommandFixture } from '../testkit/stack_happier_cli_command_testkit.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from '../testkit/stack_script_command_testkit.mjs';
import { fileURLToPath } from 'node:url';
import { buildStubHappierServerSetSource } from '../testkit/core/stub_happier_cli_server_set.mjs';
import { buildStackStableScopeId } from '../utils/auth/stable_scope_id.mjs';
import { resolveStackCredentialPaths } from '../utils/auth/credentials_paths.mjs';
import { createFixtureDaemonCliScript } from '../testkit/runtime_snapshot_start_testkit.mjs';
import { killDetachedProcessGroup } from '../testkit/core/spawn_daemon_like_process.mjs';
import { buildRemoteInstallCredentialCommand, resolveRemoteStackStatePaths } from '../utils/dev_targets/remote_commands.mjs';
import { runCommandCapture } from '../testkit/core/run_node_capture.mjs';
import { parseDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';

test('remote source controller auth status remains reachable after a public URL change while signed out', async (t) => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'happier-stack-controller-auth-recovery-',
    distIndexScript: 'throw new Error("Controller must launch the selected checkout CLI");',
  });
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackDir = fileURLToPath(new URL('../../', import.meta.url));
  await fixture.writeStackEnv({ repoDir });
  const serverId = buildStackStableScopeId({ stackName: fixture.stackName });
  const oldOrigin = 'https://previous-home.example.invalid';
  const publicOrigin = 'https://current-home.example.invalid';
  const descriptor = { v: 1, homeServerIdentityId: 'srv_controller_recovery',
    canonicalServerUrl: oldOrigin, revision: 7, endpoints: [{ kind: 'https', url: oldOrigin }] };
  const profile = { id: serverId, name: 'Retained Home', serverUrl: oldOrigin,
    localServerUrl: `http://127.0.0.1:${fixture.serverPort}`, webappUrl: oldOrigin,
    homeConnectionDescriptor: descriptor, createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
  await writeFile(join(fixture.stackCliHome, 'settings.json'), JSON.stringify({
    schemaVersion: 6, activeServerId: serverId, servers: { [serverId]: profile },
  }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid,
    placement: { daemon: 'remote' }, remoteTargets: { remote: { services: { daemon: true }, runtimeMode: 'source-snapshot' } },
    sourceRuntimeIdentities: { daemon: { selected: 'fixture-source', loaded: 'fixture-source' } },
  }));
  const server = createServer((_request, response) => response.writeHead(401).end());
  await new Promise(resolve => server.listen(fixture.serverPort, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  const result = await runNodeCapture([join(stackDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName,
    '--runtime=source', '--', 'auth', 'status', '--json'], {
    cwd: stackDir,
    env: { ...fixture.baseEnv, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_PUBLIC_SERVER_URL: publicOrigin,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1', TSX_DISABLE_CACHE: '1' },
  });
  const status = JSON.parse(result.stdout.trim() || 'null');
  t.diagnostic(`profile reconciliation refused before auth status: ${result.stderr.includes('failed to refresh the stack-owned relay profile before launch')}`);
  assert.equal(status?.kind, 'auth_status', 'signed-out status must reach the CLI instead of refusing profile reconciliation');
  assert.equal(result.code, 1, 'the CLI JSON contract reports signed-out status as an expected failure');
  assert.deepEqual(status, {
    v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' },
  });
  const settings = JSON.parse(await readFile(join(fixture.stackCliHome, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.servers[serverId], profile, 'auth observation must preserve retained Home authority');

  const refused = await runNodeCapture([join(stackDir, 'bin', 'hstack.mjs'), 'stack', 'happier', fixture.stackName,
    '--runtime=source', '--', 'server', 'current', '--json'], {
    cwd: stackDir,
    env: { ...fixture.baseEnv, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_PUBLIC_SERVER_URL: publicOrigin,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1', TSX_DISABLE_CACHE: '1' },
  });
  assert.equal(refused.code, 1, 'non-auth commands still require authenticated endpoint reconciliation');
  assert.equal(refused.stdout.trim(), '', 'refused endpoint mutation must not launch the requested command');
  const retained = JSON.parse(await readFile(join(fixture.stackCliHome, 'settings.json'), 'utf8'));
  assert.deepEqual(retained.servers[serverId], profile, 'refusal preserves the established Home descriptor');
});

for (const { authArgs, cancelled = false, identity = 'default', otherServerOnly = false,
  legacyController = false, aliasController = false, noController = false,
  topLevel = false, prefixed = false, stopFails = false, staleController = false,
  controllerExecutionMarker = false } of [
  { authArgs: ['login'] }, { authArgs: ['login', '--force'] }, { authArgs: ['logout'] },
  { authArgs: ['logout', '--all'] }, { authArgs: ['logout'], cancelled: true },
  { authArgs: ['logout', '--server', 'fixture-other-home'], otherServerOnly: true },
  { authArgs: ['logout'], legacyController: true },
  { authArgs: ['logout'], aliasController: true },
  { authArgs: ['logout'], topLevel: true },
  { authArgs: ['login'], prefixed: true },
  { authArgs: ['logout'], stopFails: true },
  { authArgs: ['logout', '--all'], cancelled: true, noController: true },
  { authArgs: ['logout', '--all'], noController: true },
  { authArgs: ['status'], staleController: true },
  { authArgs: ['recovery-key', 'login'], staleController: true },
  { authArgs: ['status'], staleController: true, controllerExecutionMarker: true },
]) {
  const shape = legacyController ? ' legacy controller' : aliasController ? ' alias controller'
    : topLevel ? ' top-level alias' : prefixed ? ' CLI prefix' : stopFails ? ' stop failure' : noController ? ' target-only'
    : controllerExecutionMarker ? ' execution-marked controller' : staleController ? ' stale target graph on controller' : '';
  test(`ephemeral remote stack auth ${authArgs.join(' ')}${cancelled ? ' cancelled' : ''}${shape} (${identity}) keeps its controller decision across materialization`, { skip: process.platform === 'win32' }, async t => {
    const fixture = await createStackHappierCliCommandFixture(t, {
      prefix: 'hstack-auth-owner-',
      distIndexScript: `import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2);
while (args[0]?.startsWith('--server-url=')) args.shift();
if (args[0] === 'logout') args.unshift('auth');
${buildStubHappierServerSetSource()}
if (args[0] === 'auth') {
  const serverIndex = args.indexOf('--server');
  const serverId = serverIndex >= 0 ? args[serverIndex + 1] : process.env.HAPPIER_ACTIVE_SERVER_ID;
  const file = join(process.env.HAPPIER_HOME_DIR, 'servers', serverId, 'access.key');
  mkdirSync(dirname(file), { recursive: true });
  if (args[1] === 'logout') { if (process.env.HSTACK_TEST_CANCEL_LOGOUT !== '1') rmSync(args.includes('--all') ? process.env.HAPPIER_HOME_DIR : file, { force: true, recursive: args.includes('--all') }); }
  else writeFileSync(file, JSON.stringify({ token: ['fixture', Buffer.from(JSON.stringify({ sub: 'fixture-new-account' })).toString('base64url'), 'unsigned'].join('.') }));
  writeFileSync(process.env.HSTACK_AUTH_OWNER_METADATA, JSON.stringify({ home: process.env.HAPPIER_HOME_DIR, serverId }));
}
`,
    });
    const serverId = buildStackStableScopeId({ stackName: fixture.stackName, cliIdentity: identity });
    const controllerHome = resolveCliHomeDirForIdentity({ cliHomeDir: fixture.stackCliHome, identity });
    const controllerPath = join(controllerHome, 'servers', serverId, 'access.key');
    const target = { name: 'remote', platform: 'posix', ssh: 'fixture-daemon', repoDir: fixture.monoRoot, cliHomeDir: fixture.path('remote') };
    const remote = resolveRemoteStackStatePaths(target, { stackName: fixture.stackName, runtimeMode: 'source' });
    const remoteHome = remote.cliHomeDir;
    const remotePath = join(remoteHome, 'servers', remote.activeServerId, 'access.key');
    const stagedPath = join(remoteHome, '.staged');
    const otherPath = join(remoteHome, 'servers', 'fixture-other-home', 'access.key');
    const legacyPath = join(remoteHome, 'access.key');
    const metadataPath = fixture.path('owner.json');
    const stopMetadataPath = fixture.path('remote-stop.json');
    const sshCallsPath = fixture.path('ssh-calls');
    const oldAuth = JSON.stringify({ token: ['fixture', Buffer.from(JSON.stringify({ sub: 'fixture-old-account' })).toString('base64url'), 'unsigned'].join('.') });
    await mkdir(dirname(controllerPath), { recursive: true });
    await mkdir(dirname(remotePath), { recursive: true });
    if (otherServerOnly) {
      const controllerOtherPath = join(controllerHome, 'servers', 'fixture-other-home', 'access.key');
      await mkdir(dirname(controllerOtherPath), { recursive: true });
      await writeFile(controllerOtherPath, oldAuth);
    } else if (!noController) await writeFile(controllerPath, oldAuth);
    const controllerAliases = resolveStackCredentialPaths({ cliHomeDir: controllerHome,
      serverUrl: `http://127.0.0.1:${fixture.serverPort}`, env: { HAPPIER_ACTIVE_SERVER_ID: serverId } });
    const controllerExtraPath = legacyController ? controllerAliases.legacyPath
      : aliasController ? controllerAliases.aliasServerScopedPaths[0] : null;
    if (controllerExtraPath) {
      await mkdir(dirname(controllerExtraPath), { recursive: true });
      await writeFile(controllerExtraPath, oldAuth);
    }
    await writeFile(remotePath, oldAuth);
    await mkdir(dirname(otherPath), { recursive: true });
    await writeFile(otherPath, oldAuth);
    await writeFile(legacyPath, oldAuth);
    const machineMetadata = { schemaVersion: 6, machineIdByServerIdByAccountId: {
      [serverId]: { 'fixture-old-account': 'fixture-machine-a', 'fixture-new-account': 'fixture-machine-b' },
    } };
    const installationMetadata = { version: 1, installationId: 'fixture-target-installation' };
    await writeFile(join(remoteHome, 'settings.json'), JSON.stringify(machineMetadata));
    // Metadata-only sidecar: no real or synthetic signing material is needed.
    await writeFile(join(remoteHome, 'installation-identity.json'), JSON.stringify(installationMetadata));
    await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify(parseDevTargetsConfig({
      version: 3, targets: [target], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'remote', fallback: 'local' } },
    })));
    const retainedEntrypoint = fixture.path('retained', 'runtime', 'cli', 'src', 'index.mjs');
    if (staleController) {
      await mkdir(dirname(retainedEntrypoint), { recursive: true });
      await writeFile(retainedEntrypoint, 'throw new Error("target graph must not run on controller");');
      await writeFile(fixture.path('retained', 'source-bundle.json'), JSON.stringify({ component: 'daemon' }));
    }
    await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
      version: 1, stackName: fixture.stackName, ownerPid: process.pid,
      placement: { daemon: 'remote' }, remoteTargets: { remote: { services: { daemon: true }, runtimeMode: 'source' } },
      sourceRuntimeLaunch: { entrypoint: staleController ? retainedEntrypoint : join(fixture.monoRoot, 'apps/cli/dist/index.mjs'), cliDir: join(fixture.monoRoot, 'apps/cli') },
      sourceRuntimeIdentities: { daemon: { selected: 'fixture-source', loaded: 'fixture-source' } },
    }));
    const targetStackBin = join(fixture.monoRoot, 'apps/stack/bin');
    await mkdir(targetStackBin, { recursive: true });
    // A synthetic target CLI is the process boundary; execute real generated
    // shell commands so quoting cannot masquerade as daemon-stop semantics.
    await writeFile(join(targetStackBin, 'hstack.mjs'), `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stop = args[0] === 'stack' && (args[1] === 'daemon' || args[1] === 'happier') && args.includes('stop');
if (!stop) throw new Error('Unexpected fixture target command');
writeFileSync(process.env.HSTACK_TEST_REMOTE_STOP_METADATA, JSON.stringify({ allDaemons: args.includes('--all') }));
if (process.env.HSTACK_TEST_STOP_FAILS === '1') process.exit(19);
`);
    // The old remote writer remains modeled at the OS boundary for regression
    // sensitivity. No real SSH or Account is used.
    const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/usr/bin/env node
const { appendFileSync, writeFileSync, rmSync } = require('node:fs');
appendFileSync(process.env.HSTACK_TEST_SSH_CALLS, 'call\\n');
if (require('node:fs').existsSync(process.env.HSTACK_AUTH_OWNER_METADATA)) {
  const result = require('node:child_process').spawnSync('/bin/bash', ['-c', process.argv.at(-1)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (!process.argv.at(-1).includes('stack happier')) {
  const result = require('node:child_process').spawnSync('/bin/bash', ['-c', process.argv.at(-1)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (process.env.HSTACK_TEST_CANCEL_LOGOUT === '1') process.exit(0);
if (process.env.HSTACK_TEST_AUTH_ACTION === 'logout') rmSync(process.env.HSTACK_TEST_AUTH_ALL === '1' ? process.env.HSTACK_TEST_REMOTE_HOME : process.env.HSTACK_TEST_REMOTE_PATH, { force: true, recursive: process.env.HSTACK_TEST_AUTH_ALL === '1' });
else writeFileSync(process.env.HSTACK_TEST_REMOTE_PATH, JSON.stringify({ token: ['fixture', Buffer.from(JSON.stringify({ sub: 'fixture-new-account' })).toString('base64url'), 'unsigned'].join('.') }));
` });
    const mutagen = writeFakeBin({ root: fixture.root, name: 'mutagen', content: `#!/usr/bin/env node
import(${JSON.stringify(new URL('../testkit/core/dev_target_sync.mjs', import.meta.url).href)}).then(({ captureDevTargetSyncFixture }) => {
  const result = captureDevTargetSyncFixture('mutagen', process.argv.slice(2));
  process.stdout.write(result?.out ?? '');
  process.exit(result?.exitCode ?? 1);
});
` });
    // Ephemeral targets use the package launcher; only that external process
    // is substituted, with the same target Stack command fixture as source QA.
    writeFakeBin({ root: fixture.root, name: 'pnpm', content: `#!/usr/bin/env node
const args = process.argv.slice(2);
const start = args.indexOf('stack');
if (start < 0) process.exit(17);
const result = require('node:child_process').spawnSync(process.execPath,
  [${JSON.stringify(join(targetStackBin, 'hstack.mjs'))}, ...args.slice(start)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
` });
    const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
      'stack', 'happier', fixture.stackName, ...(identity === 'default' ? [] : [`--identity=${identity}`]),
      ...(authArgs.includes('--force') ? ['--source'] : []), '--',
      ...(prefixed ? [`--server-url=http://127.0.0.1:${fixture.serverPort}`] : []),
      ...(topLevel ? [] : ['auth']), ...authArgs], {
      cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir, mutagen.binDir], extraEnv: {
        HAPPIER_DEV_TARGET_EXECUTION: controllerExecutionMarker ? '1' : '', HSTACK_AUTH_OWNER_METADATA: metadataPath,
        HSTACK_TEST_AUTH_ACTION: authArgs[0], HSTACK_TEST_REMOTE_PATH: remotePath,
        HSTACK_TEST_REMOTE_HOME: remoteHome, HSTACK_TEST_AUTH_ALL: authArgs.includes('--all') ? '1' : '',
        HSTACK_TEST_CANCEL_LOGOUT: cancelled ? '1' : '', HSTACK_TEST_SSH_CALLS: sshCallsPath,
        HSTACK_TEST_STOP_FAILS: stopFails ? '1' : '',
        HSTACK_TEST_REMOTE_STOP_METADATA: stopMetadataPath,
        HAPPIER_HOME_DIR: fixture.path('foreign-home'),
      } }),
    });
    const safeDiagnostic = result.stderr.split('\n').filter(line => !/:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key|[A-Za-z0-9+/_=-]{40,}\.[A-Za-z0-9+/_=-]{20,}/i.test(line)).join('\n');
    if (!stopFails) assert.equal(result.code, 0, `synthetic Account change must succeed: ${safeDiagnostic}`);
    else assert.notEqual(result.code, 0, 'a failed daemon stop must remain visible');
    if (controllerExtraPath) assert.equal(existsSync(controllerExtraPath), false, 'logout clears every startup source for the same server');
    // Simulate startup through the real materialization command, substituting only SSH/SCP.
    const signedIn = existsSync(controllerPath);
    if (signedIn) {
      await copyFile(controllerPath, stagedPath);
      const installed = await runCommandCapture('/bin/bash', ['-c', buildRemoteInstallCredentialCommand(target, {
        stagedPath, finalPath: remotePath,
      })], { cwd: fixture.root });
      assert.equal(installed.code, 0, 'startup materialization must settle');
    }
    const remoteAccount = existsSync(remotePath)
      ? JSON.parse(Buffer.from(JSON.parse(await readFile(remotePath, 'utf8')).token.split('.')[1], 'base64url').toString()).sub
      : null;
    assert.equal(remoteAccount, cancelled || otherServerOnly || prefixed ? 'fixture-old-account' : authArgs[0] === 'logout' ? null : 'fixture-new-account');
    assert.deepEqual(JSON.parse(await readFile(join(remoteHome, 'settings.json'), 'utf8')), machineMetadata);
    assert.deepEqual(JSON.parse(await readFile(join(remoteHome, 'installation-identity.json'), 'utf8')), installationMetadata);
    assert.equal(existsSync(otherPath), cancelled || !authArgs.includes('--all'), 'logout only clears the selected Home unless --all is confirmed');
    if (authArgs[0] === 'logout' && !cancelled && !otherServerOnly) assert.equal(existsSync(legacyPath), false, 'legacy auth cannot restore a logged-out Account');
    const sshCalls = existsSync(sshCallsPath) ? (await readFile(sshCallsPath, 'utf8')).trim().split('\n').length : 0;
    assert.equal(sshCalls, authArgs[0] === 'logout' && !cancelled && !otherServerOnly ? 2 : 0,
      'auth stays on its controller; completed logout stops the target daemon and publishes one withdrawal');
    if (authArgs[0] === 'logout' && !cancelled && !otherServerOnly) {
      assert.deepEqual(JSON.parse(await readFile(stopMetadataPath, 'utf8')), { allDaemons: authArgs.includes('--all') });
    }
    assert.deepEqual(JSON.parse(await readFile(metadataPath, 'utf8')), { home: controllerHome,
      serverId: otherServerOnly ? 'fixture-other-home' : prefixed ? controllerAliases.urlHashServerId : serverId });
  });
}

const { resolveStackHappierPassthroughInvocation } = stackHappierPassthrough;

test('explicit controller logout withdraws scoped and legacy target auth', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-auth-signout-' });
  const finalPath = fixture.path('cli', 'servers', 'fixture-scope', 'access.key');
  const legacyPath = fixture.path('cli', 'access.key');
  await mkdir(dirname(finalPath), { recursive: true });
  // These files deliberately contain no usable authentication material.
  await writeFile(finalPath, JSON.stringify({ fixtureAccount: 'old' }));
  await writeFile(legacyPath, JSON.stringify({ fixtureAccount: 'old' }));
  const target = { name: 'fixture', platform: 'posix', ssh: 'unused', repoDir: fixture.root, cliHomeDir: fixture.path('cli') };
  const result = await runCommandCapture('/bin/bash', ['-c', buildRemoteInstallCredentialCommand(target, {
    stagedPath: null, finalPath,
  })], { cwd: fixture.root });
  assert.equal(result.code, 0, 'explicit withdrawal must succeed');
  assert.equal(existsSync(finalPath), false);
  assert.equal(existsSync(legacyPath), false, 'legacy fallback must not resurrect a signed-out Account');
});

async function prepareSessionCreateFixture(fixture) {
  const serverId = buildStackStableScopeId({ stackName: fixture.stackName });
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid,
    sourceRuntimeLaunch: { entrypoint: join(fixture.monoRoot, 'apps/cli/dist/index.mjs'), cliDir: join(fixture.monoRoot, 'apps/cli') },
    sourceRuntimeIdentities: { daemon: { selected: 'fixture-source', loaded: null } },
  }));
  await writeFile(join(fixture.stackCliHome, 'settings.json'), JSON.stringify({ schemaVersion: 6,
    machineId: 'unrelated-global-machine', lastTokenSubByServerId: { [serverId]: 'fixture-account' },
    machineIdByServerIdByAccountId: { [serverId]: { 'fixture-account': 'local-machine' } } }));
  const paths = resolveStackCredentialPaths({ cliHomeDir: fixture.stackCliHome, serverUrl: `http://127.0.0.1:${fixture.serverPort}`,
    env: { HAPPIER_ACTIVE_SERVER_ID: serverId } });
  for (const path of [paths.serverScopedPath, paths.legacyPath]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'dummy\n');
  }
  return join(fixture.stackCliHome, 'servers', serverId, 'daemon.state.json');
}

test('stack Session creation preserves a remote typed CLI refusal without launching a daemon', async t => {
  const expected = { v: 1, ok: false, kind: 'session_create', error: { code: 'machine_offline', details: { machineIds: [] } } };
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-create-refusal-',
    // The child CLI is a real process boundary; wrapper placement/preflight remain real.
    distIndexScript: `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
${buildStubHappierServerSetSource()}
if (args[0] === 'daemon') { writeFileSync(process.env.HSTACK_CREATE_DAEMON_MARKER, 'attempted'); process.exit(11); }
if (args[0] === 'session' && args[1] === 'create') { console.log(JSON.stringify(${JSON.stringify(expected)})); process.exit(1); }
console.log('0.0.0-test');`,
  });
  await prepareSessionCreateFixture(fixture);
  const marker = join(fixture.root, 'daemon-attempted');
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--', 'session', 'create', '--machine-id', 'remote-machine', '--path', '/workspace', '--json'], {
    cwd: fixture.root, env: { ...fixture.baseEnv, HSTACK_CREATE_DAEMON_MARKER: marker },
  });
  assert.equal(existsSync(marker), false, 'Session creation must reach its Action before any daemon startup');
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
});

for (const fails of [false, true]) {
  test(`stack Session creation ${fails ? 'falls through a failed local preflight' : 'starts its stopped local Machine daemon'}`, async t => {
    let statePath;
    t.after(async () => {
      if (statePath && existsSync(statePath)) killDetachedProcessGroup(JSON.parse(await readFile(statePath, 'utf8')).pid);
    });
    const expected = { v: 1, ok: true, kind: 'session_create', data: { sessionId: 'fixture-session' } };
    let script = createFixtureDaemonCliScript({ startLogLine: 'start', statusLogLine: 'status', sessionCreateResult: expected });
    if (fails) script = script.replace("if (sub === 'start') {", "if (sub === 'start') { append('start'); process.exit(11);");
    const fixture = await createStackHappierCliCommandFixture(t, { prefix: 'hstack-create-local-', distIndexScript: script });
    statePath = await prepareSessionCreateFixture(fixture);
    assert.equal(existsSync(statePath), false);
    const runCreate = () => runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
      'stack', 'happier', fixture.stackName, '--', 'session', 'create', '--machine-id=local-machine', '--path', '/workspace', '--json'], {
      cwd: fixture.root, env: { ...fixture.baseEnv, HAPPIER_STACK_MIGRATE_CREDENTIALS: '0', HAPPIER_STACK_AUTO_AUTH_SEED: '0' },
    });
    const result = await runCreate();
    assert.equal(result.code, fails ? 1 : 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), fails
      ? { v: 1, ok: false, kind: 'session_create', error: { code: 'machine_offline' } } : expected);
    const lifecycleLog = join(fixture.stackCliHome, 'runtime-daemon.log');
    assert.match(await readFile(lifecycleLog, 'utf8'), /start/);
    if (fails) return;

    const incumbent = JSON.parse(await readFile(statePath, 'utf8'));
    // A temporarily unavailable control endpoint does not make a live PID replaceable.
    await writeFile(statePath, JSON.stringify({ ...incumbent, httpPort: 0 }));
    const repeatedCreate = await runCreate();
    assert.equal((JSON.parse(await readFile(statePath, 'utf8'))).pid, incumbent.pid,
      'a repeated session create must keep the live incumbent when control is unavailable');
    assert.doesNotMatch(await readFile(lifecycleLog, 'utf8'), /^stop$/m);
    assert.equal(repeatedCreate.code, 0, repeatedCreate.stderr);
    assert.deepEqual(JSON.parse(repeatedCreate.stdout.trim()), expected);
  });
}

test('stack happier dispatches to the recorded daemon host with remote identity and preserves SSH output and status', async t => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-remote-cli-',
    distIndexScript: 'console.log("LOCAL CLI");',
  });
  const target = { name: 'nl1', platform: 'posix', ssh: 'qa-daemon',
    sshConfigFile: '/controller/ssh.config', repoDir: '/remote/source repo', cliHomeDir: '/remote/state' };
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [target], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'nl1', fallback: 'local' } },
  }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid,
    placement: { daemon: 'nl1' }, remoteTargets: { nl1: { services: { daemon: true }, runtimeMode: 'source-snapshot' } },
  }));
  // SSH is the process/transport boundary; placement, identity and command builders stay real.
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content:
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); console.error("REMOTE STDERR"); process.exit(7);\n' });
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--identity=account-b', '--runtime', '--',
    'actions', 'get', 'widgets.group.create', '--json'], {
    cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir],
      // A routed test runner is on a worker; the fixture represents its controller.
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '' } }),
  });
  assert.equal(result.code, 7, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /REMOTE STDERR/);
  const args = JSON.parse(result.stdout);
  assert.ok(args.includes('-T'));
  assert.ok(args.includes('/controller/ssh.config'));
  assert.equal(args.at(-2), 'qa-daemon');
  const command = args.at(-1);
  assert.match(command, /stack happier/);
  assert.ok(command.includes(fixture.stackName));
  assert.ok(command.includes('/remote/state/stack-state/' + fixture.stackName + '/cli'));
  assert.ok(command.includes('--identity=account-b'));
  assert.ok(command.includes('--runtime'));
  assert.ok(command.includes('widgets.group.create'));
  assert.doesNotMatch(command, /stack (start|dev|new|stop)|stack env/);
});

test('stack named-identity auth stays with its target-native owner', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-named-auth-owner-', distIndexScript: 'console.log("LOCAL CLI");',
  });
  const target = { name: 'remote', platform: 'posix', ssh: 'fixture-named-daemon',
    repoDir: fixture.monoRoot, cliHomeDir: fixture.path('native-target') };
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify(parseDevTargetsConfig({
    version: 3, targets: [target], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'remote', fallback: 'local' } },
  })));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid,
    placement: { daemon: 'remote' }, remoteTargets: { remote: { services: { daemon: true }, runtimeMode: 'source-snapshot' } },
    sourceRuntimeLaunch: { entrypoint: join(fixture.monoRoot, 'apps/cli/dist/index.mjs'), cliDir: join(fixture.monoRoot, 'apps/cli') },
  }));
  // The process boundary reports metadata only; no real target or auth is used.
  await mkdir(join(fixture.monoRoot, 'apps/stack/bin'), { recursive: true });
  await writeFile(join(fixture.monoRoot, 'apps/stack/bin/hstack.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/usr/bin/env node
const result = require('node:child_process').spawnSync('/bin/bash', ['-c', process.argv.at(-1)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
` });
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--identity=account-b', '--', 'auth', 'status'], {
    cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir],
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '' } }),
  });
  assert.equal(result.code, 7);
  const args = JSON.parse(result.stdout);
  assert.deepEqual(args.slice(0, 2), ['stack', 'happier']);
  assert.ok(args.includes('--identity=account-b'));
  assert.deepEqual(args.slice(-2), ['auth', 'status']);
});

test('stack happier keeps recorded local daemon placement despite a configured remote preference', async t => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-local-cli-',
    distIndexScript: `const args = process.argv.slice(2); ${buildStubHappierServerSetSource()} console.log('LOCAL CLI');`,
  });
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [{ name: 'nl1', platform: 'posix', ssh: 'qa-daemon',
      repoDir: '/remote/repo', cliHomeDir: '/remote/state' }],
    runtimePlacement: { daemon: { mode: 'prefer-target', target: 'nl1', fallback: 'local' } },
  }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid, placement: { daemon: 'local' }, runtimeSnapshotId: null,
  }));
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: '#!/usr/bin/env node\nprocess.exit(7);\n' });
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--', '--version'], {
    cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir],
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '' } }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'LOCAL CLI');
});

test('resolveStackHappierPassthroughInvocation strips spaced wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity', 'account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation strips inline wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation preserves child identity args after separator', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--', '--identity', 'child-account', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--identity', 'child-account', '--json']);
});

test('resolveStackHappierPassthroughEntrypoint prefers the stack-pinned repo wrapper over the launcher root', async (t) => {
  const resolveStackHappierPassthroughEntrypoint =
    stackHappierPassthrough.resolveStackHappierPassthroughEntrypoint;
  assert.equal(typeof resolveStackHappierPassthroughEntrypoint, 'function');

  const fixture = await createTempFixture(t, { prefix: 'happier-passthrough-entrypoint-' });
  const fixtureRoot = fixture.root;
  const launcherRoot = join(fixtureRoot, 'launcher', 'apps', 'stack');
  const targetRepoRoot = join(fixtureRoot, 'target-repo');
  const targetStackRoot = join(targetRepoRoot, 'apps', 'stack');
  await mkdir(join(launcherRoot, 'scripts'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'server'), { recursive: true });
  await mkdir(join(targetStackRoot, 'bin'), { recursive: true });
  await writeFile(join(launcherRoot, 'scripts', 'happier.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8');
  await writeFile(join(targetStackRoot, 'bin', 'happier.mjs'), 'export {};\n', 'utf-8');

  const resolved = resolveStackHappierPassthroughEntrypoint({
    rootDir: launcherRoot,
    env: {
      HAPPIER_STACK_REPO_DIR: targetRepoRoot,
    },
  });

  assert.deepEqual(resolved, {
    cwd: targetStackRoot,
    entrypoint: join(targetStackRoot, 'bin', 'happier.mjs'),
    source: 'stack-repo-wrapper',
  });
});
