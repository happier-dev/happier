import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStackHappierCliCommandFixture } from '../testkit/stack_happier_cli_command_testkit.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from '../testkit/stack_script_command_testkit.mjs';
import { resolveRemoteStackStatePaths, resolveRemoteServerRuntimeConfig } from '../utils/dev_targets/remote_commands.mjs';
import { startStackDevTargets } from '../utils/dev_targets/supervisor.mjs';
import { resolveDevTargetMutagenRuntime } from '../utils/dev_targets/mutagen_runtime.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from '../utils/dev_targets/mutagen_project.mjs';
import { INDEPENDENT_DEV_TARGET_SYNC_OWNER, prepareDevTargetOpenSsh } from '../utils/dev_targets/sync_project.mjs';
import { readyDevTargetSyncResult } from '../testkit/core/dev_target_sync.mjs';
import { buildAuthSafeStackStartSpec } from '../utils/auth/buildAuthSafeStackStartSpec.mjs';
import { waitForServerReady } from '../utils/server/server.mjs';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { waitForBackgroundStackReadiness } from './run_script_with_stack_env.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from '../utils/stack/runtime_state.mjs';
import { allocateAvailableLocalhostPort } from '../testkit/core/ephemeral_port.mjs';

const stackDir = fileURLToPath(new URL('../../', import.meta.url));
const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));

async function createScopeFixture(t) {
  const fixture = await createStackHappierCliCommandFixture(t, { prefix: 'hstack-native-auth-scope-',
    distIndexScript: `import {mkdirSync,writeFileSync} from 'node:fs'; import {join,dirname} from 'node:path';
      const file=join(process.env.HAPPIER_HOME_DIR,'servers',process.env.HAPPIER_ACTIVE_SERVER_ID,'access.key');
      mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify({token:process.env.HSTACK_TEST_FRESH_AUTH}));`,
  });
  const target = { name: 'nl3', platform: 'posix', ssh: 'fixture-native', repoDir: fixture.monoRoot,
    cliHomeDir: fixture.path('native-state') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: fixture.stackName, runtimeMode: 'source-snapshot' });
  const fresh = randomBytes(32).toString('hex');
  const revoked = randomBytes(32).toString('hex');
  const authPath = home => join(home, 'servers', paths.activeServerId, 'access.key');
  const url = ['http:', '', `127.0.0.1:${fixture.serverPort}`].join('/');
  const descriptor = { v: 1, homeServerIdentityId: 'srv_scope_owner', revision: 1,
    canonicalServerUrl: url, endpoints: [{ kind: 'https', url }] };
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: {
    serverIdentityId: descriptor.homeServerIdentityId } }, homeConnectionDescriptor: descriptor });
  for (const home of [fixture.stackCliHome, paths.cliHomeDir]) {
    await mkdir(dirname(authPath(home)), { recursive: true });
    await writeFile(authPath(home), JSON.stringify({ token: revoked }));
    await writeFile(join(home, 'settings.json'), JSON.stringify({ schemaVersion: 6,
      activeServerId: paths.activeServerId, servers: { [paths.activeServerId]: {
        id: paths.activeServerId, serverUrl: url, homeConnectionDescriptor: descriptor } } }));
  }
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [target], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'nl3', fallback: 'local' } } }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, placement: { daemon: 'nl3', server: 'nl3' }, runtimeMode: 'source-snapshot',
    ports: { server: fixture.serverPort }, remoteTargets: { nl3: { runtimeMode: 'source-snapshot',
      services: { daemon: true, server: true } } } }));
  // The remote CLI is the external process boundary. Real SSH command builders
  // must select its retained home; the controller CLI cannot perform this login.
  const targetBin = join(fixture.monoRoot, 'apps/stack/bin/hstack.mjs');
  await mkdir(dirname(targetBin), { recursive: true });
  await writeFile(targetBin, `import {mkdirSync,writeFileSync} from 'node:fs'; import {join,dirname} from 'node:path';
    const file=join(process.env.HAPPIER_HOME_DIR,'servers',process.env.HAPPIER_ACTIVE_SERVER_ID,'access.key');
    mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,JSON.stringify({token:process.env.HSTACK_TEST_FRESH_AUTH}));`);
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/usr/bin/env node
    const child=require('node:child_process').spawn('/bin/bash',['-c',process.argv.at(-1)],{stdio:'inherit'});
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
    child.on('error',()=>process.exit(1)); child.on('exit',code=>process.exit(code ?? 1));` });
  const env = buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir], extraEnv: {
    HAPPIER_DEV_TARGET_EXECUTION: '', HSTACK_TEST_FRESH_AUTH: fresh,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1',
  } });
  return { ...fixture, target, paths, fresh, revoked, authPath, descriptor, features, url, env };
}

for (const configured of [true, false]) {
test(`retained auth bootstrap ${configured ? 'uses controller placement before native login' : 'refuses an unconfigured QA daemon target before native login'}`,
  { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
    const f = await createScopeFixture(t);
    const daemonTarget = configured ? f.target.name : 'not-configured';
    await appendFile(f.envPath, `\nHAPPIER_STACK_QA_DAEMON_TARGETS=${daemonTarget}\n`);
    const serverTarget = { ...f.target, name: 'server-host' };
    await writeFile(join(f.storageDir, f.stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
      targets: [f.target, serverTarget], runtimePlacement: { qa: { mode: 'local' },
        server: { mode: 'prefer-target', target: serverTarget.name, fallback: 'error' } } }));
    const bootstrapPath = f.path('bootstrap.json');
    const nativePath = f.path('native-login.json');
    const controllerStackDir = f.path('controller-stack');
    await mkdir(join(controllerStackDir, 'scripts'), { recursive: true });
    // Substitute only the launched Stack process. Its real configuration owner
    // still validates the controller registry and probes the OS boundary.
    await writeFile(join(controllerStackDir, 'scripts/stack.mjs'), `
      import { writeFile } from 'node:fs/promises';
      import { loadControlledRuntimeConfig } from ${JSON.stringify(new URL('../utils/dev_targets/service_placement.mjs', import.meta.url).href)};
      const loaded = await loadControlledRuntimeConfig({ stackName: ${JSON.stringify(f.stackName)}, env: process.env }, {
        runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true,"unreservedMemoryKiB":14000000}\\n', err: '' }),
      });
      await writeFile(${JSON.stringify(bootstrapPath)}, JSON.stringify({ path: loaded.path,
        targets: loaded.config.targets.map(target => target.name), daemon: loaded.config.runtimePlacement.daemon,
        server: loaded.config.runtimePlacement.server,
        authFlow: process.env.HAPPIER_STACK_AUTH_FLOW, args: process.argv.slice(2) }));
    `);
    // The native CLI boundary must see completed controller startup and retain
    // stdin custody; it has no controller target registry of its own.
    await writeFile(join(f.monoRoot, 'apps/stack/bin/hstack.mjs'), `
      import { readFile, writeFile } from 'node:fs/promises';
      await readFile(${JSON.stringify(bootstrapPath)});
      let bytes = 0; for await (const chunk of process.stdin) bytes += chunk.length;
      await writeFile(${JSON.stringify(nativePath)}, JSON.stringify({ bytes, args: process.argv.slice(2) }));
    `);
    const input = randomBytes(32).toString('hex');
    const result = await runNodeCapture(['--input-type=module', '-e', `
      import { cmdAuth } from ${JSON.stringify(new URL('./delegated_script_commands.mjs', import.meta.url).href)};
      await cmdAuth({ rootDir: ${JSON.stringify(controllerStackDir)}, stackName: ${JSON.stringify(f.stackName)},
        args: ['--runtime=source', 'login', '--start-if-needed', '--recovery-key-stdin'] });
    `], { cwd: stackDir, env: { ...f.env, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'fixture-producer' }, input });
    if (!configured) {
      assert.equal(result.code, 1);
      assert.match(result.stderr, /QA daemon hosts must be configured targets/);
      await assert.rejects(readFile(nativePath), { code: 'ENOENT' });
      return;
    }
    assert.equal(result.code, 0, 'controller placement must finish before native login');
    const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'));
    assert.equal(bootstrap.path, join(f.storageDir, f.stackName, 'dev-targets.json'));
    assert.deepEqual(bootstrap.targets, [f.target.name, serverTarget.name]);
    assert.equal(bootstrap.daemon.target, f.target.name);
    assert.equal(bootstrap.server.target, serverTarget.name, 'daemon auth placement cannot relocate the server');
    assert.equal(bootstrap.authFlow, '1');
    assert.equal(bootstrap.args.includes('--no-daemon'), false, 'native login needs its placed daemon host connection');
    assert.equal(bootstrap.args.includes('--no-dev-targets'), false, 'controller startup must enforce its placement guard');
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    assert.equal(native.bytes, Buffer.byteLength(input), 'bootstrap must leave login stdin unread');
    assert.equal(native.args.includes('--start-if-needed'), false, 'the placed login cannot start a second server');
  });
}

test('retained bootstrap reaches real guided recovery through the controller-started native connection',
  { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
    const f = await createScopeFixture(t);
    const bootstrapPath = f.path('composed-bootstrap.json');
    const loginPath = f.path('composed-login.json');
    const controllerStackDir = f.path('controller-stack');
    const nativeStatePath = join(f.paths.stackBaseDir, 'stack.runtime.json');
    const sourceEntrypoint = f.path('native-cli/src/index.mjs');
    const stalePort = await allocateAvailableLocalhostPort();
    const serverTarget = { ...f.target, name: 'server-host' };
    await writeFile(join(f.storageDir, f.stackName, 'stack.runtime.json'), JSON.stringify({
      version: 1, stackName: f.stackName, processes: {}, runtimeMode: 'source-snapshot' }));
    await appendFile(f.envPath, `\nHAPPIER_STACK_QA_DAEMON_TARGETS=${f.target.name}\n`);
    await writeFile(join(f.storageDir, f.stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
      targets: [f.target, serverTarget], runtimePlacement: { qa: { mode: 'local' },
        daemon: { mode: 'prefer-target', target: f.target.name, fallback: 'local' },
        server: { mode: 'prefer-target', target: serverTarget.name, fallback: 'error' } } }));
    await mkdir(join(controllerStackDir, 'scripts'), { recursive: true });
    // Substitute the launched controller Stack process, keeping placement and
    // service selection real. Only a selected daemon role provisions its native
    // connection; a server-only start on the other host cannot publish it.
    await writeFile(join(controllerStackDir, 'scripts/stack.mjs'), `
      import { writeFile } from 'node:fs/promises';
      import { loadControlledRuntimeConfig } from ${JSON.stringify(new URL('../utils/dev_targets/service_placement.mjs', import.meta.url).href)};
      import { resolveStackDaemonStartRequested } from ${JSON.stringify(new URL('../utils/auth/daemon_gate.mjs', import.meta.url).href)};
      await loadControlledRuntimeConfig({ stackName: ${JSON.stringify(f.stackName)}, env: process.env }, {
        runCaptureResult: async () => ({ ok: true, out: 'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true,"unreservedMemoryKiB":14000000}\\n', err: '' }),
      });
      const daemon = resolveStackDaemonStartRequested({ env: process.env, noDaemon: process.argv.includes('--no-daemon') });
      await writeFile(${JSON.stringify(bootstrapPath)}, JSON.stringify({ daemon }));
    `);
    await mkdir(f.paths.stackBaseDir, { recursive: true });
    await writeFile(f.paths.stackEnvPath, [
      `HAPPIER_STACK_REPO_DIR=${f.monoRoot}`, `HAPPIER_STACK_CLI_HOME_DIR=${f.paths.cliHomeDir}`,
      `HAPPIER_STACK_SERVER_PORT=${stalePort}`, 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0', 'HAPPIER_STACK_TAILSCALE_SERVE=0',
    ].join('\n'));
    const nativeState = { version: 1, stackName: f.stackName, processes: {},
      runtimeMode: 'source-snapshot', sourceRuntimeIdentities: {
        daemon: { selected: 'fixture-native-source', loaded: 'fixture-native-source' },
      }, sourceRuntimeLaunch: { cliDir: dirname(dirname(sourceEntrypoint)),
        entrypoint: sourceEntrypoint, env: {} } };
    await writeFile(nativeStatePath, JSON.stringify(nativeState));
    await mkdir(dirname(sourceEntrypoint), { recursive: true });
    // The selected CLI executable is the second process boundary. It receives
    // the recovery command, exact stdin and native home after real cmdLogin.
    await writeFile(sourceEntrypoint, `
      import { readFileSync, appendFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      const args = process.argv.slice(2);
      if (args.includes('recovery-key')) {
        const input = readFileSync(0);
        appendFileSync(${JSON.stringify(loginPath)}, JSON.stringify({ args,
          digest: createHash('sha256').update(input).digest('hex'),
          home: process.env.HAPPIER_HOME_DIR, scope: process.env.HAPPIER_ACTIVE_SERVER_ID,
          listener: process.env.HAPPIER_LOCAL_SERVER_URL }) + '\\n');
      }
    `);
    // The remote process models the native runner that startup provisioned.
    // Its real scoped process bindings attest the published connection. All
    // Stack dispatch, endpoint ownership and guided-login decisions run real code.
    await writeFile(join(f.monoRoot, 'apps/stack/bin/hstack.mjs'), `
      import { readFile } from 'node:fs/promises';
      import { recordStackRuntimeStart } from ${JSON.stringify(new URL('../utils/stack/runtime_state.mjs', import.meta.url).href)};
      for (const key of ['HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_RUNTIME_STATE_PATH', 'HAPPIER_STACK_SERVER_PORT']) delete process.env[key];
      const { daemon } = JSON.parse(await readFile(${JSON.stringify(bootstrapPath)}, 'utf8'));
      if (daemon) await recordStackRuntimeStart(${JSON.stringify(nativeStatePath)}, {
        ...${JSON.stringify(nativeState)}, ownerPid: process.pid,
        serverConnection: { internalServerUrl: ${JSON.stringify(f.url)}, publicServerUrl: ${JSON.stringify(f.url)} } });
      await import(${JSON.stringify(new URL('../../bin/hstack.mjs', import.meta.url).href)});
    `);
    let healthRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/health') healthRequests++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
    });
    await new Promise(resolve => server.listen(f.serverPort, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const input = randomBytes(32).toString('hex');
    const result = await runNodeCapture(['--input-type=module', '-e', `
      import { cmdAuth } from ${JSON.stringify(new URL('./delegated_script_commands.mjs', import.meta.url).href)};
      await cmdAuth({ rootDir: ${JSON.stringify(controllerStackDir)}, stackName: ${JSON.stringify(f.stackName)},
        args: ['--runtime=source', 'login', '--start-if-needed', '--recovery-key-stdin'] });
    `], { cwd: stackDir, env: { ...f.env, HAPPIER_STACK_TEST_TTY: '0',
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'fixture-producer',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '1', HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1' }, input });
    assert.equal(result.code, 0, `real guided recovery must complete: ${result.stderr.replaceAll(input, '[redacted]')}`);
    const logins = (await readFile(loginPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(logins.length, 1, 'one recovery request must launch exactly one native recovery transaction');
    const [login] = logins;
    assert.ok(healthRequests > 0, 'guided login must reach the controller-started server');
    assert.ok(login.args.includes('recovery-key'));
    assert.equal(login.digest, createHash('sha256').update(input).digest('hex'));
    assert.equal(login.home, f.paths.cliHomeDir);
    assert.equal(login.scope, f.paths.activeServerId);
    assert.equal(login.listener, f.url);
    assert.equal(result.stdout.includes(input) || result.stderr.includes(input), false);
  });

test('auth-safe retained startup awaits the native sign-in publication before returning', async t => {
  const f = await createScopeFixture(t);
  const statePath = join(f.storageDir, f.stackName, 'stack.runtime.json');
  const started = await recordStackRuntimeStart(statePath, { stackName: f.stackName, ownerPid: process.pid,
    runtimeMode: 'source-snapshot', placement: { server: 'server-host', daemon: f.target.name },
    remoteTargets: {
      'server-host': { services: { server: true }, status: 'running', serviceStatus: { server: 'running' } },
      [f.target.name]: { services: { daemon: true }, status: 'starting', serviceStatus: { daemon: 'starting' } },
    } });
  let published = false;
  const publication = new Promise((resolve, reject) => setImmediate(async () => {
    try {
      await recordStackRuntimeUpdate(statePath, { remoteTargets: { [f.target.name]: {
        status: 'starting', serviceStatus: { daemon: 'sign-in-required' },
      } } });
      published = true;
      resolve();
    } catch (error) { reject(error); }
  }));
  t.after(() => publication);
  const readiness = await waitForBackgroundStackReadiness({ stackName: f.stackName, scriptPath: 'run.mjs',
    args: ['--runtime=source'], env: { ...f.env, HAPPIER_STACK_AUTH_FLOW: '1' },
    runtimeStatePath: statePath, expectedRuntimeState: started, internalServerUrl: f.url, timeoutMs: 1_000 });
  assert.equal(published, true, 'server readiness alone cannot hand login to an unprovisioned native daemon host');
  assert.deepEqual(readiness, { status: 'sign-in-required' }, 'native transport readiness must settle without requiring login first');
});

test('retained auth print remains read-only with start-if-needed',
  { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
    const f = await createScopeFixture(t);
    const printedPath = f.path('printed.json');
    const controllerStackDir = f.path('controller-stack');
    await mkdir(join(controllerStackDir, 'scripts'), { recursive: true });
    await writeFile(join(controllerStackDir, 'scripts/stack.mjs'), 'throw new Error("print cannot start a stack");');
    await writeFile(join(f.monoRoot, 'apps/stack/bin/hstack.mjs'), `
      import { writeFile } from 'node:fs/promises';
      await writeFile(${JSON.stringify(printedPath)}, JSON.stringify(process.argv.slice(2)));
    `);
    const result = await runNodeCapture(['--input-type=module', '-e', `
      import { cmdAuth } from ${JSON.stringify(new URL('./delegated_script_commands.mjs', import.meta.url).href)};
      await cmdAuth({ rootDir: ${JSON.stringify(controllerStackDir)}, stackName: ${JSON.stringify(f.stackName)},
        args: ['--runtime=source', 'login', '--start-if-needed', '--print'] });
    `], { cwd: stackDir, env: f.env });
    assert.equal(result.code, 0);
    assert.ok(JSON.parse(await readFile(printedPath, 'utf8')).includes('--print'));
  });

for (const command of ['happier', 'auth']) {
  for (const retainedState of [true, false]) {
  test(`retained ${command} login writes the native readiness scope (${retainedState ? 'recorded' : 'explicit source recovery'})`,
    { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
      const f = await createScopeFixture(t);
      if (!retainedState) await writeFile(join(f.storageDir, f.stackName, 'stack.runtime.json'), JSON.stringify({
        version: 1, stackName: f.stackName, ports: { server: f.serverPort }, processes: {} }));
      const args = command === 'happier' ? ['--', 'auth', 'login'] : ['login', '--no-open'];
      const result = await runNodeCapture([join(stackDir, 'bin/hstack.mjs'), 'stack', command, f.stackName,
        ...(!retainedState ? ['--runtime=source'] : []), ...args],
        { cwd: stackDir, env: f.env });
      assert.equal(result.code, 0, 'supported login must complete at the target process');
      const native = JSON.parse(await readFile(f.authPath(f.paths.cliHomeDir), 'utf8'));
      const controller = JSON.parse(await readFile(f.authPath(f.stackCliHome), 'utf8'));
      assert.equal(native.token === f.fresh, true, 'login must replace the native revoked session');
      assert.equal(controller.token === f.revoked, true, 'controller material is not the retained authority');
    });
  }
}

for (const signedIn of [true, false]) {
test(`retained source start ${signedIn ? 'accepts target re-login with a revoked controller' : 'keeps the server running with signed-out target auth'}`,
  { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
    const f = await createScopeFixture(t);
    if (signedIn) {
      const login = await runNodeCapture([join(stackDir, 'bin/hstack.mjs'), 'stack', 'happier', f.stackName,
        '--runtime=source', '--', 'auth', 'login'], { cwd: stackDir, env: f.env });
      assert.equal(login.code, 0, 'supported re-login must finish before startup');
    } else {
      await writeFile(f.authPath(f.stackCliHome), JSON.stringify({ token: f.fresh }));
    }
    let accepted = 0;
    let refused = 0;
    const server = createServer((request, response) => {
      if (request.url !== '/v1/features/authenticated') return response.writeHead(200).end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      if (request.headers.authorization !== `Bearer ${f.fresh}`) { refused++; return response.writeHead(401).end(); }
      accepted++;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(f.features));
    });
    await new Promise(resolve => server.listen(f.serverPort, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    const runtimeStatePath = join(f.storageDir, f.stackName, 'stack.runtime.json');
    const expectedRuntimeState = await recordStackRuntimeStart(runtimeStatePath, {
      stackName: f.stackName, ownerPid: process.pid,
      placement: { server: 'nl3', daemon: 'disabled' },
      runtimeMode: 'source-snapshot', remoteTargets: {},
    });
    const controllerErrors = [];
    const backgroundEnv = { ...f.env, HAPPIER_STACK_STACK: f.stackName,
      HAPPIER_STACK_CLI_HOME_DIR: f.stackCliHome, HAPPIER_ACTIVE_SERVER_ID: f.paths.activeServerId };
    const target = { ...f.target, repoDir, remoteServerPort: f.serverPort };
    const stackBaseDir = f.path('controller');
    const env = { ...f.env, HAPPIER_STACK_STORAGE_DIR: stackBaseDir, HAPPIER_ACTIVE_SERVER_ID: f.paths.activeServerId };
    const sync = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir: repoDir, env });
    await mkdir(dirname(sync.projectFile), { recursive: true });
    await writeFile(sync.projectFile, renderMutagenProject({ sourceDir: repoDir, targets: [target], ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }));
    await prepareDevTargetOpenSsh({ targets: [target], mutagenDir: sync.mutagenDir, env });
    const controller = await startStackDevTargets({ stackName: f.stackName, stackBaseDir,
      sourceDir: repoDir, localServerPort: f.serverPort, cliHomeDir: f.stackCliHome, activeServerId: f.paths.activeServerId,
      publicServerUrl: f.url, canonicalServerUrl: f.url,
      sourceSnapshot: true, sourceUi: 'disabled', env,
      remoteServerRuntimeConfig: resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light',
        env: { HAPPIER_DB_PROVIDER: 'sqlite' } }),
      targetPlans: [{ target,
        services: { server: true, daemon: false, expo: false } }],
      onTargetStateChange: async state => {
        await recordStackRuntimeUpdate(runtimeStatePath, { remoteTargets: { [target.name]: state } });
        if (state.status === 'running' || state.error) settle(state);
      },
    }, {
      runProcess: async input => {
        if (input.command === 'mutagen' && input.args[1] === 'list') {
          return { code: 0, ...readyDevTargetSyncResult(resolveMutagenSessionName(target.name, repoDir)) };
        }
        const command = String(input.args?.at(-1) ?? '');
        if (command.includes('hasTrustedStackRuntimeLifecycle')) return { code: 1 };
        if (command.includes('runtime_identity_missing')) return { code: 0, out: JSON.stringify({
          startedAt: new Date().toISOString(), sourceUi: 'disabled', sourceRuntimeIdentities: {
            server: { selected: 'fixture-source', loaded: 'fixture-source' } } }) };
        return { code: 0 };
      },
      runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
      runDependencyBootstrap: async () => ({ code: 0 }),
      spawnProcess: input => {
        let finish;
        const child = { ...input, exitCode: null, completion: new Promise(resolve => { finish = resolve; }) };
        child.finish = () => { child.exitCode = 0; finish({ code: 0 }); };
        return child;
      },
      stopProcess: async child => child.finish(), waitForProcess: child => child.completion,
      waitForRetry: async () => new Promise(() => {}), logger: { error(message) { controllerErrors.push(message); }, info() {} },
    });
    try {
      const state = await settled;
      const nativeAfterStart = JSON.parse(await readFile(f.authPath(f.paths.cliHomeDir), 'utf8'));
      const controllerAfterStart = JSON.parse(await readFile(f.authPath(f.stackCliHome), 'utf8'));
      assert.equal(nativeAfterStart.token === (signedIn ? f.fresh : f.revoked), true,
        'full retained startup must not overwrite native enrollment from the controller');
      assert.equal(controllerAfterStart.token === (signedIn ? f.revoked : f.fresh), true,
        'retained startup must leave the unused controller scope untouched');
      if (signedIn) {
        assert.equal(state.status, 'running', 'fresh native sign-in must satisfy the production readiness owner');
        await waitForBackgroundStackReadiness({ stackName: f.stackName, scriptPath: 'run.mjs',
          args: ['--runtime=source', '--no-daemon'], env: backgroundEnv, runtimeStatePath,
          expectedRuntimeState, internalServerUrl: f.url, timeoutMs: 1_000 });
        assert.equal(accepted, 1, 'the authenticated probe must use the native sign-in');
        assert.equal(refused, 0, 'the revoked controller session must never be sent');
      } else {
        assert.equal(state.status, 'running', 'client sign-in cannot decide server liveness');
        await waitForBackgroundStackReadiness({ stackName: f.stackName, scriptPath: 'run.mjs',
          args: ['--runtime=source', '--no-daemon'], env: backgroundEnv, runtimeStatePath,
          expectedRuntimeState, internalServerUrl: f.url, timeoutMs: 1_000 });
        assert.deepEqual(controllerErrors, []);
        assert.equal(accepted, 0);
        assert.equal(refused, 1, 'native refusal settles without consulting the valid controller session');
      }
    } finally { await controller.close(); }
  });
}

for (const source of ['explicit', 'source-start-spec']) {
  test(`auth-safe listener bootstrap admits re-login before authenticated readiness (${source})`, async t => {
    const f = await createScopeFixture(t);
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/features/authenticated') return response.writeHead(401).end();
      response.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
    });
    await new Promise(resolve => server.listen(f.serverPort, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const env = { ...f.env, HAPPIER_STACK_CLI_HOME_DIR: f.paths.cliHomeDir, HAPPIER_ACTIVE_SERVER_ID: f.paths.activeServerId };
    const starting = source === 'explicit' ? { env: { ...env, HAPPIER_STACK_AUTH_FLOW: '1' } }
      : buildAuthSafeStackStartSpec({ rootDir: stackDir, stackName: f.stackName, runtimeMode: 'source-snapshot', baseEnv: env });
    const before = await readFile(join(f.paths.cliHomeDir, 'settings.json'), 'utf8');
    await waitForServerReady(f.url, { env: starting.env, cliHomeDir: f.paths.cliHomeDir });
    assert.deepEqual(requests, ['/health'], 'auth bootstrap serves the login listener without refreshing retained Home authority');
    assert.equal(await readFile(join(f.paths.cliHomeDir, 'settings.json'), 'utf8'), before);
  });
}

for (const signedOut of ['revoked', 'missing']) {
test(`ordinary attended and auth-wait startup keeps a signed-out local server running (${signedOut})`, async t => {
  const f = await createScopeFixture(t);
  if (signedOut === 'missing') await unlink(f.authPath(f.paths.cliHomeDir));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/features/authenticated') return response.writeHead(401).end();
    response.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
  });
  await new Promise(resolve => server.listen(f.serverPort, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await waitForServerReady(f.url, { cliHomeDir: f.paths.cliHomeDir, env: { ...f.env,
    HAPPIER_STACK_CLI_HOME_DIR: f.paths.cliHomeDir, HAPPIER_ACTIVE_SERVER_ID: f.paths.activeServerId,
    HAPPIER_STACK_AUTH_FLOW: '', HAPPIER_STACK_TUI: '1', HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1',
  } });
  assert.deepEqual(result, { status: 'sign-in-required' });
  assert.equal(server.listening, true);
  assert.deepEqual(requests, [signedOut === 'missing' ? '/health' : '/v1/features/authenticated']);
});
}
