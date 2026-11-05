import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { access, chmod, cp, link, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createServer } from 'node:http';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installCliNativeCustodySourceFixture, installNativeAdmissionFixture, installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { requestAdmissionSample } from '../proc/admission_client.mjs';

import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { isWorkspaceBundleLockActive, withWorkspaceBundleLock } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';

import { buildStackStableScopeId } from '../auth/stable_scope_id.mjs';
import { parseArgs } from '../cli/args.mjs';
import { resolveSourceQaUiMode } from '../../runtime/shared/borrowed_expo.mjs';
import { buildServerRuntimeEnv } from '../server/server_env.mjs';
import { parseEnvToObject } from '../env/dotenv.mjs';
import { resolveStackServerEndpoint } from '../server/urls.mjs';
import * as commandPolicy from './remote_commands.mjs';
import { isDependencyRefreshLockActive, resolveDependencyRefreshLockPath, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { HOST_OBSERVATION_PROGRAMS } from './host_observation.mjs';
import { admitWorkerDiskBudget, inspectWorkerDiskBudget } from './worker_disk_budget.mjs';
import { measureReplicaSourceBytes } from './replica_source_bytes.mjs';
import { prepareDevTargetCommandSync } from './sync_service.mjs';
import { prepareCommandRepository } from './native_execution_projection.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { INDEPENDENT_DEV_TARGET_SYNC_OWNER } from './sync_project.mjs';
import {
  buildRemoteCancelCommand,
  buildRemoteExecCommand,
  buildRemoteDoctorCommand,
  buildRemoteDaemonCommand,
  buildRemoteDaemonReadinessProbeCommand,
  buildRemoteStackRetirementProbeCommand,
  buildRemoteStackStopCommand,
  buildRemoteStackCommand,
  buildRemoteStackHappierCommand,
  buildRemoteStackOperationCommand,
  buildRemoteRuntimeSnapshotProbeCommand,
  buildRemoteEnsureDirectoriesCommand,
  buildRemoteInstallCredentialCommand,
  buildSshForwardArgs,
  buildSshTunnelArgs,
  buildSshWorkerArgs,
  classifyRemoteCommand,
  isSelfDispatchingPackageCommand,
  renderNativeCommandPolicy,
  resolveRemoteCommandPolicy,
  resolveRemoteValidationComponentRelativeDir,
  resolveRemoteValidationKind,
  resolveRemoteStackStatePaths,
  requiresRemoteDependencyBootstrap,
  requiresRemoteWorkspacePreparation,
  resolveRemoteServerRuntimeConfig,
} from './remote_commands.mjs';

const executionId = '018f0f52-5fe8-7a9f-8ef5-f81f20572791';

test('runtime worker SSH sessions cannot attach to a saturated shared master',
  { skip: process.platform === 'win32' }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-worker-ssh-' });
    const config = join(root, 'ssh.config');
    await writeFile(config, `Host worker.fixture\n  HostName 192.0.2.1\n  ControlMaster auto\n  ControlPersist 600\n  ControlPath ${join(root, 'shared-master')}\n`);
    for (const platform of ['posix', 'windows']) {
      const args = buildSshWorkerArgs({ ssh: 'worker.fixture', platform }, {
        sshArgs: ['-F', config], remoteCommand: 'unused',
      });
      // OpenSSH's configuration evaluator is the real process boundary. -G
      // never connects, so an existing fleet master cannot be disturbed.
      const { stdout } = await promisify(execFile)('ssh', ['-G', ...args]);
      assert.match(stdout, /^hostname 192\.0\.2\.1$/m);
      assert.match(stdout, /^controlmaster false$/m);
      assert.match(stdout, /^serveraliveinterval 0$/m);
      assert.doesNotMatch(stdout, /^controlpath (?!none$).+$/m);
      assert.match(stdout, platform === 'windows' ? /^requesttty false$/m : /^requesttty force$/m);
    }
  });

test('retained daemon-only connection survives an exited native worker for recovery',
  { skip: process.platform === 'win32', timeout: 60_000 }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-retained-daemon-connection-' });
    const repoDir = join(root, 'repo');
    const target = { name: 'native', platform: 'posix', ssh: 'fixture', repoDir,
      cliHomeDir: join(root, 'state', 'cli') };
    const stackName = 'agent-qa-native-connection';
    const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'source-snapshot' });
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const port = server.address().port;
    const serverUrl = ['http:', '', `127.0.0.1:${port}`].join('/');
    const signingOrigin = ['https:', '', 'signing.example.test'].join('/');
    await mkdir(join(repoDir, 'apps/stack/bin'), { recursive: true });
    await mkdir(join(repoDir, 'apps/stack/scripts/utils/env'), { recursive: true });
    await mkdir(join(repoDir, 'apps/stack/scripts/utils/dev_targets'), { recursive: true });
    await mkdir(paths.stackBaseDir, { recursive: true });
    await writeFile(join(root, 'controller-env'), `HAPPIER_STACK_REPO_DIR=${repoDir}\n`);
    // Only the launched native processes are substituted: the worker exits
    // without runtime publication, while the real producer and env writer run.
    await writeFile(join(repoDir, 'apps/stack/bin/hstack.mjs'), 'process.exitCode = 0;\n');
    await writeFile(join(repoDir, 'apps/stack/scripts/utils/dev_targets/runtime_observer.mjs'), 'process.exitCode = 0;\n');
    await writeFile(join(repoDir, 'apps/stack/scripts/utils/env/env_file.mjs'),
      `export { ensureEnvFileMutated } from ${JSON.stringify(new URL('../env/env_file.mjs', import.meta.url).href)};\n`);
    const command = buildRemoteStackCommand(target, {
      stackName, runtimeMode: 'source-snapshot',
      services: { server: false, daemon: true, expo: false },
      serverUrl, publicServerUrl: serverUrl, remoteServerPort: port,
      canonicalServerUrl: signingOrigin,
      env: { HAPPIER_STACK_ENV_FILE: join(root, 'controller-env') },
    });
    await promisify(execFile)('bash', ['-c', command], { cwd: repoDir, env: process.env });
    const nativeEnv = parseEnvToObject(await readFile(paths.stackEnvPath, 'utf8'));
    assert.equal(nativeEnv.HAPPIER_CANONICAL_SERVER_URL === signingOrigin, true,
      'a daemon-only native client must receive the controller URL owner decision');
    const endpoint = await resolveStackServerEndpoint({ stackName, runtimeState: null, env: {
      ...nativeEnv, HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
      HAPPIER_STACK_ENV_FILE: paths.stackEnvPath,
    } });
    assert.equal(endpoint.port, port, 'recovery must use the producer-selected forwarded listener after native exit');
    const response = await fetch(new URL('/health', endpoint.internalServerUrl));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
    const windowsCommand = buildRemoteStackCommand({ ...target, platform: 'windows',
      repoDir: 'C:/fixture/repo', cliHomeDir: 'C:/fixture/state/cli' }, {
      stackName, runtimeMode: 'source-snapshot',
      services: { server: false, daemon: true, expo: false },
      serverUrl, publicServerUrl: serverUrl, remoteServerPort: port, env: {},
      canonicalServerUrl: signingOrigin,
    });
    const windowsProjection = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
    assert.ok(windowsProjection.includes(`HAPPIER_STACK_SERVER_PORT=${port}`));
    assert.equal(windowsProjection.includes(`HAPPIER_CANONICAL_SERVER_URL=${signingOrigin}`), true);
  });

for (const [observation, program] of Object.entries(HOST_OBSERVATION_PROGRAMS)) {
test(`execution config validation and QA host observation (${observation}) do not consume dependencies behind an inherited source preload`,
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack probe dependency scope ' });
    await installNativeAdmissionFixture({ root: fixture.root });
    const repoDir = fixture.path('native-owner');
    const bootstrap = join(repoDir, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs');
    await cp(new URL('../../../bin/localSourceRuntimeBootstrap.mjs', import.meta.url), bootstrap);
    const common = join(repoDir, 'packages/cli-common');
    await mkdir(common, { recursive: true });
    const commonSource = new URL('../../../../../packages/cli-common/', import.meta.url);
    for (const name of await readdir(commonSource)) {
      if (name.endsWith('.mjs')) await cp(new URL(name, commonSource), join(common, name));
    }
    // Only the external transpiler installation is substituted; the bootstrap,
    // execution config, native launcher and observation program all stay real.
    await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
      join(repoDir, 'node_modules/tsx'), 'dir');
    const configPath = join(repoDir, 'execution-config.json');
    await writeFile(configPath, JSON.stringify({ version: 3, targets: [], commandExecution: { mode: 'local' } }));
    const otherPreload = join(repoDir, 'other preload.mjs');
    const otherPreloadObserved = join(repoDir, 'other-preload-observed');
    await writeFile(otherPreload, `import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(otherPreloadObserved)}, String(Error.stackTraceLimit));`);
    const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root,
      HAPPIER_EXEC_CONFIG_PATH: configPath, HAPPIER_STACK_SANDBOX_DIR: fixture.root,
      HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0', HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '0',
      NODE_OPTIONS: `--stack-trace-limit=37 --import=${JSON.stringify(otherPreload)} --import=${JSON.stringify(bootstrap)} --no-warnings` };
    for (const key of ['HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_HSTACK_EXECUTION',
      'HAPPIER_BUILD_DEPENDENCY_CUSTODY', 'HAPPIER_HSTACK_DISPATCH_CONTROL']) delete env[key];
    let releaseWriter;
    let writerReady;
    const held = new Promise(resolve => { releaseWriter = resolve; });
    const ready = new Promise(resolve => { writerReady = resolve; });
    const writer = withDependencyRefreshLock({ installDir: repoDir, env, signal: t.signal }, async () => {
      writerReady();
      await held;
    });
    await ready;
    let waits = 0;
    let stdout = '';
    let stderr = '';
    // The memory program captures its nested sampler's stderr with spawnSync.
    // Observe actual gate-waiter publication so that a blocked nested preload
    // releases this fixture writer and fails the count instead of hanging.
    const waiting = watch(`${resolveDependencyRefreshLockPath(repoDir, env)}.waiters`, () => {
      waits = 1;
      releaseWriter();
    });
    try {
      assert.equal(isDependencyRefreshLockActive({ installDir: repoDir, env }), true);
      const child = spawn('/bin/sh', [join(repoDir, 'apps/stack/bin/hstack-exec'), '--',
        process.execPath, '-e', program],
      { cwd: repoDir, env, stdio: ['ignore', 'pipe', 'pipe'], signal: t.signal });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(status, 0, 'the real config validator and host probe must settle successfully');
      assert.match(stdout, /HSTACK_QA_HOST=/);
      assert.equal(await readFile(otherPreloadObserved, 'utf8'), '37',
        'dependency-free control children preserve unrelated Node options and preloads');
      assert.equal(waits, 0, 'pure control tooling must never join dependency consumption');
      assert.equal(isDependencyRefreshLockActive({ installDir: repoDir, env }), true,
        'observation finishes while the independent dependency writer remains held');
      const readers = await readdir(`${resolveDependencyRefreshLockPath(repoDir, env)}.readers`)
        .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      assert.deepEqual(readers, []);
    } finally {
      waiting.close();
      releaseWriter();
      await writer;
    }
  });
}

test('environment assignments preserve public typecheck placement in both policy projections', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'hstack-typecheck-env-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const payload of [
    ['pnpm', '--dir', 'apps/ui', 'run', 'typecheck'],
    ['pnpm', '--dir', 'apps/cli', 'run', 'typecheck'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--project', 'apps/ui/tsconfig.source.json'],
  ]) {
    const wrapped = ['env', 'CI=true', 'HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS=1', ...payload];
    const expected = await commandPolicy.resolvePackageCommandPolicy(payload, { repoRoot: root, cwd: root });
    const actual = await commandPolicy.resolvePackageCommandPolicy(wrapped, { repoRoot: root, cwd: root });
    for (const key of ['kind', 'component', 'heavyClass', 'selfPublisher', 'compilerLeaf', 'requiredTools']) {
      assert.equal(actual[key], expected[key], key);
    }
    if (process.platform === 'win32') continue;
    const base = commandPolicy.resolveRemoteCommandPolicy(payload, { repoRoot: root, cwd: root });
    const entry = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
    // The launcher first normalizes argv natively, then asks the canonical
    // manifest owner to include composed work such as CLI's UI references.
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; projection_command_policy=$3; shift 3; resolve_native_command_policy "$@" || exit $?; printf "%s,%s,%s\\n" "$policy_kind" "$policy_component" "$policy_heavyClass"; assignments=$(node "$projection_command_policy" --package-policy "$repo_root" "$invoked_cwd" "$@") || exit $?; eval "$assignments"; printf "%s,%s,%s" "$policy_kind" "$policy_component" "$policy_heavyClass"',
      'policy', artifact, root, entry, ...wrapped], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `${base.kind},${base.component},${base.heavyClass}\n${expected.kind},${expected.component},${expected.heavyClass}`);
  }
});

test('extended DB harness admits its composed demand once before Docker and nested public tests', { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
  const { buildExtendedDbCommandPlan } = await import('../../../../../packages/tests/scripts/extended-db-docker.plan.mjs');
  const contractFile = 'sources/fixture.dbcontract.spec.ts';
  const fixture = await createTempFixture(t, { prefix: 'hstack-extended-db-admission-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  await chmod(launcher, 0o755);
  const checkout = fixture.path('native-owner');
  const scripts = join(checkout, 'packages/tests/scripts');
  const server = join(checkout, 'apps/server');
  await Promise.all([mkdir(scripts, { recursive: true }), mkdir(server, { recursive: true }),
    mkdir(join(checkout, 'scripts/workspaces'), { recursive: true })]);
  for (const name of ['run-extended-db-docker.mjs', 'extended-db-docker.plan.mjs']) {
    copyFileSync(new URL(`../../../../../packages/tests/scripts/${name}`, import.meta.url), join(scripts, name));
  }
  const pnpmOwner = new URL('../../../../../scripts/workspaces/execPnpmCommand.mjs', import.meta.url);
  await writeFile(join(checkout, 'scripts/workspaces/execPnpmCommand.mjs'), `export * from ${JSON.stringify(pnpmOwner.href)};\n`);
  await writeFile(join(server, 'package.json'), JSON.stringify({ name: '@happier-dev/server', scripts: {
    'migrate:full:deploy': 'node migration.mjs',
    'test:db-contract': '../stack/bin/hstack-exec --script=test:db-contract:local',
    'test:db-contract:local': 'vitest run --isolate -c vitest.dbcontract.config.ts',
  } }));
  const factsPath = fixture.path('facts.jsonl');
  const probe = fixture.path('probe.mjs');
  await writeFile(probe, `import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { callerHoldsDependencyConsumption } from ${JSON.stringify(new URL('../proc/dependency_refresh.mjs', import.meta.url).href)};
import { requestAdmissionSample } from ${JSON.stringify(new URL('../proc/admission_client.mjs', import.meta.url).href)};
const sample = await requestAdmissionSample(${JSON.stringify(admissionRoot)});
const owners = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT
  ? [{ id: process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT,
    floorKiB: Number(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB) }] : [];
const dependencyRead = callerHoldsDependencyConsumption({ installDir: ${JSON.stringify(checkout)} });
appendFileSync(${JSON.stringify(factsPath)}, JSON.stringify({ phase: process.argv[2], owners, activeCount: sample.activeCount, dependencyRead }) + '\\n');
`);
  await writeFile(join(server, 'migration.mjs'), `process.argv[2] = 'migration'; await import(${JSON.stringify(pathToFileURL(probe).href)});\n`);
  const pnpm = fixture.path('pnpm.mjs');
  await writeFile(pnpm, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2).filter(value => value !== '--silent');
let cwd = process.cwd();
if (args[0] === '--filter') { cwd = ${JSON.stringify(server)}; args.splice(0, 2); }
if (args[0] !== 'run') process.exit(71);
const body = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts[args[1]];
if (!body) process.exit(72);
const result = spawnSync('/bin/sh', ['-c', body + ' "$@"', 'fixture-pnpm', ...args.slice(2)], { cwd, env: process.env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
`);
  // Docker, pnpm, migrations and the Vitest executable are OS boundaries.
  // Classification, public script dispatch, native custody and admission stay real.
  writeFakeBin({ root: fixture.root, name: 'docker', content: `#!/bin/sh
case "$1" in
  info) exec '${process.execPath}' '${probe}' docker ;;
  run) printf '%064d\\n' 0 ;;
  inspect) printf 'healthy\\n' ;;
  port) printf '127.0.0.1:54321\\n' ;;
  rm) exit 0 ;;
  *) exit 73 ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'vitest', content: `#!/bin/sh\nexec '${process.execPath}' '${probe}' contract\n` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '73400320 73400320\\n' ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const fixtureEnv = { ...buildNativeAdmissionFixtureEnv(), npm_execpath: pnpm,
    HAPPIER_STACK_HOME_DIR: fixture.path('stack-home'),
    HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_HSTACK_EXECUTION: '1', CI: '',
    PATH: `${fixture.path('bin')}:${process.env.PATH}` };
  const dependencyGate = relative(fixture.root, resolveDependencyRefreshLockPath(checkout, fixtureEnv));
  assert.ok(dependencyGate && !isAbsolute(dependencyGate) && dependencyGate !== '..'
    && !dependencyGate.startsWith(`..${sep}`), 'the real dependency gate must stay inside the fixture');
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn('/bin/sh', [launcher, '--local', '--', process.execPath,
      'packages/tests/scripts/run-extended-db-docker.mjs', '--db', 'postgres', '--mode', 'contract',
      '--contract-file', contractFile], {
      cwd: checkout, env: fixtureEnv, signal: t.signal,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  const facts = (await readFile(factsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(facts.map(fact => fact.phase), ['docker', 'migration', 'contract']);
  assert.equal(facts[0].owners.length, 1, 'the harness must own admission before it starts Docker');
  for (const fact of facts) {
    assert.equal(fact.activeCount, 1, `${fact.phase} has one live broker admission`);
    assert.deepEqual(fact.owners, facts[0].owners, `${fact.phase} must reuse the same actual native owner`);
    assert.equal(fact.dependencyRead, false, `${fact.phase} does not retain an installed-import reader after loading`);
  }
  const parentFloor = facts[0].owners[0].floorKiB;
  for (const step of buildExtendedDbCommandPlan({ db: 'postgres', mode: 'contract', contractFile, databaseUrl: 'classification-only' })) {
    const child = await commandPolicy.resolvePackageCommandPolicy([step.command, ...step.args], { repoRoot: checkout, cwd: checkout });
    for (const className of [child.heavyClass, child.placementHeavyClass].filter(Boolean)) {
      assert.ok(parentFloor >= commandPolicy.resolveHeavyweightMemoryFloorKiB(className),
        `the admitted parent must cover its actual nested ${className} peak`);
    }
  }
  assert.equal(new Set(facts.map(fact => fact.owners[0].id)).size, 1, 'all phases retain one canonical admission');
  assert.doesNotMatch(result.stderr, /waiting for heavyweight admission/);
  assert.equal((await requestAdmissionSample(admissionRoot)).activeCount, 0);
  t.diagnostic(`contract admissions=1; nested waits=0; floorKiB=${parentFloor}; import reader released at all three boundaries`);
});

test('extended DB coordinators reserve the canonical command plan peak for their whole run', async t => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const { buildExtendedDbCommandPlan } = await import('../../../../../packages/tests/scripts/extended-db-docker.plan.mjs');
  for (const db of ['postgres', 'mysql']) for (const [mode, script] of [['contract', 'test:db-contract:postgres:docker'],
    ['extended', 'test:extended-db:postgres:docker'], ['e2e', 'test:e2e:core:postgres:docker'],
    ['session-system-record-upgrade', 'test:session-system-record-upgrade:postgres:docker']]) {
    const args = ['node', 'packages/tests/scripts/run-extended-db-docker.mjs', '--db', db, '--mode', mode];
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot, cwd: repoRoot });
    const children = await Promise.all(buildExtendedDbCommandPlan({ db, mode, databaseUrl: 'classification-only' })
      .map(step => commandPolicy.resolvePackageCommandPolicy([step.command, ...step.args], { repoRoot, cwd: repoRoot })));
    const demand = children.flatMap(child => [child.heavyClass, child.placementHeavyClass]).filter(Boolean);
    const peak = Math.max(...demand.map(className => commandPolicy.resolveHeavyweightMemoryFloorKiB(className)));
    assert.equal(policy.validation, '1', `${mode} must be admitted before its first OS step`);
    assert.equal(policy.selfPublisher, '0', `${mode} reuses its outer owner rather than deferring admission to children`);
    assert.equal(policy.kind, 'source-test');
    assert.equal(policy.workspaceLock, '', 'the coordinator retains no publication lease across its steps');
    assert.ok(policy.requiredTools.split(/\s+/u).includes('docker'));
    assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass), peak,
      `${mode} must cover its canonical migrations, preparation and test commands`);
    const alias = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', script.replace('postgres', db)], { repoRoot, cwd: repoRoot });
    assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(alias.heavyClass), peak,
      `${script} must preserve its coordinator's peak`);
    t.diagnostic(`${db}/${mode}: peak=${policy.heavyClass} (${peak} KiB); alias=${alias.heavyClass}`);
  }
  for (const args of [['--help'], ['--db', 'unsupported']]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(['node',
      'packages/tests/scripts/run-extended-db-docker.mjs', ...args], { repoRoot, cwd: repoRoot });
    assert.equal(policy.heavyClass, '', 'help and argument errors do not start the harness');
  }
  const contractFile = 'sources/app/session/pending/retainedPendingContext.postgres.dbcontract.spec.ts';
  const focused = await commandPolicy.resolvePackageCommandPolicy(['node',
    'packages/tests/scripts/run-extended-db-docker.mjs', '--db', 'postgres', '--mode', 'contract',
    '--contract-file', contractFile], { repoRoot, cwd: repoRoot });
  const focusedChildren = await Promise.all(buildExtendedDbCommandPlan({ db: 'postgres', mode: 'contract',
    contractFile, databaseUrl: 'classification-only' }).map(step => commandPolicy.resolvePackageCommandPolicy(
    [step.command, ...step.args], { repoRoot, cwd: repoRoot })));
  const focusedPeak = Math.max(...focusedChildren.flatMap(child => [child.heavyClass, child.placementHeavyClass])
    .filter(Boolean).map(className => commandPolicy.resolveHeavyweightMemoryFloorKiB(className)));
  assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(focused.heavyClass), focusedPeak);
  t.diagnostic(`retained pending Postgres contract: peak=${focused.heavyClass} (${focusedPeak} KiB)`);
});

test('standalone Bun compilation declares its compiler tool in both command policy projections', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'hstack-bun-compiler-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [args, required] of [
    [['bun', 'build', '--compile', 'entry.ts'], true],
    [['bun', 'build', 'entry.ts', '--compile'], true],
    [['bun', 'build', 'entry.ts'], false],
    [['bun', 'run', 'entry.ts', '--compile'], false],
    [['bun', 'build', 'entry.ts', '--', '--compile'], false],
    [['node', 'tool.mjs', '--compile'], false],
  ]) {
    assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).requiredTools.split(/\s+/u).includes('bun'), required, args.join(' '));
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_requiredTools"',
      'policy', artifact, root, ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout.split(/\s+/u).includes('bun'), required, args.join(' '));
  }
});

test('source owner suites use authored source without workspace dist publication', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const files = ['scripts/workspaces/runTypeScriptCli.test.mjs',
    'scripts/workspaces/deriveTypecheckProjects.test.mjs',
    'scripts/workspaces/typecheckDiagnostics.test.mjs',
    'scripts/workspaces/workspaceOutputScriptArgs.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs',
    'apps/stack/scripts/utils/fs/workspaceBuildInputs.test.mjs',
    'apps/stack/scripts/utils/dev_targets/worker_disk_budget.test.mjs',
    'apps/stack/scripts/utils/dev_targets/sync_service.test.mjs',
    'apps/stack/scripts/utils/dev_targets/mutagen_project.test.mjs'];
  const fixture = await createTempFixture(t, { prefix: 'hstack-disk-source-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const file of files) {
    const args = ['node', '--conditions=happier-source', '--import', 'tsx', '--test', file];
    const policy = resolveRemoteCommandPolicy(args, { cwd: root });
    assert.equal(policy.kind, 'source-test', file);
    if (['scripts/workspaces/deriveTypecheckProjects.test.mjs', 'scripts/workspaces/workspaceOutputScriptArgs.test.mjs',
      'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs'].includes(file)) {
      assert.equal(policy.heavyClass, 'compilation', 'real compiler bodies retain their existing compilation envelope');
    }
    if (file === 'apps/stack/scripts/utils/fs/workspaceBuildInputs.test.mjs') assert.equal(policy.heavyClass, 'validation');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
      'policy', artifact, root, ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `source-test,${policy.heavyClass}`, file);
  }
});

test('materialization admits measured additional writes without charging resident inputs', async () => {
  // Round 2 observed this many single-link bytes in the cold Yarn copy.
  // This is a constructed admission vector, never a production default.
  const requiredAdditionalBytes = 5280059392;
  for (const availableBytes of [266829824 + 1024, requiredAdditionalBytes, requiredAdditionalBytes + 1024]) {
    const options = { repoDir: '/fixture/repo', cacheBaseDir: '/fixture/cache', commandClass: 'dependency-install',
      observeFilesystem: () => ({ device: 'fixture', availableBytes, totalBytes: 248505155584 }) };
    assert.equal((await inspectWorkerDiskBudget({ ...options, requiredAdditionalBytes })).admitted,
      availableBytes > requiredAdditionalBytes);
    assert.equal((await inspectWorkerDiskBudget(options)).admitted, true);
  }
});

test('materialization refusal never widens automatic replica reclamation', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-materialization-retention-' });
  const repoDir = join(root, 'current'), oldReplica = join(root, 'marked-replica');
  const cacheBaseDir = join(root, 'cli/cache'), scratchRoot = join(root, 'scratch'), procRoot = join(root, 'proc');
  await mkdir(repoDir);
  await mkdir(join(oldReplica, '.happier'), { recursive: true });
  await mkdir(cacheBaseDir, { recursive: true });
  await mkdir(scratchRoot);
  await mkdir(procRoot);
  const marker = join(oldReplica, '.happier/command-replica.json');
  await writeFile(marker, JSON.stringify({ version: 1, repoDir: oldReplica, executorRepoDir: join(root, 'primary') }));
  const old = new Date(Date.now() - 48 * 3600000);
  for (const path of [marker, join(oldReplica, '.happier'), oldReplica]) await utimes(path, old, old);
  const result = await admitWorkerDiskBudget({ repoDir, cacheBaseDir, scratchRoot, procRoot,
    commandClass: 'source-replica', requiredAdditionalBytes: 8192,
    observeFilesystem: () => ({ device: 'fixture', availableBytes: 1024, totalBytes: 65536 }) });
  assert.equal(result.admitted, false);
  assert.equal(result.reclamation.some(step => step.kind === 'command-replicas'), false,
    'worker-local observations cannot establish controller-owned sync inactivity');
  await access(marker);
});

test('source inventory uses the synchronization ignore owner and charges copied source paths only', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-replica-inventory-' });
  const source = join(root, 'source');
  await mkdir(source);
  assert.equal(spawnSync('git', ['init', '--quiet', source]).status, 0);
  const authored = {
    '.gitignore': 'authored-ignored.bin\n.project/\n',
    'authored-ignored.bin': Buffer.alloc(8192),
    '.project/plans/guide.md': 'authored plan input',
  };
  let expectedBytes = 8192; // The second source pathname is copied independently.
  for (const [path, contents] of Object.entries(authored)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), contents);
    expectedBytes += Buffer.byteLength(contents);
  }
  await link(join(source, 'authored-ignored.bin'), join(source, 'authored-copy.bin'));
  for (const path of ['node_modules/installed.bin', '.project/tmp/output.bin', '.project/plans/fixture/node_modules/output.bin']) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), Buffer.alloc(65536));
  }
  await writeFile(join(root, 'external.bin'), Buffer.alloc(65536));
  await symlink(join(root, 'external.bin'), join(source, 'external-link.bin'));
  assert.equal(await measureReplicaSourceBytes(source), expectedBytes);
});

test('cold replica bootstrap refuses before source transition, while a materialized replica stays usable', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-replica-disk-' });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 242680816 242000000 260577 100%% /\\n"\n');
  await chmod(join(bin, 'df'), 0o700);
  // This fixture links the executor tree; real worker executor paths are not
  // symlinks. Preserve the linked entry URL so Node still invokes its real CLI.
  await writeFile(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' --preserve-symlinks-main "$@"\n`);
  await chmod(join(bin, 'node'), 0o700);
  const executorRepoDir = join(root, 'primary');
  await symlink(fileURLToPath(new URL('../../../../../', import.meta.url)), executorRepoDir, 'dir');
  const repoDir = join(root, 'replica');
  const target = { name: 'worker', platform: 'posix', ssh: 'worker', executorRepoDir, repoDir,
    cliHomeDir: join(root, 'home'), remotePath: [bin, ...process.env.PATH.split(':')] };
  const command = buildRemoteEnsureDirectoriesCommand(target, { commandReplica: true, requiredAdditionalBytes: 5280059392 });
  const run = () => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  const refused = run();
  assert.equal(refused.status, 76, 'cold source must not start a transition on a worker below its measured footprint');
  await assert.rejects(access(join(repoDir, '.happier/command-replica.json')), { code: 'ENOENT' });
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(repoDir, 'package.json'), '{}');
  assert.equal(run().status, 0, 'a warm replica does not copy its resident tree again');
});

test('command synchronization measures actual synchronized source before making a cold replica', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cold-source-' });
  const sourceDir = join(root, 'source'), bin = join(root, 'bin'), stackBaseDir = join(root, 'stack');
  await mkdir(sourceDir);
  await mkdir(bin);
  await mkdir(stackBaseDir);
  assert.equal(spawnSync('git', ['init', '--quiet', sourceDir]).status, 0);
  await writeFile(join(sourceDir, 'package.json'), '{}');
  await writeFile(join(sourceDir, 'authored.bin'), Buffer.alloc(8192));
  const executorRepoDir = join(root, 'primary');
  await symlink(fileURLToPath(new URL('../../../../../', import.meta.url)), executorRepoDir, 'dir');
  const repoDir = join(root, 'replica'), syncCalls = join(root, 'sync-calls'), inventoryCalls = join(root, 'inventory-calls');
  const target = { name: 'worker', platform: 'posix', ssh: 'worker', executorRepoDir, repoDir,
    cliHomeDir: join(root, 'home'), remotePath: [bin, ...process.env.PATH.split(':')] };
  const targets = [target, { ...target, name: 'other-worker', repoDir: join(root, 'other-replica') }];
  const config = { version: 3, targets,
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: targets.map(target => target.name), fallback: 'error' } };
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
  const binaries = {
    node: `#!/bin/sh\nexec '${process.execPath}' --preserve-symlinks-main "$@"\n`,
    df: '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 242680816 242680815 1 100%% /\\n"\n',
    ssh: '#!/bin/sh\nfor argument do command=$argument; done\nexec /bin/sh -c "$command"\n',
    mutagen: '#!/bin/sh\nprintf invoked >> "$SOURCE_SYNC_CALLS"\nexit 90\n',
    git: '#!/bin/sh\nfor argument do\nif [ "$argument" = ls-files ]; then printf "invoked\\n" >> "$SOURCE_INVENTORY_CALLS"; fi\ndone\nexec /usr/bin/git "$@"\n',
  };
  for (const [name, content] of Object.entries(binaries)) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o700);
  }
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'),
    PATH: `${bin}:${process.env.PATH}`, SOURCE_SYNC_CALLS: syncCalls, SOURCE_INVENTORY_CALLS: inventoryCalls };
  const prepare = () => prepareDevTargetCommandSync({ stackBaseDir, sourceDir, targets, env });
  await assert.rejects(prepare(), { code: 'DEV_TARGET_REPLICA_BOOTSTRAP_FAILED' });
  await assert.rejects(access(join(repoDir, '.happier/command-replica.json')), { code: 'ENOENT' });
  assert.equal(await readFile(syncCalls, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }), '', 'denied source materialization must never start Mutagen');
  assert.equal((await readFile(inventoryCalls, 'utf8')).trim(), 'invoked', 'a cold dispatch inventories its source once for all workers');

  for (const target of targets) {
    await mkdir(target.repoDir);
    await writeFile(join(target.repoDir, 'package.json'), '{}');
  }
  await assert.rejects(prepare(), 'package.json from a failed first transition cannot certify a warm replica');
  assert.equal(await readFile(syncCalls, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }), '');

  for (const target of targets) await writeFile(join(target.repoDir, 'authored.bin'), Buffer.alloc(8192));
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir, env });
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  await writeFile(runtime.projectFile, renderMutagenProject({ sourceDir, targets, config, ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER }));
  await writeFile(runtime.syncServiceStateFile, JSON.stringify({ version: 1, state: 'ready',
    targets: Object.fromEntries(targets.map(target => [target.name, { state: 'ready' }])) }));
  const beforeWarm = await readFile(inventoryCalls, 'utf8');
  assert.deepEqual(await prepare(), { excludedTargets: [] });
  assert.equal(await readFile(inventoryCalls, 'utf8'), beforeWarm, 'ready replicas perform zero whole-source inventories');

  await t.test('reusing ready target names for new partial endpoints requires source admission', async () => {
    for (let index = 0; index < targets.length; index++) {
      targets[index] = { ...targets[index], repoDir: join(root, `replacement-${targets[index].name}`) };
      await mkdir(targets[index].repoDir);
      await writeFile(join(targets[index].repoDir, 'package.json'), '{}');
    }
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
    await assert.rejects(prepare(), { code: 'DEV_TARGET_REPLICA_BOOTSTRAP_FAILED' });
    assert.equal(await readFile(syncCalls, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }), '', 'old ready state cannot authorize a transition into a different partial endpoint');
  });
});

test('generated source preflight refuses a worker whose disk owner predates materialization admission', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-old-disk-owner-' });
  const bin = join(root, 'bin'), repoDir = join(root, 'replica'), cliHomeDir = join(root, 'home');
  await mkdir(bin);
  await mkdir(repoDir);
  await mkdir(cliHomeDir);
  const unexpectedCalls = join(root, 'unexpected-calls');
  // OS/worker boundary: old owners ignore unknown flags but reject unknown
  // classes. A new flag alone would silently pass instead of refusing.
  await writeFile(join(bin, 'node'), `#!/bin/sh\nfor argument do\ncase "$argument" in\n--class=source-replica) exit 76 ;;\nesac\ndone\nprintf invoked >> '${unexpectedCalls}'\nexit 0\n`);
  await chmod(join(bin, 'node'), 0o700);
  const target = { name: 'old-worker', platform: 'posix', ssh: 'old-worker', repoDir, cliHomeDir,
    executorRepoDir: join(root, 'primary'), remotePath: [bin, ...process.env.PATH.split(':')] };
  const command = buildRemoteEnsureDirectoriesCommand(target, { commandReplica: true,
    requireSourceAdmission: true, requiredAdditionalBytes: 8192 });
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 76, result.stderr);
  await assert.rejects(access(unexpectedCalls), { code: 'ENOENT' });
  await assert.rejects(access(join(repoDir, '.happier/command-replica.json')), { code: 'ENOENT' });
});

test('cold command preparation refreshes the executor owner before measured admission and leaves warm owners alone', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-executor-source-order-' });
  const sourceDir = join(root, 'source'), executorSourceDir = join(root, 'executor'), bin = join(root, 'bin');
  const stackBaseDir = join(root, 'stack'), worker = join(root, 'worker'), executorRepoDir = join(worker, 'primary');
  for (const path of [sourceDir, executorSourceDir, bin, stackBaseDir, executorRepoDir]) await mkdir(path, { recursive: true });
  await writeFile(join(sourceDir, 'package.json'), '{"private":true,"packageManager":"pnpm@12.14.0"}');
  await writeFile(join(sourceDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(sourceDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const target = { name: 'nl3', platform: 'posix', ssh: 'worker', repoDir: executorRepoDir,
    cliHomeDir: join(root, 'home'), remotePath: [bin, ...process.env.PATH.split(':')] };
  const configPath = join(stackBaseDir, 'dev-targets.json');
  await writeFile(configPath, JSON.stringify({ version: 3, targets: [target],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: [target.name], fallback: 'error' } }));
  const updated = join(root, 'updated-owner'), flushes = join(root, 'flushes');
  const budget = fileURLToPath(new URL('./worker_disk_budget.mjs', import.meta.url));
  const expectedSession = resolveMutagenSessionName(target.name, executorSourceDir);
  await writeFile(join(root, 'mutagen.mjs'), [
    'import fs from "node:fs";',
    'const [family, action, name] = process.argv.slice(2);',
    'if (family === "sync" && action === "flush") {',
    '  fs.appendFileSync(process.env.OWNER_FLUSHES, name + "\\n");',
    '  if (name === process.env.EXECUTOR_SESSION) fs.writeFileSync(process.env.UPDATED_OWNER, "ready");',
    '  else fs.writeFileSync(process.env.COMMAND_REPLICA + "/package.json", "{}");',
    '}',
    'if (family === "sync" && action === "list") {',
    '  const template = process.argv[process.argv.indexOf("--template") + 1];',
    '  if (template === "{{json .}}") console.log(JSON.stringify([{name, paused:false, status:"watching", successfulCycles:1, alpha:{connected:true,scanned:true}, beta:{connected:true,scanned:true}}]));',
    '  else console.log(`${name}|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0`);',
    '}',
  ].join('\n'));
  const binaries = {
    ssh: '#!/bin/sh\nfor command; do :; done\nexec /bin/sh -c "$command"\n',
    mutagen: `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'mutagen.mjs')}' "$@"\n`,
    node: `#!/bin/sh\ncase "$1" in\n*/worker_disk_budget.mjs) [ -f '${updated}' ] || exit 76; shift; exec '${process.execPath}' '${budget}' "$@" ;;\n*) exec '${process.execPath}' "$@" ;;\nesac\n`,
  };
  for (const [name, body] of Object.entries(binaries)) { await writeFile(join(bin, name), body); await chmod(join(bin, name), 0o700); }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: '',
    HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'), UPDATED_OWNER: updated, OWNER_FLUSHES: flushes,
    EXECUTOR_SESSION: expectedSession, COMMAND_REPLICA: join(worker, 'source') };
  const prepare = () => prepareCommandRepository({ configPath, repoRoot: sourceDir, executorRepoRoot: executorSourceDir, env });
  assert.deepEqual((await prepare()).excludedTargets, []);
  const firstFlushes = await readFile(flushes, 'utf8');
  assert.equal(firstFlushes.split('\n').filter(name => name === expectedSession).length, 1);
  assert.deepEqual((await prepare()).excludedTargets, []);
  assert.equal(await readFile(flushes, 'utf8'), firstFlushes, 'warm command replicas do not reflush the executor');
});

test('SDK API-surface suites use source preparation only with the source condition', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const files = ['packages/plugin-sdk/scripts/apiSurfaceCli.test.mjs', 'packages/plugin-sdk/scripts/apiSurface.test.mjs'];
  const fixture = await createTempFixture(t, { prefix: 'sdk-api-source-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const source of [true, false]) {
    for (const selection of [files, ...files.map(file => [file]), [...files, 'packages/plugin-sdk/scripts/unknown.test.mjs']]) {
      const args = ['node', ...(source ? ['--import', 'tsx', '--conditions=happier-source'] : []), '--test', ...selection];
      const policy = resolveRemoteCommandPolicy(args, { cwd: root });
      const expected = source && !selection.includes('packages/plugin-sdk/scripts/unknown.test.mjs') ? 'source-test' : 'runtime';
      assert.equal(policy.kind, expected);
      assert.equal(policy.heavyClass, 'compilation', 'the real TypeScript API workload retains compiler admission');
      if (process.platform === 'win32') continue;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
        'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, `${expected},compilation`);
    }
  }
});

test('stable-port authored Stack suites use source preparation only with the source condition', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const files = ['apps/stack/scripts/run_script_with_stack_env.restart_port_reuse.test.mjs',
    'apps/stack/scripts/utils/stack/runtime_state.test.mjs',
    'apps/stack/scripts/utils/dev_targets/supervisor.test.mjs',
    'apps/stack/scripts/utils/dev_targets/runtime_observer.test.mjs',
    'apps/stack/scripts/stack_info_runtime_snapshot.test.mjs'];
  const fixture = await createTempFixture(t, { prefix: 'hstack-stable-port-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const source of [false, true]) {
    for (const selection of [files, ...files.map(file => [file]), [...files, 'apps/stack/scripts/unknown.test.mjs']]) {
      const args = ['node', ...(source ? ['--import', 'tsx', '--conditions=happier-source'] : []), '--test', ...selection];
      const expected = source && !selection.includes('apps/stack/scripts/unknown.test.mjs') ? 'source-test' : 'runtime';
      assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).kind, expected);
      if (process.platform === 'win32') continue;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
        'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, expected);
    }
  }
});

test('tracked-source writers stay on the primary while checks remain worker eligible', async t => {
  const fixture = await createTempFixture(t, { prefix: 'tracked-source-placement-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const requests = [
    { args: ['node', '--max-old-space-size=6144', 'scripts/api-governance/cli.mjs', '--profile', 'plugin-ui', '--write'], placement: 'primary-only' },
    { args: ['node', 'scripts/api-governance/cli.mjs', '--profile', 'plugin-ui', '--check'], placement: 'worker-eligible' },
    { args: ['node', 'scripts/api-governance/cli.mjs', '--profile', 'plugin-ui', '--json'], placement: 'worker-eligible' },
    { args: ['node', 'packages/plugin-sdk/scripts/apiSurfaceCli.mjs', '--materialize-source', '--write'], placement: 'primary-only' },
    { args: ['node', 'packages/plugin-sdk/scripts/apiSurfaceCli.mjs', '--materialize-source', '--check'], placement: 'worker-eligible' },
    { args: ['node', 'apps/website/scripts/i18n-extract.mjs'], placement: 'primary-only' },
    { args: ['node', 'apps/website/scripts/i18n-extract.mjs', '--report'], placement: 'worker-eligible' },
    { args: ['node', 'apps/docs/scripts/generateReference.mjs'], placement: 'primary-only' },
    { args: ['node', 'apps/docs/scripts/generateReference.mjs', '--check'], placement: 'worker-eligible' },
    { args: ['node', 'packages/embed/scripts/generateThemeTokenIds.mjs', '--write'], placement: 'primary-only' },
    { args: ['node', 'packages/embed/scripts/generateThemeTokenIds.mjs', '--check'], placement: 'worker-eligible' },
    { args: ['node', 'apps/website/scripts/optimize-images.mjs'], placement: 'primary-only' },
    { args: ['node', 'apps/website/scripts/optimize-images.mjs', '--check'], placement: 'worker-eligible' },
    { args: ['node', 'apps/website/scripts/optimize-feature-images.mjs'], placement: 'primary-only' },
    { args: ['node', 'apps/stack/scripts/utils/dev_targets/native_execution_projection.mjs', '--write-sync-policy'], placement: 'primary-only' },
    { args: ['node', 'apps/website/scripts/prune-source-images.mjs'], placement: 'worker-eligible' },
    { args: ['node', 'apps/website/scripts/generate-plugin-manifest-schema.mjs'], placement: 'primary-only' },
    { args: ['node', 'apps/website/scripts/generate-plugin-manifest-schema.mjs', '--check'], placement: 'primary-only' },
    { args: ['oxfmt', '.'], placement: 'primary-only' },
    { args: ['oxfmt', '.', '--check'], placement: 'worker-eligible' },
    { args: ['oxfmt', '.', '--list-different'], placement: 'worker-eligible' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=validation', '--', 'oxfmt', '.'], placement: 'primary-only' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=validation', '--', 'node', 'scripts/api-governance/cli.mjs', '--profile', 'plugin-ui', '--write'], placement: 'primary-only' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=validation', '--', 'git', 'status'], placement: 'primary-only' },
    { args: ['node', 'apps/server/scripts/runTsx.mjs', '--tsconfig', 'apps/server/tsconfig.json', 'apps/server/scripts/schemaSync.ts'], placement: 'primary-only' },
    { args: ['node', 'apps/server/scripts/runTsx.mjs', '--tsconfig', 'apps/server/tsconfig.json', 'apps/server/scripts/schemaSync.ts', '--check'], placement: 'worker-eligible' },
    { args: ['go', '-C', 'packages/plugins/cliproxyapi/managed-runtime', 'run', './tools/catalog'], placement: 'primary-only' },
    { args: ['go', '-C', join(fixture.root, 'packages/plugins/cliproxyapi/managed-runtime'), 'run', './tools/catalog'], placement: 'primary-only' },
    { args: ['node', 'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs', '--mode', 'check'], placement: 'worker-eligible' },
    { args: ['node', 'apps/ui/scripts/generateBundledPluginUiArtifacts.mjs', '--mode', 'write'], placement: 'worker-eligible' },
    { args: ['node', 'apps/website/scripts/generate-marketplace-catalog.mjs'], placement: 'worker-eligible' },
    { args: ['node', 'apps/server/scripts/runTsx.mjs', './scripts/generateClients.ts'], placement: 'worker-eligible' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], placement: 'worker-eligible' },
  ];
  for (const { args, placement } of requests) {
    await t.test(args.join(' '), () => {
      assert.equal(resolveRemoteCommandPolicy(args, { repoRoot: fixture.root, cwd: fixture.root }).placement, placement);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_placement"', 'policy', artifact, fixture.root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, placement);
    });
  }
});

test('the Go catalog writer keeps primary placement with Windows working directories', () => {
  const root = 'C:\\workspace\\happier';
  const policy = resolveRemoteCommandPolicy(['go', '-C', 'packages/plugins/cliproxyapi/managed-runtime', 'run', './tools/catalog'], { repoRoot: root, cwd: root });
  assert.equal(policy.placement, 'primary-only');
});

test('manifest aliases and lifecycle hooks keep the whole tracked-source publication local', async t => {
  const fixture = await createTempFixture(t, { prefix: 'tracked-source-manifest-' });
  const cwd = fixture.path('packages/plugin-ui');
  await mkdir(cwd, { recursive: true });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: {
    'prepare:api-governance': 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
    'prepare:generated-input': 'node ../plugin-sdk/scripts/generateActionTypeMap.mjs --write',
    'api-governance': 'pnpm run prepare:api-governance && pnpm run api-governance:emit',
    'api-governance:emit': 'node --max-old-space-size=6144 ../../scripts/api-governance/cli.mjs --profile plugin-ui --write',
    'api-declarations': 'pnpm run api-governance',
    'check:api-governance': 'pnpm run prepare:generated-input && pnpm run prepare:api-governance && node ../../scripts/api-governance/cli.mjs --profile plugin-ui --check',
    typecheck: 'node ../plugin-sdk/scripts/buildHostedHtmlGuestBootstrap.mjs && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit',
    validate: 'pnpm run typecheck',
    'reference': '../../apps/stack/bin/hstack-exec --script=reference:local',
    'reference:local': 'node ../../apps/docs/scripts/generateReference.mjs',
    'check:authority': 'git status',
    prebuild: 'pnpm run api-governance:emit',
    build: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
  } }));
  for (const script of ['api-governance', 'api-governance:emit', 'api-declarations', 'build', 'check:api-governance', 'prepare:api-governance', 'typecheck', 'validate']) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', script], { cwd, repoRoot: fixture.root });
    assert.equal(policy.placement, ['build', 'check:api-governance', 'prepare:api-governance', 'typecheck', 'validate'].includes(script) ? 'worker-eligible' : 'primary-only', script);
  }
  const check = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'reference', '--', '--check'], { cwd, repoRoot: fixture.root });
  assert.equal(check.placement, 'worker-eligible', 'forwarded check arguments must reach the generator');
  const authority = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'check:authority'], { cwd, repoRoot: fixture.root });
  assert.equal(authority.placement, 'primary-only', 'validation intent never relaxes Git authority');
});

test('tracked-source API publications use the real package manifests without relocating checks', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const script of ['format', 'format:check']) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', script], { repoRoot: root, cwd: root });
    assert.equal(policy.placement, script === 'format' ? 'primary-only' : 'worker-eligible', script);
  }
  for (const component of ['packages/plugin-ui', 'packages/plugin-sdk', 'packages/sdk', 'packages/embed']) {
    for (const script of ['api-governance', 'check:api-governance', 'typecheck']) {
      const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', '--dir', component, 'run', script], { repoRoot: root, cwd: root });
      assert.equal(policy.placement, script === 'api-governance' ? 'primary-only' : 'worker-eligible', `${component} ${script}`);
    }
  }
});

test('finite validation resources retain publication custody without dependency consumption', () => {
  for (const validation of ['0', '1']) for (const bootstrap of ['0', '1']) {
    const policy = { validation, bootstrap, selfPublisher: '0', workspaceLock: '' };
    assert.deepEqual(commandPolicy.resolveCommandWorkspaceLocks(policy, '/fixture'), []);
    assert.deepEqual(commandPolicy.resolveCommandWorkspaceLocks({ ...policy, workspaceLock: 'publisher.lock' }, '/fixture'),
      [{ path: join('/fixture', 'publisher.lock') }]);
  }
});

test('package binary invocations use payload placement instead of same-named scripts', async t => {
  const fixture = await createTempFixture(t, { prefix: 'package-binary-placement-' });
  const root = fixture.root;
  const cwd = fixture.path('apps/ui');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: '@happier-dev/app', scripts: {
    vitest: '../stack/bin/hstack-exec --script=vitest:local',
    exec: '../stack/bin/hstack-exec --script=exec:local',
    dlx: '../stack/bin/hstack-exec --script=dlx:local',
    x: '../stack/bin/hstack-exec --script=x:local',
  } }));
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const binaries = [
    ['pnpm', 'exec'], ['pnpm', 'dlx'], ['pnpm', 'x'],
    ['corepack', 'pnpm', 'exec'], ['npm', 'exec'], ['yarn', 'exec'], ['npx'],
  ].map(prefix => ({ cwd, args: [...prefix, 'vitest', 'run', 'sample.test.ts'] }));
  binaries.push({ cwd: root, args: ['pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', 'sample.test.ts'] });
  binaries.push({ cwd: root, args: ['pnpm', '--filter', '@happier-dev/app', 'exec', 'vitest', 'run', 'sample.test.ts'] });
  binaries.push({ cwd: root, args: ['pnpm', '-F', '@happier-dev/app', 'exec', 'vitest', 'run', 'sample.test.ts'] });
  binaries.push({ cwd: root, args: ['corepack', 'pnpm', '--dir', 'apps', '--filter=@happier-dev/app', 'exec', 'vitest', 'run', 'sample.test.ts'] });
  binaries.push({ cwd: root, args: ['pnpm', '--dir', 'apps', 'exec', 'pnpm', '--dir', 'ui', 'exec', 'vitest', 'run', 'sample.test.ts'] });
  binaries.push({ cwd, args: ['npm', 'exec', '--', 'vitest', 'run', 'sample.test.ts'] });
  for (const payload of [['rg', '--files'], ['node', '--test', 'sample.test.mjs'], ['tsc', '--noEmit']]) {
    binaries.push({ cwd, args: ['pnpm', 'exec', ...payload], payload });
  }
  for (const request of binaries) {
    const expected = await commandPolicy.resolvePackageCommandPolicy(request.payload ?? ['vitest', 'run', 'sample.test.ts'], { cwd, repoRoot: root });
    await t.test(`JS ${request.args.join(' ')}`, async () => {
      assert.equal(await isSelfDispatchingPackageCommand(request.args, { ...request, repoRoot: root }), false);
      assert.deepEqual(await commandPolicy.resolvePackageCommandPolicy(request.args, { cwd: request.cwd, repoRoot: root }), expected);
    });
    await t.test(`native ${request.args.join(' ')}`, () => {
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; projection_command_policy=$4; shift 4; resolve_native_command_policy "$@"; printf "%s,%s,%s,%s,%s,%s" "$policy_hasScript" "$policy_kind" "$policy_heavyClass" "$policy_placement" "$policy_workerTool" "$policy_component"',
        'policy', artifact, root, request.cwd, fileURLToPath(new URL('./remote_commands.mjs', import.meta.url)), ...request.args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, `0,${expected.kind},${expected.heavyClass},${expected.placement},${expected.workerTool},apps/ui`);
    });
  }
  for (const args of [['pnpm', 'run', 'vitest'], ['pnpm', 'vitest'], ['corepack', 'pnpm', 'vitest'],
    ['pnpm', 'run', 'exec'], ['pnpm', 'run', 'dlx'], ['pnpm', 'run', 'x']]) {
    await t.test(args.join(' '), async () => {
      assert.equal(await isSelfDispatchingPackageCommand(args, { cwd, repoRoot: root }), true);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_hasScript"',
        'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '1');
    });
  }
});

test('composed CLI typecheck admission includes its referenced UI producer before reserving capacity', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-composed-typecheck-policy-' });
  const cli = fixture.path('apps/cli');
  const ui = fixture.path('apps/ui');
  await Promise.all([mkdir(cli, { recursive: true }), mkdir(ui, { recursive: true })]);
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', scripts: {
    typecheck: '../stack/bin/hstack-exec --script=typecheck:local',
    'typecheck:local': 'pnpm run typecheck:source:finite',
    'typecheck:source:finite': 'node ../../scripts/workspaces/runTypeScriptCli.mjs --project tsconfig.test-ui.json --noEmit',
  } }));
  await writeFile(join(ui, 'package.json'), JSON.stringify({ name: '@happier-dev/app' }));
  const project = join(cli, 'tsconfig.test-ui.json');
  const direct = ['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--project', 'tsconfig.test-ui.json', '--noEmit'];
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const referenced of [false, true]) {
    await writeFile(project, JSON.stringify({ references: referenced ? [{ path: '../ui/tsconfig.source.json' }] : [] }));
    const expected = referenced ? 'compilation-ui' : 'compilation-cli';
    for (const request of [
      { cwd: cli, args: direct },
      { cwd: cli, args: ['pnpm', 'run', 'typecheck:local'] },
      { cwd: cli, args: ['pnpm', 'run', 'typecheck'] },
      { cwd: fixture.root, args: ['pnpm', '--dir', 'apps/cli', 'exec', ...direct] },
      { cwd: fixture.root, args: ['pnpm', '--filter', '@happier-dev/cli', 'exec', ...direct] },
    ]) {
      await t.test(`${referenced}: ${request.args.join(' ')}`, async () => {
        const policy = await commandPolicy.resolvePackageCommandPolicy(request.args, { repoRoot: fixture.root, cwd: request.cwd });
        assert.equal(policy.heavyClass, expected, 'the containing command must reserve its real producer envelope');
        if (process.platform === 'win32') return;
        const entry = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
        const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; projection_command_policy=$4; shift 4; resolve_native_command_policy "$@"; eval "$(node "$projection_command_policy" --package-policy "$repo_root" "$invoked_cwd" "$@")"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
          'policy', artifact, fixture.root, request.cwd, entry, ...request.args], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout, `typecheck,${expected}`);
      });
    }
  }
});

test('export admission preserves Metro-owned interactive concurrency', () => {
  const entry = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
  for (const [interactive, override, flags, expected] of [
    ['1', '', [], 'explicit 0\n'],
    ['0', '', [], 'managed 1\n'],
    ['1', '8', [], 'explicit 8\n'],
    ['0', '0', [], 'explicit 0\n'],
    ['0', '8', ['--max-workers=4', '--max-workers', '47'], 'explicit 47\n'],
  ]) {
    const result = spawnSync(process.execPath, [entry, '--source-web-export-workers', interactive, ...flags], {
      encoding: 'utf8', env: { ...process.env, GOMAXPROCS: '1', HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: override },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test('measured native workload reservations round the recorded peak without a blanket margin', async t => {
  // SYSTEMIC-DELETE owner Q1 (2026-10-29): measured peak, rounded up.
  // Retained evidence: SYSTEMIC-DELETE/step10-native-source-test-measurement.log
  // and step10-dependency-install-topological-setup-measurement.log;
  // entry-loads-footprint-1029/measure-v{2,4}.log; custody cold raw
  // .project/tmp/validation-cost-1024-go-cold-corrected.jsonl, SUMMARY.
  for (const [className, peakKiB] of [
    ['native-source-test', 103824],
    ['native-custody', 366000],
    ['dependency-install', 2374684],
    ['validation', 1824752],
    // validation-floor-sizing-1104/measurements.json, loaded Linux workers.
    ['focused-validation', 779072],
    // focused-vitest-reservation-1105/measure-v2.log, loaded UI components.
    ['focused-validation-ui', 2995796],
    ['entry-loads', 2361852],
    // 2026-11-04 admission holder tree RSS; compile-reservation-peaks-1104/holder-snapshot.json.
    ['compilation', 38992620],
  ]) {
    await t.test(className, () => {
      const expectedKiB = Math.ceil(peakKiB / (1024 * 1024)) * 1024 * 1024;
      assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(className), expectedKiB, className);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nheavyweight_memory_floor_kib "$1"`, 'floor', className], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(Number(native.stdout), expectedKiB, className);
    });
  }
});

test('focused source validation uses its measured shape while compiler and suite demand retain their floor', async t => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'focused-validation-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [component, tail, expected] of [
    ['apps/ui', ['sources/utils/path/resolvePathRelativeToRoot.test.ts'], 'focused-validation-ui'],
    ['apps/cli', ['src/utils/path/expandHomeDirPath.test.ts'], 'validation'],
    ['apps/server', ['sources/app/session/turns/parseSessionTurnState.test.ts'], 'focused-validation'],
    ['packages/channels-protocol', ['src/v1/text.test.ts'], 'focused-validation'],
    ['packages/support', [], 'validation'],
    ['apps/ui', ['sources/utils/path'], 'validation'],
    ['apps/ui', ['--testNamePattern', 'sources/utils/path/resolvePathRelativeToRoot.test.ts'], 'compilation'],
    ['apps/ui', ['sources/utils/path/missing.test.ts'], 'validation'],
    ['apps/server', ['--config', 'vitest.config.ts', '--config', 'vitest.integration.config.ts',
      'sources/app/session/turns/parseSessionTurnState.test.ts'], 'validation'],
    ['apps/ui', ['--config', 'vitest.config.ts', '--config', 'vitest.config.ts',
      'sources/utils/path/resolvePathRelativeToRoot.test.ts'], 'compilation'],
    ['packages/channels-protocol', ['src/sdkSchemaClosure.test.ts'], 'compilation'],
    ['apps/cli', ['--config', 'vitest.integration.config.ts', 'src/utils/path/expandHomeDirPath.test.ts'], 'compilation'],
  ]) await t.test(`${component} ${tail.join(' ') || 'suite'}`, async () => {
    const args = ['pnpm', '--dir', component, 'exec', 'vitest', 'run', ...tail];
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot, cwd: repoRoot });
    assert.equal(policy.heavyClass, expected);
    const floor = commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass);
    assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass, { machine: 'local' }), floor);
    if (expected === 'compilation') {
      assert.ok(floor > commandPolicy.resolveHeavyweightMemoryFloorKiB('validation'),
        'a selected compiler consumer still reserves its containing compiler workload');
    }
    if (process.platform === 'win32') return;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_heavyClass"',
      'policy', artifact, repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, expected);
  });
  await t.test('entry loads retain their larger measured process-tree peak', async () => {
    const args = ['node', 'apps/stack/scripts/perf/entry-load.mjs'];
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot, cwd: repoRoot });
    assert.equal(policy.heavyClass, 'entry-loads');
    // Successful loaded run: validation-floor-sizing-1104/measure.log.
    assert.ok(commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass) >= 2309808);
    if (process.platform === 'win32') return;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_heavyClass"',
      'policy', artifact, repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, policy.heavyClass);
  });
  await t.test('public focused package aliases consume the selected payload floor', async () => {
    const policy = await commandPolicy.resolvePackageCommandPolicy(
      ['pnpm', '--dir', 'packages/channels-protocol', 'test', 'src/v1/text.test.ts'], { repoRoot, cwd: repoRoot });
    assert.equal(policy.heavyClass, 'focused-validation');
  });
});

test('source web export classification reserves its measured process-tree envelope in both dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  for (const [cwd, entry] of ['build_source_web_ui.mjs', 'build_web_artifact.mjs'].flatMap(name => [
    [root, `apps/stack/scripts/build/${name}`],
    [join(root, 'apps/stack'), `scripts/build/${name}`],
    [root, join(root, `apps/stack/scripts/build/${name}`)],
  ])) {
    const args = ['node', entry, '{}'];
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd });
    assert.equal(policy.validation, '1');
    assert.equal(policy.heavyClass, commandPolicy.SOURCE_WEB_EXPORT_ADMISSION_CLASS);
    assert.ok(policy.heavyClass, 'the finite export must have a declared envelope');
    const required = commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass);
    assert.ok(required > commandPolicy.resolveHeavyweightMemoryFloorKiB('validation'),
      'the export must not inherit the unrelated suite budget');
    // nl1 cold export at its admitted CPU allowance (47 transform threads),
    // sampled from the enclosing process independently of Metro's event loop.
    // Owner Q1: recorded peak rounded up, with no blanket margin. The
    // completed 2026-10-30 export (11,723,928 KiB live-tree HWM) fits below
    // the retained eight-thread peak; explicit 47-thread callers retain theirs.
    assert.equal(required, Math.ceil(32907788 / (1024 * 1024)) * 1024 * 1024);
    for (const [workers, peakKiB] of [[1, 8236000], [8, 12711296], [47, 32907788]]) {
      const roundedKiB = Math.ceil(peakKiB / (1024 * 1024)) * 1024 * 1024;
      assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass, { workers }), roundedKiB);
      if (process.platform !== 'win32') {
        const native = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_memory_floor_kib "$2" worker "$3"',
          'policy', artifact, policy.heavyClass, String(workers)], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(Number(native.stdout), roundedKiB);
      }
    }
    assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB('source-bundle'), 10 * 1024 * 1024,
      'runtime source bundles retain their independently measured envelope');
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_validation" "$policy_heavyClass"',
        'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, `1,${policy.heavyClass}`);
      const memory = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_memory_floor_kib "$2"',
        'policy', artifact, policy.heavyClass], { encoding: 'utf8' });
      assert.equal(memory.status, 0);
      assert.equal(Number(memory.stdout), required);
    }
  }
});

test('managed pnpm remains visible to remote commands without dependency bootstrap', {
  skip: process.platform === 'win32' ? 'Exercises the POSIX worker executable boundary' : false,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-managed-pnpm-path-' });
  const binDir = fixture.path('worker', 'cache', 'pnpm-toolchain', 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'pnpm'), '#!/bin/sh\nprintf "12.14.0\\n"\n', { mode: 0o755 });
  const target = { platform: 'posix', cliHomeDir: fixture.path('worker'), remotePath: [] };
  const result = spawnSync('/bin/sh', ['-c', commandPolicy.prependRemotePath(target, 'pnpm --version')], {
    encoding: 'utf8', env: { PATH: fixture.path('empty-path') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '12.14.0');
});

test('plugin source-resolving Vitest uses source preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['corepack', 'yarn', '-s', 'vitest', 'run', 'src/source.test.ts'];
  for (const tracker of ['linear', 'jira', 'sentry', 'posthog', 'claude']) {
    const cwd = join(root, `packages/plugins/${tracker}`);
    assert.equal(resolveRemoteCommandPolicy(args, { cwd }).kind, 'source-test');
    if (process.platform === 'win32') continue;
    const fixture = await createTempFixture(t, { prefix: `${tracker}-source-command-policy-` });
    const artifact = fixture.path('policy.sh');
    await writeFile(artifact, renderNativeCommandPolicy());
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test');
  }
});

test('verified plugin Vitest configs skip publication while dist configs retain preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'plugin-source-config-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  const requests = [
    ['onepassword', []],
    ['codex', []],
    ['codex', ['--config', 'vitest.mcpApproval.config.ts']],
    ['codex', ['--config=./vitest.mcpToolPolicy.config.ts']],
    ['claude', ['--config=vitest.mcpToolPolicy.config.ts']],
    ['kilo', ['--config=vitest.mcpToolPolicy.config.ts']],
    ['opencode', ['--config=vitest.mcpToolPolicy.config.ts']],
    ['pi', ['--config=vitest.mcpApproval.config.ts']],
  ];
  for (const [plugin, configArgs] of requests) {
    await t.test(`${plugin} ${configArgs.join(' ') || 'default'}`, async () => {
      const args = ['pnpm', '--dir', `packages/plugins/${plugin}`, 'exec', 'vitest', 'run', ...configArgs];
      const policy = resolveRemoteCommandPolicy(args, { cwd: root });
      assert.equal(policy.kind, 'source-test');
      assert.equal(policy.workspaceLock, '');
      const preparation = await prepareRemoteValidationWorkspace({
        repoDir: fixture.root, componentRelativeDir: policy.component, validationKind: policy.kind,
        requiredTools: policy.requiredTools,
      });
      assert.deepEqual(preparation.skipped, ['workspace-source-test']);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_workspaceLock"',
        'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'source-test,');
    });
  }
  const cwd = fixture.path('packages/plugins/codex');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'vitest.dist.config.ts'), "import { defineConfig } from 'vitest/config';\nimport '@happier-dev/protocol';\nexport default defineConfig({});\n");
  for (const override of ['--config=vitest.dist.config.ts', '--config=../claude/vitest.config.ts', '--root=../claude', '--workspace=custom.workspace.ts']) {
    const args = ['vitest', 'run', override];
    assert.equal(resolveRemoteCommandPolicy(args, { repoRoot: fixture.root, cwd }).kind, 'runtime', override);
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, fixture.root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime', override);
  }
});

test('focused test selections reserve compilation only for compiler files or compiler setup', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'focused-compiler-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [component, tail, expected] of [
    ['apps/ui', ["sources/components/settings/teams/credentials/TeamCredentialExternalApiScreen.test.tsx"], 'focused-validation-ui'],
    ['apps/cli', ['src/api/artifacts/accountArtifactStore.test.ts', '-t', 'x'], 'validation'],
    ['apps/ui', ['sources/utils/path/pathUtils.spec.ts'], 'focused-validation-ui'],
    ['apps/ui', ['sources/components/plain.test.tsx'], 'validation'],
    ['apps/cli', ['scripts/build.test.ts'], 'compilation'],
    ['apps/cli', ['src/api/artifacts/accountArtifactStore.test.ts', 'scripts/build.test.ts', '-t', 'x'], 'compilation'],
    ['apps/ui', ['sources/text/declarationEmission.test.ts'], 'compilation'],
    ['apps/ui', ['declarationEmission'], 'compilation'],
    ['apps/ui', ['declarationemission'], 'compilation'],
    ['apps/ui', [join(root, 'apps/ui/sources/text/declarationEmission.test.ts')], 'compilation'],
    ['apps/ui', ['../ui/sources/text/declarationEmission.test.ts'], 'compilation'],
    ['apps/ui', [root], 'compilation'],
    ['apps/ui', [root.split('/').filter(Boolean).at(-1)], 'validation'],
    ['apps/ui', ['sources/utils/path'], 'validation'],
    ['apps/ui', ['sources/utils/path/pathUtils.spec.ts', '-t', 'declarationEmission.test.ts'], 'focused-validation-ui'],
    ['apps/ui', ['-t', 'pathUtils.spec.ts'], 'compilation'],
    ['packages/plugin-sdk', ['--config', 'vitest.source.config.ts', 'src/plain.test.ts'], 'validation'],
    ['packages/plugin-sdk', ['src/plain.test.ts'], 'validation'],
    ['packages/plugin-sdk', ['--config', 'vitest.source.config.ts', 'src/definePlugin.externalFixture.test.ts'], 'compilation'],
    ['packages/plugin-sdk', ['src/publicDeclarations.externalFixture.test.ts'], 'compilation'],
    ['packages/protocol', ['src/plain.test.ts'], 'validation'],
    ['packages/protocol', ['--config', '../../vitest.config.ts', 'src/plain.test.ts'], 'validation'],
    ['packages/cli-common', ['src/plain.test.ts'], 'validation'],
    ['packages/channels-protocol', ['src/plain.test.ts'], 'validation'],
    ['packages/triage-protocol', ['src/plain.test.ts'], 'compilation'],
    ['apps/cli', ['--config', 'vitest.integration.config.ts', 'src/plain.integration.test.ts'], 'compilation'],
    ['apps/cli', ['--config', 'vitest.inMemory.config.ts', 'src/plain.test.ts'], 'validation'],
  ]) await t.test(`${component} ${tail.join(' ')}`, async () => {
    const args = ['pnpm', '--dir', component, 'exec', 'vitest', 'run', ...tail];
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.heavyClass, expected);
    if (process.platform === 'win32') return;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_heavyClass"',
      'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, expected);
  });
});

test('compiler-consuming suites reserve their nested compiler envelope in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'compiler-suite-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const compiler = resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', '/external/tsconfig.json'], { repoRoot: root, cwd: root });
  const suites = [
    ['packages/plugin-sdk', 'vitest.config.ts', 'src/definePlugin.externalFixture.test.ts'],
    ['packages/plugin-sdk', 'vitest.source.config.ts', 'src/definePlugin.externalFixture.test.ts'],
    ['packages/plugin-sdk', 'vitest.external-fixture.config.ts', 'src/definePlugin.externalFixture.test.ts'],
    ['packages/plugin-sdk', 'vitest.declaration-closure.config.ts', 'src/declarationClosureIdentity.test.ts'],
    ['packages/plugin-sdk', 'vitest.facade-current.config.ts', 'src/definePlugin.externalFixture.test.ts'],
    ['packages/protocol', 'vitest.config.ts', 'src/voice/realtime/agentSession.test.ts'],
    ['packages/protocol', '../../vitest.config.ts', 'src/voice/realtime/agentSession.test.ts'],
    ['packages/channels-protocol', 'vitest.config.ts', 'src/sdkSchemaClosure.test.ts'],
    ['packages/triage-protocol', 'vitest.config.ts', 'src/sdkSchemaClosure.test.ts'],
    ['packages/cli-common', 'vitest.config.ts', 'src/componentArtifacts/finalizeRuntimeArtifactPayload.test.ts'],
    ['apps/ui', 'vitest.config.ts', 'sources/text/declarationEmission.test.ts'],
    ['apps/cli', 'vitest.config.ts', 'scripts/build.test.ts'],
    ['apps/cli', 'vitest.integration.config.ts', 'src/plain.integration.test.ts'],
    ['apps/cli', 'vitest.source.integration.config.ts', 'src/plugins/scaffold/scaffold.integration.test.ts'],
    ['apps/cli', 'vitest.inMemory.config.ts', 'scripts/build.test.ts'],
  ];
  for (const [component, config, compilerFile] of suites) {
    await t.test(`${component} ${config}`, () => {
      const cwd = join(root, component);
      const args = ['vitest', 'run', '--config', config, compilerFile];
      const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd });
      assert.equal(resolveRemoteCommandPolicy(['vitest', 'run', '--config', config], { repoRoot: root, cwd }).heavyClass, 'compilation', 'whole compiler-containing suites retain their floor');
      assert.ok(commandPolicy.resolveHeavyweightMemoryFloorKiB(policy.heavyClass)
        >= commandPolicy.resolveHeavyweightMemoryFloorKiB(compiler.heavyClass), 'the payload must cover its nested compiler, not only placement');
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_heavyClass"',
        'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, policy.heavyClass);
    });
  }
  const replay = await commandPolicy.resolvePackageCommandPolicy(['pnpm', '--filter', '@happier-dev/plugin-sdk', 'run', 'test:source',
    'src/definePlugin.externalFixture.test.ts', 'src/examples/publicAuthoringExamples.test.ts'], { repoRoot: root, cwd: root });
  assert.equal(replay.heavyClass, compiler.heavyClass, 'the unchanged public SDK command inherits the compiler floor');
  assert.equal(replay.placementHeavyClass || replay.heavyClass, compiler.heavyClass);
  for (const [component, config] of [
    ['.', 'vitest.config.ts'],
    ['packages/plugins/claude', 'vitest.config.ts'],
    ['packages/triage-protocol', 'vitest.source.config.ts'],
    ['apps/ui', 'vitest.legend-native.config.ts'],
    ['packages/plugin-ui', 'vitest.config.ts'],
  ]) {
    const policy = resolveRemoteCommandPolicy(['vitest', 'run', '--config', config], { repoRoot: root, cwd: join(root, component) });
    assert.equal(policy.heavyClass, 'validation', `${component} ${config} remains plain validation`);
  }
});

test('SDK declaration-wrapped test aliases retain their prepared Vitest compiler envelope', async t => {
  const fixture = await createTempFixture(t, { prefix: 'sdk-prepared-suite-policy-' });
  const root = fixture.root;
  const cwd = fixture.path('packages/plugin-sdk');
  await mkdir(cwd, { recursive: true });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  // SDKVENDOR's scripts-only contract; no shared dependency input is changed.
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk', scripts: {
    'test:source': 'node ./scripts/bundleWorkspaceDeps.mjs --declarations --run-script=test:source:prepared',
    'test:source:prepared': 'vitest run --config vitest.source.config.ts',
  } }));
  for (const [args, invokedCwd] of [
    [['pnpm', '--filter', '@happier-dev/plugin-sdk', 'run', 'test:source', 'src/definePlugin.externalFixture.test.ts', 'src/examples/publicAuthoringExamples.test.ts'], root],
    [['pnpm', 'run', 'test:source:prepared'], cwd],
    [['node', './scripts/bundleWorkspaceDeps.mjs', '--declarations', '--run-script=test:source:prepared'], cwd],
  ]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: invokedCwd });
    assert.equal(policy.heavyClass, 'compilation', args.join(' '));
    assert.equal(policy.placementHeavyClass || policy.heavyClass, 'compilation');
  }
});

test('compiler-consuming suites include native compiler owner and SDK scripts without charging plain native tests', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'native-compiler-suite-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [path, expected] of [
    ['scripts/workspaces/firstPartyDeclarationIdentity.test.mjs', 'compilation'],
    ['scripts/workspaces/buildTypeScriptPackageDist.test.mjs', 'compilation'],
    ['scripts/workspaces/typecheckTouched.test.mjs', 'compilation'],
    ['apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs', 'compilation'],
    ['scripts/codemods/zod-mini/index.test.mjs', 'compilation'],
    ['packages/plugin-sdk/scripts/publicDeclarationReport.test.mjs', 'compilation'],
    ['packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs', 'compilation'],
    ['packages/sdk/scripts/generateActions.test.mjs', 'compilation'],
    ['scripts/workspaces/turboFiniteTaskGraph.test.mjs', 'validation'],
    ['apps/ui/scripts/tauri_package_scripts.test.mjs', 'validation'],
    [['scripts/workspaces/firstPartyDeclarationIdentity.test.mjs', 'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs'], 'compilation'],
    [['packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs', 'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs'], 'compilation'],
    ['apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs', 'validation'],
  ]) {
    const args = ['node', '--test', ...[path].flat()];
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.heavyClass, expected, String(path));
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_heavyClass"',
      'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, expected, String(path));
  }
  const tooling = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'test:tooling:self'], { repoRoot: root, cwd: root });
  assert.equal(tooling.heavyClass, 'compilation', 'the mixed tooling suite includes real compiler owner tests');
  const wrapped = ['hstack-exec', '--heavyweight-admission', '--class=validation', '--', 'pnpm', 'run', 'test:tooling:self'];
  assert.equal(resolveRemoteCommandPolicy(wrapped, { repoRoot: root, cwd: root }).heavyClass, 'validation');
  if (process.platform !== 'win32') {
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_heavyClass" "$policy_localCompile"',
      'policy', artifact, root, ...wrapped], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'validation,0', 'explicit admission remains authoritative for mixed tooling');
  }
});

test('verified Plugin SDK Vitest configs skip publication while emitted configs retain preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(root, 'packages/plugin-sdk');
  const fixture = await createTempFixture(t, { prefix: 'sdk-source-config-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  const requests = [
    { cwd, args: ['pnpm', 'exec', 'vitest', 'run'] },
    { cwd: root, args: ['pnpm', '--dir', 'packages/plugin-sdk', 'exec', 'vitest', 'run', '--config', 'vitest.source.config.ts'] },
    { cwd, args: ['vitest', 'run', '--config=./vitest.source.config.ts'] },
  ];
  for (const request of requests) {
    await t.test(request.args.join(' '), async () => {
      const policy = resolveRemoteCommandPolicy(request.args, { cwd: request.cwd });
      assert.equal(policy.kind, 'source-test');
      assert.equal(policy.workspaceLock, '');
      const preparation = await prepareRemoteValidationWorkspace({
        repoDir: fixture.root, componentRelativeDir: policy.component,
        validationKind: policy.kind, requiredTools: policy.requiredTools,
      });
      assert.deepEqual(preparation.skipped, ['workspace-source-test']);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_workspaceLock"',
        'policy', artifact, root, request.cwd, ...request.args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'source-test,');
    });
  }
  for (const config of ['vitest.declaration-closure.config.ts', 'vitest.external-fixture.config.ts', 'vitest.facade-current.config.ts']) {
    const args = ['vitest', 'run', `--config=${config}`];
    assert.equal(resolveRemoteCommandPolicy(args, { cwd }).kind, 'runtime', config);
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime', config);
  }
});

test('verified UI Vitest configs skip emitted preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(root, 'apps/ui');
  const fixture = await createTempFixture(t, { prefix: 'ui-source-config-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  const configs = [
    'vitest.gesture-web.config.ts', 'vitest.integration.config.ts',
    'vitest.legend-native.config.ts', 'vitest.legend-fabric.config.ts',
    'vitest.perf-newchat-baseline.config.ts', 'vitest.r9-tail.config.ts',
  ];
  for (const dispatcher of ['javascript', 'native']) {
    if (dispatcher !== 'javascript' && process.platform === 'win32') continue;
    for (const config of configs) {
      await t.test(`${dispatcher}: ${config}`, async () => {
        const payload = ['pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', '--config', config];
        if (dispatcher === 'javascript') {
          const policy = resolveRemoteCommandPolicy(payload, { cwd: root });
          assert.equal(policy.kind, 'source-test');
          const prepared = await prepareRemoteValidationWorkspace({
            repoDir: fixture.root, componentRelativeDir: policy.component, validationKind: policy.kind,
            requiredTools: policy.requiredTools,
          });
          assert.deepEqual(prepared.skipped, ['workspace-source-test']);
        } else {
          const args = ['vitest', 'run', `--config=./${config}`];
          const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
            'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
          assert.equal(native.status, 0, native.stderr);
          assert.equal(native.stdout, 'source-test');
        }
      });
    }
  }
  // Partial resolvers and overrides must retain emitted preparation; a config
  // name or inherited source resolver alone cannot establish this contract.
  for (const args of [
    ['--config=vitest.artifact-cache.config.ts'],
    ['--config=vitest.unknown.config.ts'],
    ['--config=../cli/vitest.gesture-web.config.ts'],
    ['--config=vitest.gesture-web.config.ts', '--root=../cli'],
    ['--config=vitest.gesture-web.config.ts', '--workspace=custom.workspace.ts'],
    ['--config=vitest.gesture-web.config.ts', '--project=artifact'],
  ]) {
    const payload = ['vitest', 'run', ...args];
    assert.equal(resolveRemoteCommandPolicy(payload, { cwd }).kind, 'runtime');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/ui; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, ...payload], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime');
  }
});

test('server Vitest configs use source preparation without CLI publication custody in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(root, 'apps/server');
  const configs = readdirSync(cwd).filter(name => /^vitest(?:\.[^.]+)*\.config\.ts$/u.test(name));
  assert.ok(configs.includes('vitest.dbcontract.config.ts'));
  const fixture = await createTempFixture(t, { prefix: 'server-source-config-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  const lockPath = fixture.path('.project/tmp/cli-dist-build.lock');
  await withWorkspaceBundleLock(async () => {
    for (const config of configs) {
      for (const configArgs of [['--config', config], [`--config=./${config}`]]) {
        const args = ['vitest', 'run', ...configArgs];
        const policy = resolveRemoteCommandPolicy(args, { cwd });
        assert.equal(policy.kind, 'source-test', config);
        assert.equal(policy.workspaceLock, '', config);
        const preparation = await prepareRemoteValidationWorkspace({
          repoDir: fixture.root, componentRelativeDir: policy.component, validationKind: policy.kind,
          requiredTools: policy.requiredTools,
        });
        assert.deepEqual(preparation.skipped, ['workspace-source-test']);
        if (process.platform === 'win32') continue;
        const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/server; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_workspaceLock"',
          'policy', artifact, root, ...args], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout, 'source-test,', config);
      }
    }
  }, { lockPath });
  for (const override of ['--config=unknown.config.ts', '--config=../cli/vitest.config.ts', '--config=vitest.dbcontract.config.ts --root=../cli']) {
    const args = ['vitest', 'run', ...override.split(' ')];
    assert.equal(resolveRemoteCommandPolicy(args, { cwd }).kind, 'runtime', override);
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/server; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime', override);
  }
});

test('Node source-test loaders do not count as requested test files in either dispatcher', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const fixture = await createTempFixture(t, { prefix: 'node-source-loader-command-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const file = 'apps/stack/scripts/preferred_execution_launcher.test.mjs';
  for (const loader of [
    ['--import=./packages/cli-common/registerSourceRuntime.mjs'],
    ['--import', './packages/cli-common/registerSourceRuntime.mjs'],
  ]) {
    for (const files of [[file], [file, 'apps/stack/scripts/utils/dev_targets/remote_validation_preparation.test.mjs']]) {
      const args = ['node', '--conditions=happier-source', ...loader, '--test', ...files];
      const expected = files.length === 1 ? 'source-test' : 'runtime';
      assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).kind, expected);
      if (process.platform !== 'win32') {
        const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
          'policy', artifact, root, ...args], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout, expected);
      }
    }
  }
});

test('finite compiler projections retain their package envelope in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const fixture = await createTempFixture(t, { prefix: 'finite-compiler-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [projects, component, heavyClass] of [
    [['apps/ui/node_modules/.cache/tsc/tsconfig.source.json'], 'apps/ui', 'compilation-ui'],
    [['apps/cli/tsconfig.source.json', 'apps/cli/node_modules/.cache/tsc/tsconfig.test.json'], 'apps/cli', 'compilation-cli'],
    [['apps/cli/tsconfig.source.json', 'apps/ui/node_modules/.cache/tsc/tsconfig.source.json'], 'apps/ui', 'compilation'],
    [['packages/plugin-sdk/node_modules/.cache/tsc/tsconfig.tests.json'], 'packages/plugin-sdk', 'package-dist'],
  ]) {
    const args = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', ...projects.flatMap(project => ['--project', project])];
    const policy = resolveRemoteCommandPolicy(args, { cwd: root });
    assert.equal(policy.component, component);
    assert.equal(policy.heavyClass, heavyClass);
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_component" "$policy_heavyClass"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, `${component},${heavyClass}`);
    }
  }
});


test('source reload preparation delegates admission to finite producers in both command dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', './apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs', '--worker', '{}'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: root });
  assert.equal(policy.kind, 'runtime', 'reload worker static imports consume emitted workspace packages');
  assert.equal(policy.heavyClass, 'source-bundle');
  assert.equal(policy.selfPublisher, '1', 'reload coordination must not charge capacity while its finite producer waits for a lease');
  if (process.platform !== 'win32') {
    const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_kind" "$policy_heavyClass" "$policy_selfPublisher"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime,source-bundle,1');
  }
  const target = { name: 'worker', platform: 'linux', repoDir: root, cliHomeDir: '/tmp/reload-worker-home' };
  const dispatched = buildRemoteExecCommand(target, { commandArgs: args, admissionClass: 'source-bundle', executionId });
  assert.doesNotMatch(dispatched, /--heavyweight-admission/, 'the real remote transport must leave admission to the finite producer');
  const lookalike = ['node', './fixture/apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs', '--worker', '{}'];
  assert.equal(resolveRemoteCommandPolicy(lookalike, { cwd: root }).selfPublisher, '0');
});

test('authored source reload preparation never builds or reads workspace dist prerequisites', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', '--conditions=happier-source', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    './apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs', '--worker', '{}'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: root });
  assert.equal(policy.kind, 'source-test');
  assert.equal(policy.selfPublisher, '1');
  if (process.platform !== 'win32') {
    const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_selfPublisher"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test,1');
  }
});

test('Docs content coordination delegates admission to its finite reference producers', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', './apps/docs/scripts/checkContent.mjs'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: root });
  assert.equal(policy.selfPublisher, '1', 'reference preparation must wait for foreign leases before reserving compiler capacity');
  const publicPolicy = await commandPolicy.resolveCommandPublisherPolicy(
    ['corepack', 'yarn', '--cwd', 'apps/docs', '-s', 'check:content'], { repoRoot: root, cwd: root },
  );
  assert.equal(publicPolicy.selfPublisher, '1', 'the real public manifest must reach the same producer-owned admission');
  assert.equal(publicPolicy.heavyClass, 'runtime-build', 'placement must fit the existing Protocol reference producer envelope');
  const target = { name: 'worker', platform: 'linux', repoDir: root, cliHomeDir: '/tmp/docs-content-worker-home' };
  const dispatched = buildRemoteExecCommand(target, { commandArgs: args, admissionClass: 'runtime-build', executionId });
  assert.doesNotMatch(dispatched, /--heavyweight-admission/);
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_selfPublisher"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, '1');
  assert.equal(resolveRemoteCommandPolicy(['node', './fixture/apps/docs/scripts/checkContent.mjs'], { cwd: root }).selfPublisher, '0');
});

test('the disposable database contract harness requires Docker in AUTO placement', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', './packages/tests/scripts/run-extended-db-docker.mjs', '--db', 'postgres', '--mode', 'contract'];
  assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).requiredTools, 'docker');
  const publicPolicy = await commandPolicy.resolveCommandPublisherPolicy(
    ['yarn', 'test:db-contract:postgres:docker'], { repoRoot: root, cwd: root },
  );
  assert.equal(publicPolicy.requiredTools, 'docker');
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@"; printf '%s' "$policy_requiredTools"`,
    'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'docker');
  assert.equal(resolveRemoteCommandPolicy(['node', './fixture/packages/tests/scripts/run-extended-db-docker.mjs'], { cwd: root }).requiredTools, '');
});

test('wrapper payload requirements reach placement through executor and shell expansion', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const entry = 'packages/tests/scripts/run-extended-db-docker.mjs';
  const launcher = 'apps/stack/bin/hstack-exec';
  for (const args of [
    [launcher, '--heavyweight-admission', '--class=validation', '--', 'node', entry],
    [launcher, '--', launcher, '--heavyweight-admission', '--class=validation', '--', 'node', entry],
    [launcher, '--', 'pnpm', 'run', 'test:db-contract:postgres:docker'],
    [launcher, '--script=test:db-contract:postgres:docker'],
    [launcher, '--cwd=.', '--', 'pnpm', 'run', 'test:db-contract:postgres:docker'],
    ['pnpm', 'run', 'test:db-contract:postgres:docker'],
    ['sh', '-c', `node ${entry} && node ${entry}`],
    [launcher, '--heavyweight-admission', '--class=validation', '--', 'sh', '-c', `pnpm run test:db-contract:postgres:docker`],
  ]) {
    await t.test(args.join(' '), async () => {
      const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
      assert.equal(policy.requiredTools, 'docker');
      const metadata = spawnSync(process.execPath, [fileURLToPath(new URL('./remote_commands.mjs', import.meta.url)),
        '--package-policy', root, root, ...args], { encoding: 'utf8' });
      assert.equal(metadata.status, 0, metadata.stderr);
      const native = spawnSync('/bin/sh', ['-c', 'eval "$PACKAGE_POLICY"; printf "%s" "$policy_requiredTools"'], {
        encoding: 'utf8', env: { ...process.env, PACKAGE_POLICY: metadata.stdout },
      });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'docker');
    });
  }
  const phases = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c',
    `node apps/stack/scripts/test_ci.mjs && node ${entry}`], { repoRoot: root, cwd: root });
  assert.equal(phases.requiredTools, 'bun docker', 'sequential phases retain the stable tool union');
});

test('native launcher rejects unknown leading options before configuration, probes or dispatch', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-leading-option-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const unexpectedCalls = fixture.path('unexpected-calls');
  for (const name of ['node', 'ssh']) {
    writeFakeBin({ root: fixture.root, name, content: '#!/bin/sh\nprintf invoked >> "$UNEXPECTED_CALLS"\nexit 97\n' });
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:${process.env.PATH}`,
    HOME: fixture.root, HAPPIER_EXEC_CONFIG_PATH: fixture.path('unread-config.json'),
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_EXECUTION: '', HAPPIER_HSTACK_DISPATCH_CONTROL: '',
    UNEXPECTED_CALLS: unexpectedCalls };
  for (const prefix of [[], ['--target=nl3'], ['--cwd=.'], ['--local'], ['--local', '--allow-local-compilation']]) {
    for (const option of ['--required-tools=docker', '--unknown-executor-option']) {
      await t.test([...prefix, option].join(' '), () => {
        const result = spawnSync('/bin/sh', [launcher, ...prefix, option, '--', 'true'], {
          cwd: dirname(dirname(dirname(dirname(launcher)))), env, encoding: 'utf8',
        });
        assert.equal(result.status, 64, result.stderr);
        assert.ok(result.stderr.includes(option), 'usage error names the unknown option');
        assert.equal(existsSync(unexpectedCalls), false, 'no configuration, probe or dispatch process ran');
      });
    }
  }
  for (const prefix of [['--local', '--'], ['--local'], ['--']]) {
    const payload = spawnSync('/bin/sh', [launcher, ...prefix, 'printf', '%s', '--required-tools=docker'], {
      env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' }, encoding: 'utf8',
    });
    assert.equal(payload.status, 0, payload.stderr);
    assert.equal(payload.stdout, '--required-tools=docker');
  }
});

test('opaque wrapper requirements use an explicit declaration while retaining outer admission', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const launcher = 'apps/stack/bin/hstack-exec';
  const payload = ['node', '.project/lane/run.mjs'];
  const outer = [launcher, '--heavyweight-admission', '--class=validation'];
  for (const args of [[...outer, '--', ...payload], [launcher, '--', ...outer, '--', ...payload]]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.heavyClass, 'validation');
    assert.equal(policy.selfPublisher, '0');
    assert.equal(policy.requiredTools, '', 'the wrapper source is opaque and must not be guessed');
  }
  const args = [...outer, '--required-tools=docker,go,docker', '--', ...payload];
  const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
  assert.equal(policy.heavyClass, 'validation');
  assert.equal(policy.selfPublisher, '0');
  assert.equal(policy.requiredTools, 'docker go');
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@" || exit $?; printf '%s|%s' "$policy_heavyClass" "$policy_requiredTools"`,
    'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'validation|docker go');
  const nested = [launcher, '--', ...outer, '--required-tools=docker', '--', ...payload];
  assert.equal((await commandPolicy.resolvePackageCommandPolicy(nested, { repoRoot: root, cwd: root })).requiredTools, 'docker');
  const nestedNative = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@" || exit $?; printf '%s' "$policy_requiredTools"`,
    'policy', root, ...nested], { encoding: 'utf8' });
  assert.equal(nestedNative.status, 0, nestedNative.stderr);
  assert.equal(nestedNative.stdout, 'docker');
  const launcherPath = join(root, launcher);
  const missing = spawnSync(launcherPath, [...outer.slice(1), '--required-tools=hstack-wreq-unavailable', '--',
    process.execPath, '-e', 'process.exit(99)'], { encoding: 'utf8' });
  assert.equal(missing.status, 64, missing.stderr);
  assert.match(missing.stderr, /HSTACK_COMMAND_REQUIREMENTS_MISSING/u);
  const invalid = spawnSync(launcherPath, [...outer.slice(1), '--required-tools=docker/invalid', '--',
    process.execPath, '-e', 'process.exit(99)'], { encoding: 'utf8' });
  assert.equal(invalid.status, 64, invalid.stderr);
  assert.match(invalid.stderr, /HSTACK_COMMAND_REQUIREMENTS_INVALID/u);
  await assert.rejects(commandPolicy.resolvePackageCommandPolicy(
    [...outer, '--required-tools=docker/invalid', '--', ...payload], { repoRoot: root, cwd: root }),
    { code: 'HSTACK_COMMAND_REQUIREMENTS_INVALID' });
});

test('executor tool requirements preserve argument governors at the executable leaf', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=validation', '--', 'rg', '--files'];
  const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
  assert.equal(policy.requiredTools, 'rg');
  assert.equal(policy.workerTool, '', 'rg argv flags cannot be injected into an executor wrapper');
  assert.equal(resolveRemoteCommandPolicy(['rg', '--files'], { repoRoot: root, cwd: root }).workerTool, 'rg');
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@" || exit $?; printf '%s|%s' "$policy_requiredTools" "$policy_workerTool"`,
    'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'rg|');
  const windows = resolveRemoteCommandPolicy(['apps\\stack\\bin\\hstack-exec', '--cwd=.', '--',
    'node', 'packages\\tests\\scripts\\run-extended-db-docker.mjs'], { repoRoot: 'C:\\repo', cwd: '.' });
  assert.equal(windows.requiredTools, 'docker');
});

test('executor and shell expansion retain the canonical manifest cycle guard', async t => {
  const { root } = await createTempFixture(t, { prefix: 'executor-script-cycle-' });
  const launcher = 'apps/stack/bin/hstack-exec';
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    loop: `${launcher} -- pnpm run loop`,
    shellLoop: `${launcher} -- sh -c 'pnpm run shellLoop'`,
    check: `node packages/tests/scripts/run-extended-db-docker.mjs && ${launcher} -- pnpm run loop`,
  } }));
  for (const script of ['loop', 'shellLoop', 'check']) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', script], { repoRoot: root, cwd: root });
    assert.equal(policy.selfPublisher, '0');
    assert.equal(policy.requiredTools, script === 'check' ? 'docker' : '');
  }
});

test('manifest executor cwd resolves only the selected package tool requirements', async t => {
  const { root } = await createTempFixture(t, { prefix: 'executor-package-cwd-' });
  await mkdir(join(root, 'packages/leaf'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    check: 'apps/stack/bin/hstack-exec --cwd=packages/leaf -- pnpm run work',
    work: 'node apps/stack/scripts/test_ci.mjs',
  } }));
  await writeFile(join(root, 'packages/leaf/package.json'), JSON.stringify({ scripts: {
    work: 'node ../../packages/tests/scripts/run-extended-db-docker.mjs',
  } }));
  const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'check'], { repoRoot: root, cwd: root });
  assert.equal(policy.requiredTools, 'docker', 'a same-named script in the caller is not another tool authority');
});

test('real Mutagen integration requires its executable in AUTO placement', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', '--test', 'apps/stack/scripts/dev_target_control.real.integration.test.mjs'];
  assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).requiredTools, 'mutagen');
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_requiredTools"',
    'policy', artifact, root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'mutagen');
  assert.equal(resolveRemoteCommandPolicy(['node', '--test', 'apps/stack/scripts/dev_target_control.test.mjs'], { cwd: root }).requiredTools, '');
});

test('Stack public test coordination requires Bun and leaves admission to preparation and the finite test runner', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const args = ['node', './apps/stack/scripts/test_ci.mjs'];
  assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).selfPublisher, '1');
  assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).requiredTools, 'bun');
  assert.equal(resolveRemoteCommandPolicy(['node', './scripts/test_ci.mjs'], { cwd: join(root, 'apps/stack') }).requiredTools, 'bun');
  for (const entry of ['test_ci.mjs', 'test_integration.mjs']) {
    const coordinator = ['node', `./apps/stack/scripts/${entry}`];
    const policy = resolveRemoteCommandPolicy(coordinator, { cwd: root });
    assert.equal(policy.selfPublisher, '1', entry);
    assert.equal(policy.requiredTools, 'bun', entry);
    assert.equal(policy.heavyClass, 'source-bundle', entry);
    const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s:%s:%s" "$policy_selfPublisher" "$policy_requiredTools" "$policy_heavyClass"',
      'policy', artifact, root, ...coordinator], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, '1:bun:source-bundle', entry);
  }
  const publicPolicy = await commandPolicy.resolveCommandPublisherPolicy(
    ['corepack', 'yarn', '--cwd', 'apps/stack', '-s', 'test'], { repoRoot: root, cwd: root },
  );
  assert.equal(publicPolicy.selfPublisher, '1');
  assert.equal(publicPolicy.requiredTools, 'bun');
  const target = { name: 'worker', platform: 'linux', repoDir: root, cliHomeDir: '/tmp/stack-tests-worker-home' };
  assert.doesNotMatch(buildRemoteExecCommand(target, { commandArgs: args, admissionClass: 'validation', executionId }), /--heavyweight-admission/);
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s:%s" "$policy_selfPublisher" "$policy_requiredTools"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, '1:bun');
  const lookalike = resolveRemoteCommandPolicy(['node', './fixture/apps/stack/scripts/test_ci.mjs'], { cwd: root });
  assert.equal(lookalike.selfPublisher, '0');
  assert.equal(lookalike.requiredTools, '');
});

test('placed script dispatch preserves publisher admission with inherited pnpm executables', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-script-publisher-' });
  const { launcher } = await installNativeAdmissionFixture({ root });
  const packageDir = join(root, 'native-owner', 'apps', 'stack');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ scripts: {
    'test:unit:local': 'node ./scripts/test_ci.mjs',
    'test:ordinary:local': 'node ./scripts/ordinary.mjs',
  } }));
  // Pnpm is the process boundary. The real launcher and manifest policy must
  // recognize the coordinator before selecting its inherited executable.
  const manager = join(root, 'pnpm.cjs');
  await writeFile(manager, 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;\n');
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "1048576 1048576\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, CI: '',
    npm_node_execpath: process.execPath, npm_execpath: manager,
    HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_HSTACK_EXECUTION: '', HAPPIER_HSTACK_DISPATCH_CONTROL: '',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  const invoke = script => spawnSync('/bin/sh', [launcher, `--script=${script}`, '--', 'literal argument'], {
    cwd: packageDir, env, encoding: 'utf8', timeout: 15_000,
  });
  const publisher = invoke('test:unit:local');
  assert.equal(publisher.status, 23, publisher.stderr);
  assert.deepEqual(JSON.parse(publisher.stdout), ['run', '--silent', 'test:unit:local', 'literal argument']);
  const ordinary = invoke('test:ordinary:local');
  assert.equal(ordinary.status, 75, ordinary.stderr);
  assert.equal(ordinary.stdout, '');
  assert.match(ordinary.stderr, /HSTACK_MEMORY_CAPACITY/);
});

test('native test preparation follows reachable source imports rather than the package runtime closure', async t => {
  if (process.platform === 'linux') t.after(() => {
    const peaks = [process.pid, process.ppid].map(pid =>
      Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0));
    t.diagnostic(`Native runner + test process peak RSS sum: ${peaks.reduce((sum, peak) => sum + peak, 0)} KiB`);
  });
  const fixture = await createTempFixture(t, { prefix: 'hstack-native-consumption-' });
  const repoRoot = fixture.root;
  await mkdir(fixture.path('apps/stack/scripts'), { recursive: true });
  await writeFile(fixture.path('apps/stack/package.json'), JSON.stringify({
    name: '@fixture/stack', dependencies: { '@happier-dev/protocol': '0.0.0' },
  }));
  const entry = fixture.path('apps/stack/scripts/owner.test.mjs');
  const leaf = fixture.path('apps/stack/scripts/leaf.mjs');
  await writeFile(entry, 'import test from "node:test"; import "./leaf.mjs"; test("owner", () => {});');
  const args = ['node', '--test', entry];
  const env = { ...process.env, NODE_OPTIONS: '' };
  const classify = () => resolveRemoteCommandPolicy(args, { repoRoot, cwd: repoRoot, env });
  await writeFile(leaf, '// import "@happier-dev/protocol";\nexport const value = "import \\\"@happier-dev/protocol\\\"";');
  assert.equal(classify().kind, 'source-test');
  assert.equal(classify().bootstrap, '0', 'built-ins and source files do not consume the dependency installation');
  assert.equal(classify().heavyClass, 'native-source-test');
  if (process.platform !== 'win32') {
    const artifact = fixture.path('policy.sh');
    await writeFile(artifact, renderNativeCommandPolicy());
    const owner = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; projection_command_policy=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_kind" "$policy_bootstrap" "$policy_heavyClass"', 'policy', artifact, repoRoot, owner, ...args], { encoding: 'utf8', env });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test,0,native-source-test');
  }
  assert.equal(resolveRemoteCommandPolicy(['node', '--import', 'tsx', '--test', entry], { repoRoot, cwd: repoRoot }).kind, 'runtime');
  assert.equal(resolveRemoteCommandPolicy(args, { repoRoot, cwd: repoRoot, env: { NODE_OPTIONS: '--require=fixture-loader' } }).kind, 'runtime');
  await writeFile(leaf, 'export { value } from "@happier-dev/protocol";');
  assert.equal(classify().kind, 'runtime', 'a real emitted import still prepares its owning closure');
  await writeFile(leaf, 'await import ("@happier-dev/protocol");');
  assert.equal(classify().kind, 'runtime', 'literal dynamic imports with trivia still consume emitted packages');
  await writeFile(leaf, `globalThis.eval('import("@happier-dev/protocol")');`);
  assert.equal(classify().kind, 'runtime', 'global eval remains an opaque Node module loader');
  await writeFile(leaf, 'import { createRequire } from "node:module"; export const load = createRequire(import.meta.url);');
  assert.equal(classify().kind, 'runtime', 'unobserved module loading cannot certify source-only consumption');
  await writeFile(leaf, 'import "./missing.mjs";');
  assert.equal(classify().kind, 'runtime', 'an incomplete source graph cannot suppress prerequisites');
});

test('native UI test installed dependencies do not demand unrelated workspace dist preparation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'native-installed-consumption-' });
  const repoRoot = fixture.root;
  const cwd = fixture.path('apps/ui');
  await mkdir(join(cwd, 'scripts'), { recursive: true });
  await mkdir(join(cwd, 'node_modules/dom-fixture'), { recursive: true });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: '@fixture/ui', dependencies: { 'dom-fixture': '1.0.0', '@happier-dev/protocol': 'workspace:*' } }));
  await writeFile(join(cwd, 'node_modules/dom-fixture/package.json'), JSON.stringify({ name: 'dom-fixture', main: 'index.js' }));
  await writeFile(join(cwd, 'node_modules/dom-fixture/index.js'), 'module.exports = {};');
  const entry = join(cwd, 'scripts/probe.test.mjs');
  await writeFile(entry, 'import test from "node:test"; import dom from "dom-fixture"; test("probe", () => {});');
  const args = ['node', '--test', 'scripts/probe.test.mjs'];
  const env = { ...process.env, NODE_OPTIONS: '' };
  const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot, cwd, env });
  assert.equal(policy.kind, 'source-test', 'installed external modules do not consume workspace dist');
  assert.equal(policy.bootstrap, '1', 'installed dependencies retain the dependency-owner boundary');
  assert.equal(policy.heavyClass, 'validation', 'a non-compiling native selection retains validation');
  assert.ok(!policy.placementHeavyClass || policy.placementHeavyClass === 'validation');
  assert.ok(!commandPolicy.resolveCommandWorkspaceLocks(policy, repoRoot, env).some(lock => lock.path.includes('cli-dist-build.lock')));
  const lockPath = join(repoRoot, '.project/tmp/cli-dist-build.lock');
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  await withWorkspaceBundleLock(async () => {
    assert.equal(await isWorkspaceBundleLockActive(lockPath), true);
    const prepared = await prepareRemoteValidationWorkspace({ repoDir: repoRoot, componentRelativeDir: 'apps/ui', validationKind: policy.kind, env });
    assert.deepEqual(prepared.built, []);
    assert.deepEqual(prepared.skipped, ['workspace-source-test']);
  }, { lockPath });
  if (process.platform !== 'win32') {
    const artifact = fixture.path('policy.sh');
    await writeFile(artifact, renderNativeCommandPolicy());
    const owner = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; projection_command_policy=$4; shift 4; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_kind" "$policy_bootstrap" "$policy_heavyClass"', 'policy', artifact, repoRoot, cwd, owner, ...args], { encoding: 'utf8', env });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test,1,validation');
  }
  const installedWorkspace = join(cwd, "node_modules/@happier-dev/protocol");
  await mkdir(installedWorkspace, { recursive: true });
  await writeFile(join(installedWorkspace, "package.json"), JSON.stringify({ name: "@happier-dev/protocol", main: "index.js" }));
  await writeFile(join(installedWorkspace, "index.js"), "module.exports = {};");
  await writeFile(entry, 'import "@happier-dev/protocol";');
  assert.equal(resolveRemoteCommandPolicy(args, { repoRoot, cwd, env }).kind, 'runtime', 'copied workspace dist consumers retain preparation even without a workspace symlink');
});

test('the real UI hit area native probe has no workspace dist demand', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const policy = await commandPolicy.resolvePackageCommandPolicy(['node', '--test', 'scripts/qa/hitAreaProbe.test.mjs'], {
    repoRoot, cwd: join(repoRoot, 'apps/ui'), env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(policy.kind, 'source-test');
  assert.equal(policy.bootstrap, '1');
  assert.equal(policy.heavyClass, 'validation');
  assert.ok(!policy.placementHeavyClass || policy.placementHeavyClass === 'validation');
  assert.deepEqual(commandPolicy.resolveCommandWorkspaceLocks(policy, repoRoot), []);
});

test('host and first-party plugin source Vitest skip emitted publication while resolver overrides retain preparation', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  assert.equal(readFileSync(artifact, 'utf8'), renderNativeCommandPolicy());
  for (const component of ['apps/server', 'packages/cli-common', 'packages/sdk', 'packages/embed', 'packages/channels-protocol', 'packages/email-transports-protocol', 'packages/plugins/channels', 'packages/plugins/channel-email', 'packages/plugins/channel-telegram', 'packages/plugins/channel-discord', 'packages/plugins/scm-github', 'packages/plugins/scm-gitlab', 'packages/plugins/app-context', 'packages/plugins/inspector']) {
    const args = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts', 'src/ingress.test.ts'];
    const cases = [
      { args, kind: 'source-test', heavyClass: component === 'packages/plugins/channels' ? 'focused-validation' : 'validation' },
      ...['--config=vitest.integration.config.ts', '--root=../other', '--workspace=custom.workspace.ts', '--project=artifact']
        .map(override => ({ args: [...args, override], kind: component === 'apps/server' && override === '--config=vitest.integration.config.ts' ? 'source-test' : 'runtime' })),
      ...(component === 'apps/server' ? [{
        args: ['--script=vitest:local', 'run', '--isolate', '-c', 'vitest.config.ts', 'sources/app/api/socket/externalActionDispatcher.test.ts'],
        kind: 'source-test',
        heavyClass: 'focused-validation',
      }] : []),
    ];
    for (const { args, kind, heavyClass = 'validation' } of cases) {
      const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: join(root, component) });
      assert.equal(policy.kind, kind);
      assert.equal(policy.heavyClass, heavyClass);
      if (process.platform !== 'win32') {
        const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"', 'policy', artifact, root, component, ...args], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout, `${kind},${heavyClass}`);
      }
    }
  }
});

test('confirmed workspace-source configs skip dist preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'workspace-source-config-inventory-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const components = [
    'apps/bootstrap', 'packages/agents', 'packages/deployment-protocol', 'packages/deployments',
    'packages/forge-ci', 'packages/session-core', 'packages/support', 'packages/sync-client', 'packages/triage-sources',
    ...['auggie', 'backup-destinations', 'channel-slack', 'cloudflare-ai-gateway', 'cursor', 'deepseek',
      'deploy-cloudflare', 'deploy-vercel', 'deployment-neon', 'deployment-supabase', 'deployment-templates',
      'devcontainer', 'elevenlabs', 'grok', 'kimi', 'kiro', 'machine-boat', 'machine-crabbox', 'machine-cua',
      'machine-digitalocean', 'machine-fly', 'machine-hetzner', 'machine-lima', 'machine-lume', 'machine-modal',
      'machine-vercel', 'ohmypi', 'openai', 'openrouter', 'scm-azure-devops', 'scm-bitbucket', 'scm-git',
      'vercel-ai-gateway', 'xai'].map(name => `packages/plugins/${name}`),
  ];
  const configs = [
    ...components.map(component => [component, 'vitest.config.ts']),
    ['packages/triage-protocol', 'vitest.source.config.ts'],
    ['packages/voice-modelpacks', 'vitest.direct-source.config.ts'],
    ['packages/plugins/pi', 'vitest.realOwners.config.ts'],
    ['packages/plugins/pi', 'vitest.spawnedRealOwners.config.ts'],
  ];
  for (const [component, config] of configs) {
    await t.test(`${component}/${config}`, () => {
      const args = ['pnpm', 'exec', 'vitest', 'run', '--config', config, 'src/owner.test.ts'];
      const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: join(root, component) });
      assert.equal(policy.kind, 'source-test');
      assert.equal(policy.heavyClass, 'validation');
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
        'policy', artifact, root, component, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'source-test,validation');
    });
  }
  for (const component of ['packages/plugins/machine-docker-sandboxes', 'packages/plugins/pi']) {
    assert.equal(resolveRemoteCommandPolicy(['pnpm', 'exec', 'vitest', 'run'], { repoRoot: root, cwd: join(root, component) }).kind, 'runtime');
  }
});

test('Forge CI exact source Vitest command skips package-dist preparation in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(root, 'packages/forge-ci');
  const args = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'src/ui/mountedCiIntent.test.ts'];
  const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd });
  t.diagnostic(`Forge command classification: ${policy.kind}; placement: ${policy.placementHeavyClass || policy.heavyClass}`);
  assert.equal(policy.kind, 'source-test');
  assert.equal(policy.heavyClass, 'focused-validation');
  assert.ok(!policy.placementHeavyClass || policy.placementHeavyClass === 'focused-validation');
  const fixture = await createTempFixture(t, { prefix: 'forge-ci-source-policy-' });
  const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
  const prepared = await prepareRemoteValidationWorkspace({
    repoDir: fixture.root, componentRelativeDir: policy.component,
    validationKind: policy.kind, requiredTools: policy.requiredTools,
  });
  assert.deepEqual(prepared.built, []);
  assert.deepEqual(prepared.skipped, ['workspace-source-test']);
  if (process.platform === 'win32') return;
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
    'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'source-test,focused-validation');
  for (const override of ['--config=vitest.integration.config.ts', '--root=../other', '--workspace=custom.workspace.ts', '--project=artifact']) {
    assert.equal(resolveRemoteCommandPolicy([...args, override], { repoRoot: root, cwd }).kind, 'runtime', override);
    const overridden = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, cwd, ...args, override], { encoding: 'utf8' });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(overridden.stdout, 'runtime', override);
  }
});

test('plugin-ui source Vitest skips emitted dependency publication in both dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const args = ['yarn', '--cwd', 'packages/plugin-ui', '-s', 'vitest', 'run', 'src/presentation/data/StackedSeriesChart.rnw.test.tsx'];
  assert.equal(resolveRemoteCommandPolicy(args, { cwd: root }).kind, 'source-test');
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'source-test');
  assert.equal(resolveRemoteCommandPolicy([...args, '--config=vitest.external.config.ts'], { cwd: root }).kind, 'runtime');
});

test('finite workspace publishers retain placement class without an outer payload owner', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict' };
  const fixture = await createTempFixture(t, { prefix: 'finite-publisher-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [cwd, entry, expected, heavyClass] of [
    ['packages/protocol', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '1', 'runtime-build'],
    ['packages/cli-common', 'scripts/build.mjs', '1', 'package-dist'],
    ['packages/cli-common', join(root, 'packages/cli-common/scripts/build.mjs'), '1', 'package-dist'],
    ['packages/privacy-kit', 'scripts/build.mjs', '0', 'compilation'],
    ['apps/cli', 'scripts/build.mjs', '1', 'compilation'],
    ['apps/server', '../../scripts/workspaces/runTypeScriptCli.mjs', '0', 'compilation-server'],
    ['apps/server', 'scripts/runTypeScriptCli.mjs', '0', 'compilation-server'],
    ['apps/server', 'scripts/buildSharedDeps.mjs', '1', 'compilation'],
    ['packages/plugins/triage', 'scripts/ensureTypecheckDeclarationPrerequisites.mjs', '1', 'compilation'],
    ['apps/server', 'fixture/runTypeScriptCli.mjs', '0', 'compilation-server'],
    ['packages/protocol', './fixture/buildTypeScriptPackageDist.mjs', '0', 'runtime-build'],
  ]) {
    const args = ['node', entry, '-p', 'tsconfig.json'];
    const policy = resolveRemoteCommandPolicy(args, { cwd, env });
    assert.equal(policy.selfPublisher ?? '0', expected, `${cwd}/${entry}`);
    assert.equal(policy.heavyClass, heavyClass);
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_selfPublisher" "$policy_heavyClass"', 'policy', artifact, root, cwd, ...args], { encoding: 'utf8', env });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `${expected},${heavyClass}`);
  }
});

test('public source typechecks consume source without prerequisite publication', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'typecheck-prerequisite-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const args of [
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    ['node', 'apps/server/scripts/runTypeScriptCli.mjs', '--noEmit'],
    ['pnpm', '--dir', 'apps/cli', 'run', 'typecheck'],
  ]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.selfPublisher, '0', 'source typechecks need no dependency publication');
    assert.equal(policy.kind, 'typecheck');
    if (args[0] !== 'node' || process.platform === 'win32') continue;
    assert.equal(policy.compilerLeaf, '1');
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_compilerLeaf" "$policy_selfPublisher"',
      'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, '1,0');
  }
});

test('build:packages delegates admission to its transitive finite publishers', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const args = ['node', 'scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs', '@happier-dev/protocol', '@happier-dev/transfers'];
  const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root });
  assert.equal(policy.selfPublisher, '1', 'the coordinator must not reserve capacity across foreign producer leases');
  const publicPolicy = await commandPolicy.resolvePackageCommandPolicy(
    ['pnpm', 'run', 'build:packages', '@happier-dev/protocol', '@happier-dev/transfers'], { repoRoot: root, cwd: root });
  assert.equal(publicPolicy.selfPublisher, '1', 'the real manifest must preserve producer-owned resource-first admission');
  assert.equal(publicPolicy.heavyClass, '', 'the controller dispatches finite publishers without a local compile envelope');
  assert.equal(publicPolicy.localCompile, '0', 'the public coordinator must not be refused as a controller compiler');
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@"; printf '%s' "$policy_selfPublisher"`,
    'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, '1');
  const target = { name: 'worker', platform: 'linux', repoDir: root, cliHomeDir: '/tmp/workspace-build-worker-home' };
  assert.doesNotMatch(buildRemoteExecCommand(target, { commandArgs: args, admissionClass: 'compilation', executionId }), /--heavyweight-admission/);
  assert.equal(resolveRemoteCommandPolicy(['node', './fixture/scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs'], { repoRoot: root, cwd: root }).selfPublisher, '0');
});

test('workspace build coordination stays primary while its worker request remains target-local', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const args = ['node', 'scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs', '@happier-dev/protocol'];
  assert.equal(resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root }).placement, 'primary-only');
  const worker = [args[0], args[1], '--worker-request={"packageNames":["@happier-dev/protocol"],"componentDirs":[]}'];
  assert.notEqual(resolveRemoteCommandPolicy(worker, { repoRoot: root, cwd: root }).placement, 'primary-only');
});

test('a compound workspace build dispatches its reader through AUTO instead of running it on the controller', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-workspace-build-reader-' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true,
    scripts: { 'build:packages': 'node scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs @fixture/example' } }));
  mkdirSync(join(root, 'apps/stack/bin'), { recursive: true });
  writeFileSync(join(root, 'reader.test.mjs'), `import assert from 'node:assert/strict';
assert.equal(process.env.FIXTURE_AUTO_READER, '1', 'reader must be placed by AUTO');\n`);
  const dispatcher = join(root, 'apps/stack/bin/hstack-exec');
  // The remote dispatcher is the process boundary. Its argv must select AUTO;
  // the real transformed shell and real Node reader run beneath that boundary.
  writeFileSync(dispatcher, '#!/bin/sh\n[ "$1" = -- ] || exit 71\nshift\nexport FIXTURE_AUTO_READER=1\nexec "$@"\n');
  chmodSync(dispatcher, 0o755);
  const { binDir } = writeFakeBin({ root, name: 'pnpm', content: '#!/bin/sh\nexit 0\n' });
  const command = 'pnpm run build:packages && node --test reader.test.mjs';
  const policy = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', command], { repoRoot: root, cwd: root });
  assert.equal(policy.placement, 'primary-only');
  assert.ok(policy.admissionScript, 'the controller must dispatch the reader as its own phase');
  const child = spawnSync('/bin/sh', ['-c', policy.admissionScript], { cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

test('manifest publisher delegation follows real scripts without bypassing placement', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const classify = commandPolicy.isSelfPublishingPackageCommand ?? (async () => false);
  for (const [name, expected] of [['protocol', true], ['cli-common', true], ['sdk', true], ['privacy-kit', false], ['plugin-sdk', true]]) {
    const cwd = join(root, 'packages', name);
    assert.equal(await classify(['yarn', 'build'], { repoRoot: root, cwd }), expected, name);
    assert.equal(await isSelfDispatchingPackageCommand(['yarn', 'build'], { repoRoot: root, cwd }), false, 'publisher ownership is not target dispatch');
  }
  for (const [workspace, script, component, heavyClass, selfPublisher] of [
    ['@happier-dev/server', 'build', 'apps/server', 'compilation', '1'],
    ['@happier-dev/plugin-ui', 'typecheck', 'packages/plugin-ui', 'compilation', '0'],
    ['@happier-dev/plugins-triage', 'typecheck', 'packages/plugins/triage', 'compilation', '0'],
    ['@happier-dev/app', 'typecheck', 'apps/ui', 'compilation-ui', '0'],
  ]) await t.test(`${workspace} ${script}`, async () => {
    const policy = await commandPolicy.resolvePackageCommandPolicy(['yarn', 'workspace', workspace, script], {
      repoRoot: root, cwd: root,
    });
    assert.equal(policy.component, component);
    assert.equal(policy.selfPublisher, selfPublisher,
      'only genuine build phases retain prerequisite publication');
    assert.equal(policy.heavyClass, heavyClass, 'placement covers the full producer/compiler lifecycle');
  });
});

test('manifest publisher delegation resolves repository package references and rejects unresolved graphs', async t => {
  const { root: fixtureRoot } = await createTempFixture(t, { prefix: 'publisher-references-' });
  const root = join(fixtureRoot, 'repo');
  await mkdir(join(root, 'packages/consumer'), { recursive: true });
  await mkdir(join(root, 'packages/producer'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await writeFile(join(root, 'packages/producer/package.json'), JSON.stringify({ name: '@fixture/producer', scripts: {
    check: 'node ../../apps/stack/scripts/test_ci.mjs && yarn -s publish',
    publish: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
    cycle: 'yarn --cwd ../consumer -s cycle',
  } }));
  await mkdir(join(fixtureRoot, 'external'), { recursive: true });
  await writeFile(join(fixtureRoot, 'external/package.json'), JSON.stringify({ scripts: {
    publish: 'node ../repo/scripts/workspaces/runTypeScriptCli.mjs --noEmit',
  } }));
  const cwd = join(root, 'packages/consumer');
  const writeConsumer = scripts => writeFile(join(cwd, 'package.json'), JSON.stringify({ name: '@fixture/consumer', scripts }));
  const compiler = 'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json';
  for (const reference of ['yarn --cwd ../producer -s check', 'yarn workspace @fixture/producer check']) {
    await writeConsumer({ check: `${reference} && ${compiler}` });
    const policy = await commandPolicy.resolvePackageCommandPolicy(['yarn', 'check'], { repoRoot: root, cwd });
    assert.equal(policy.selfPublisher, '1', reference);
    assert.equal(policy.requiredTools, 'bun', 'referenced manifests retain their real tool requirements');
  }
  for (const script of ['yarn --cwd ../missing -s publish', 'yarn workspace @fixture/missing publish',
    'yarn --cwd ../../../external -s publish', 'yarn --cwd ../producer -s cycle', 'npx arbitrary-compiler']) {
    await writeConsumer({ check: script, cycle: 'yarn --cwd ../producer -s cycle' });
    const policy = await commandPolicy.resolvePackageCommandPolicy(['yarn', 'check'], { repoRoot: root, cwd });
    assert.equal(policy.selfPublisher, '0', script);
  }
});

test('publisher policy uses effective compiler argv and the selected prepared script', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(repoRoot, 'packages/protocol');
  const args = ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json', '--noCheck'];
  for (const [env, expected] of [[{}, 'runtime-build'], [{ HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' }, 'package-dist'], [{ HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'prepack' }, 'runtime-build']]) {
    assert.equal(resolveRemoteCommandPolicy(args, { cwd, env }).heavyClass, expected);
  }
  const sdkDir = join(repoRoot, 'packages/plugin-sdk');
  const packageJson = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  assert.equal(await commandPolicy.resolveWorkspacePackageBuildAdmissionClass({ packageJson, cwd: sdkDir, scriptName: 'check:prepare:api-governance:prepared', env: {} }), 'package-dist');
  assert.equal(await commandPolicy.resolveWorkspacePackageBuildAdmissionClass({ packageJson: { scripts: { build: 'pkgroll', selected: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json' } }, cwd: sdkDir, scriptName: 'selected', env: {} }), 'package-dist');
  const resolvePublisher = commandPolicy.resolveCommandPublisherPolicy ?? (async () => ({ selfPublisher: '0', heavyClass: '' }));
  assert.deepEqual(await resolvePublisher(['yarn', 'build'], { repoRoot, cwd, env: {} }), { selfPublisher: '1', heavyClass: 'runtime-build', requiredTools: '' });
  assert.deepEqual(await resolvePublisher(['node', 'scripts/bundleWorkspaceDeps.mjs', '--declarations', '--run-script=check:prepare:api-governance:prepared'], { repoRoot, cwd: sdkDir, env: {} }), { selfPublisher: '1', heavyClass: 'package-dist', requiredTools: '' });
  assert.deepEqual(await resolvePublisher(['yarn', 'prepack'], { repoRoot, cwd: join(repoRoot, 'apps/cli'), env: { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' } }), { selfPublisher: '1', heavyClass: 'compilation', requiredTools: '' });
});

test('sequential shell placement derives the largest known phase without interpreting arbitrary shell state', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const commands = 'pnpm run build:packages @happier-dev/protocol @happier-dev/agents @happier-dev/plugin-sdk @happier-dev/plugin-ui && pnpm --dir apps/cli run typecheck';
  const leaf = await commandPolicy.resolvePackageCommandPolicy(['pnpm', '--dir', 'apps/cli', 'run', 'typecheck'], { repoRoot, cwd: repoRoot });
  const composed = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', commands], { repoRoot, cwd: repoRoot });
  assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(composed.heavyClass),
    commandPolicy.resolveHeavyweightMemoryFloorKiB(leaf.heavyClass));
  assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(composed.heavyClass),
    commandPolicy.resolveHeavyweightMemoryFloorKiB('compilation-ui'));
  assert.equal(composed.selfPublisher, '1', 'public producers and compiler leaves retain phase admission');
  const rawTest = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', 'node --test example.test.mjs'], { repoRoot, cwd: repoRoot });
  assert.equal(rawTest.heavyClass, 'validation');
  assert.equal(rawTest.selfPublisher, '0', 'a raw test process still needs outer admission');
  for (const body of ['cd apps/ui && pnpm run typecheck', 'pnpm run "$SELECTED_SCRIPT"', 'pnpm run build | pnpm run typecheck']) {
    const unresolved = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', body], { repoRoot, cwd: repoRoot });
    assert.deepEqual(unresolved, commandPolicy.resolveRemoteCommandPolicy(['sh', '-c', body], { repoRoot, cwd: repoRoot }),
      'unsupported shell state retains its existing policy rather than assuming a directory or executing it');
  }
});

test('login shell package chains expose the same nested demand and phase ownership as plain shells', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const body = 'pnpm run build:packages @happier-dev/protocol && pnpm --dir apps/cli run typecheck';
  const options = { repoRoot, cwd: repoRoot };
  const plain = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', body], options);
  for (const shell of ['/bin/sh', '/bin/bash']) {
    const login = await commandPolicy.resolvePackageCommandPolicy([shell, '-lc', body], options);
    assert.equal(login.heavyClass, plain.heavyClass, shell);
    assert.equal(login.selfPublisher, plain.selfPublisher, 'shell login flags cannot change phase admission ownership');
    assert.equal(login.requiredTools, plain.requiredTools, shell);
  }
  const rawTestBody = 'pnpm run build:packages @happier-dev/protocol && node --test example.test.mjs';
  const target = { name: 'worker', platform: 'linux', repoDir: repoRoot, cliHomeDir: '/tmp/nested-package-policy' };
  for (const shell of ['/bin/sh', '/bin/bash']) {
    const policy = await commandPolicy.resolvePackageCommandPolicy([shell, '-lc', rawTestBody], options);
    assert.ok(policy.admissionScript, 'an unowned raw test acquires capacity after its finite publishers');
    const rewritten = buildRemoteExecCommand(target, { executionId, commandArgs: [shell, '-lc', rawTestBody],
      commandPolicy: policy, admissionClass: policy.heavyClass });
    const expected = buildRemoteExecCommand(target, { executionId, commandArgs: [shell, '-lc', policy.admissionScript],
      commandPolicy: { ...policy, admissionScript: '' }, admissionClass: policy.heavyClass });
    assert.equal(rewritten, expected, 'remote rendering consumes phase admission while preserving the login flag');
  }
});

test('compound build:packages then raw Vitest retains producer-before-payload admission', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const command = 'pnpm run build:packages @happier-dev/protocol @happier-dev/plugin-sdk && pnpm --dir apps/cli exec vitest run --config vitest.config.ts scripts/build-owned/bundledPlugins/typescriptModuleInspection.test.ts -t "inspects the Codex authored manifest within the worker heap budget"';
  const policy = await commandPolicy.resolvePackageCommandPolicy(['sh', '-c', command], { repoRoot, cwd: repoRoot });
  assert.equal(policy.heavyClass, 'validation', 'the coordinator delegates compilation to its targets');
  assert.equal(policy.selfPublisher, '1', 'producer preparation cannot inherit test capacity');
  assert.ok(policy.admissionScript, 'the raw test must acquire its own admission after preparation');
  assert.doesNotMatch(policy.admissionScript, /'--local'/, 'the consumer retains AUTO target placement');
});

test('multiline build batches place their known producer prefix before any payload starts', async t => {
  const { root } = await createTempFixture(t, { prefix: 'nested-batch-demand-' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  const producer = join(root, 'packages/protocol');
  await mkdir(producer, { recursive: true });
  await writeFile(join(producer, 'package.json'), JSON.stringify({ scripts: {
    build: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
  } }));
  const script = [
    '#!/usr/bin/env bash',
    '# The first producer determines the minimum placement demand.',
    'set -euo pipefail',
    'pnpm --dir packages/protocol run build',
    "node --input-type=module -e '",
    'throw new Error("placement must never execute this script");',
    "'", '',
  ].join('\n');
  await writeFile(join(root, 'build-load.sh'), script);
  const options = { repoRoot: root, cwd: root, env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' } };
  for (const args of [['bash', 'build-load.sh'], ['bash', '-c', script]]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, options);
    assert.equal(policy.placementHeavyClass || policy.heavyClass, 'runtime-build',
      'the Protocol publisher must exclude a worker that cannot satisfy its nested compiler floor');
    assert.equal(policy.admissionScript, undefined, 'placement inspection must not rewrite the batch or its phase ownership');
    assert.equal(policy.heavyClass, commandPolicy.resolveRemoteCommandPolicy(args, options).heavyClass,
      'the prefix declares placement demand without reserving capacity around arbitrary shell state');
    const sourceDev = await commandPolicy.resolvePackageCommandPolicy(args, { ...options,
      env: { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' } });
    assert.equal(sourceDev.placementHeavyClass || sourceDev.heavyClass, 'package-dist',
      'the existing producer policy still owns source-dev versus strict demand');
  }
  for (const prefix of ['unknown-command', 'cd packages/protocol', 'set -- packages/protocol', 'export SELECTED=build']) {
    const opaque = await commandPolicy.resolvePackageCommandPolicy(['bash', '-c',
      `${prefix}\npnpm --dir packages/protocol run build`], options);
    assert.notEqual(opaque.placementHeavyClass || opaque.heavyClass, 'runtime-build',
      'unknown shell state ends static prefix inspection');
  }
});

test('manifest validation aliases preserve canonical compiler phase ownership and demand', async t => {
  const { root } = await createTempFixture(t, { prefix: 'nested-manifest-demand-' });
  const cwd = join(root, 'apps/ui');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: {
    'check:prepared': 'pnpm run prepare:validation && node scripts/checkResult.mjs',
    'prepare:validation': 'node scripts/generateInputs.mjs && pnpm run compile:validation',
    'compile:validation': 'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
    'check:light': 'node scripts/checkResult.mjs',
    'check:opaque': 'opaque-command',
  } }));
  const compiler = resolveRemoteCommandPolicy(['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', 'tsconfig.json'], { repoRoot: root, cwd });
  const composed = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'check:prepared'], { repoRoot: root, cwd });
  assert.equal(composed.heavyClass, compiler.heavyClass, 'placement sees the actual compiler behind preparation aliases');
  assert.equal(composed.selfPublisher, '0', 'source compilers do not publish dependency prerequisites');
  const light = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'check:light'], { repoRoot: root, cwd });
  assert.equal(light.heavyClass, 'validation', 'an unclassified light Node generator must not invent compiler demand');
  const opaque = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'check:opaque'], { repoRoot: root, cwd });
  assert.equal(opaque.heavyClass, 'validation', 'finite-build uncertainty must not invent a larger ordinary payload reservation');
});

test('runtime validation placement includes canonical preparation demand without enlarging payload admission', async t => {
  const { root } = await createTempFixture(t, { prefix: 'runtime-preparation-demand-' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo', private: true, workspaces: ['apps/*', 'packages/*'],
    dependencies: { '@fixture/protocol': 'workspace:*' }, scripts: {
    'test:root': 'node --test root.test.mjs',
    'test:nested': 'apps/stack/bin/hstack-exec --cwd=apps/consumer -- node --test integration.test.mjs',
  } }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const producer = join(root, 'packages/protocol');
  await mkdir(producer, { recursive: true });
  await writeFile(join(producer, 'package.json'), JSON.stringify({ name: '@fixture/protocol', main: './dist/index.js', scripts: {
    build: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
  } }));
  for (const component of ['apps/consumer', 'apps/cli', 'apps/ui', 'apps/server', 'packages/plugin-sdk']) {
    const cwd = join(root, component);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: `@fixture/${component.replace('/', '-')}`,
      dependencies: { '@fixture/protocol': 'workspace:*' }, scripts: {
        'test:integration': 'node --test integration.test.mjs',
        typecheck: 'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit',
      } }));
  }
  const options = { repoRoot: root, env: { HAPPIER_WORKSPACE_BUILD_MODE: 'strict' } };
  const runtime = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'test:integration'], { ...options, cwd: join(root, 'apps/consumer') });
  assert.equal(runtime.heavyClass, 'validation', 'only the test payload reserves the validation envelope');
  assert.equal(runtime.placementHeavyClass, 'runtime-build', 'placement reads the transitive producer build through the canonical graph');
  for (const args of [
    ['sh', '-lc', 'pnpm --dir apps/consumer run test:integration'],
    ['apps/stack/bin/hstack-exec', '--cwd=apps/consumer', '--', 'node', '--test', 'integration.test.mjs'],
    ['pnpm', 'run', 'test:nested'],
  ]) {
    const composed = await commandPolicy.resolvePackageCommandPolicy(args, { ...options, cwd: root });
    assert.equal(composed.heavyClass, 'validation', 'composition retains the payload envelope');
    assert.equal(composed.placementHeavyClass, 'runtime-build', 'shells, executors and manifest aliases carry preparation demand');
  }
  const sourceDev = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'run', 'test:integration'], {
    ...options, cwd: join(root, 'apps/consumer'), env: { HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' },
  });
  assert.equal(commandPolicy.resolveHeavyweightMemoryFloorKiB(sourceDev.placementHeavyClass || sourceDev.heavyClass),
    commandPolicy.resolveHeavyweightMemoryFloorKiB('package-dist'), 'emit-only preparation uses its actual compiler mode');
  for (const [args, cwd] of [
    [['vitest', 'run', 'source.test.ts'], join(root, 'packages/plugin-sdk')],
    [['pnpm', 'run', 'typecheck'], join(root, 'apps/cli')],
    [['pnpm', 'run', 'test:root'], root],
  ]) {
    const skipped = await commandPolicy.resolvePackageCommandPolicy(args, { ...options, cwd });
    assert.equal(skipped.placementHeavyClass || skipped.heavyClass, skipped.heavyClass,
      'source tests, typecheck readers and repository-root scripts do not prepare the runtime closure');
  }
});

test('manifest prerequisites retain a stable tool union for publishers and ordinary commands', async t => {
  const { root } = await createTempFixture(t, { prefix: 'manifest-tool-prerequisites-' });
  const cwd = join(root, 'apps/cli');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ happierSourceTestTools: ['go'], scripts: {
    check: 'node ../stack/scripts/test_ci.mjs && yarn -s ordinary && node ../stack/scripts/test_ci.mjs',
    ordinary: 'vitest run example.test.ts',
  } }));
  const policy = await commandPolicy.resolveCommandPublisherPolicy(['yarn', 'check'], { repoRoot: root, cwd });
  assert.equal(policy.requiredTools, 'bun go');
  const ordinary = await commandPolicy.resolveCommandPublisherPolicy(['yarn', 'ordinary'], { repoRoot: root, cwd });
  assert.equal(ordinary.selfPublisher, '0');
  assert.equal(ordinary.requiredTools, 'go', 'tool requirements do not depend on payload admission ownership');
  const metadata = spawnSync(process.execPath, [fileURLToPath(new URL('./remote_commands.mjs', import.meta.url)),
    '--publisher-policy', root, cwd, 'yarn', 'check'], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.equal(metadata.stdout, `${policy.selfPublisher} ${policy.heavyClass} bun go\n`);
});

test('workspace aliases derive preparation from the selected manifest rather than the caller directory', async t => {
  const { root } = await createTempFixture(t, { prefix: 'workspace-alias-policy-' });
  const packageDir = join(root, 'packages', 'nested', "viewer's tools");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/nested/*'] }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/nested/*\n');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@fixture/unrelated-name', scripts: {
    build: 'node compile.mjs',
  } }));
  for (const args of [
    ['yarn', 'workspace', '@fixture/unrelated-name', 'build'],
    ['pnpm', '--filter', '@fixture/unrelated-name', 'run', 'build'],
    ['pnpm', '--dir', "packages\\nested\\viewer's tools", 'run', 'build'],
    ['corepack', 'yarn', '--cwd', root, 'workspace', '@fixture/unrelated-name', 'build'],
    ['yarn', '--cwd', "packages\\nested\\viewer's tools", 'build'],
  ]) {
    const policy = await commandPolicy.resolvePackageCommandPolicy(args, { repoRoot: root, cwd: '.' });
    assert.equal(policy.component, "packages/nested/viewer's tools");
    assert.equal(policy.commandClass, 'targeted-validation', 'the selected component must prepare before payload admission');
    assert.equal(policy.kind, 'runtime');
    assert.equal(policy.selfPublisher, '0', 'a package alias cannot grant publisher admission authority');
  }
  const rootPolicy = await commandPolicy.resolvePackageCommandPolicy(['yarn', 'lint'], { repoRoot: root, cwd: root });
  assert.equal(rootPolicy.component, '.');
  assert.equal(rootPolicy.commandClass, 'full-validation', 'repository scripts retain their own preparation contract');
  const metadata = spawnSync(process.execPath, [fileURLToPath(new URL('./remote_commands.mjs', import.meta.url)),
    '--package-policy', root, root, 'yarn', 'workspace', '@fixture/unrelated-name', 'build'], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const native = spawnSync('/bin/sh', ['-c', 'eval "$PACKAGE_POLICY"; printf "%s|%s|%s" "$policy_component" "$policy_commandClass" "$policy_kind"'], {
    encoding: 'utf8', env: { ...process.env, PACKAGE_POLICY: metadata.stdout },
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, "packages/nested/viewer's tools|targeted-validation|runtime");
});

test('workspace build admission covers effective compilers behind real package lifecycle scripts', async () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const classify = commandPolicy.resolveWorkspacePackageBuildAdmissionClass
    ?? (({ cwd }) => resolveRemoteCommandPolicy(['yarn', 'build'], { cwd }).heavyClass);
  for (const [name, mode, expected] of [
    ['protocol', 'strict', 'runtime-build'],
    ['protocol', 'source-dev', 'package-dist'],
    ['cli-common', 'strict', 'package-dist'],
    ['plugin-sdk', 'strict', 'package-dist'],
    ['sdk', 'strict', 'runtime-build'],
    ['sdk', 'source-dev', 'package-dist'],
    ['privacy-kit', 'source-dev', 'compilation'],
  ]) {
    const cwd = join(repoRoot, 'packages', name);
    const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    assert.equal(await classify({ packageJson, cwd, env: { HAPPIER_WORKSPACE_BUILD_MODE: mode } }), expected, `${name}/${mode}`);
  }
});

test('workspace build admission includes hooks and fails closed for unresolved script graphs', async () => {
  const cwd = fileURLToPath(new URL('../../../../../packages/protocol', import.meta.url));
  const classify = commandPolicy.resolveWorkspacePackageBuildAdmissionClass
    ?? (({ cwd }) => resolveRemoteCommandPolicy(['yarn', 'build'], { cwd }).heavyClass);
  const compiler = 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json';
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: compiler, postbuild: 'node scripts/build.mjs' } } }), 'compilation');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: 'yarn -s missing' } } }), 'compilation');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: 'yarn -s recursive', recursive: 'yarn build' } } }), 'compilation');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: '../../apps/stack/bin/hstack-exec --script=build:local', 'build:local': compiler } }, env: {} }), 'runtime-build');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: `node -e "$(compiler)" && ${compiler}` } } }), 'compilation');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: `cd .. && ${compiler}` } }, env: {} }), 'compilation');
  assert.equal(await classify({ cwd, packageJson: { scripts: { build: compiler } }, env: {
    HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'prepack',
  } }), 'runtime-build');
});

test('public self-dispatching delegation excludes binary runners and local lifecycle work', async t => {
  const fixture = await createTempFixture(t, { prefix: 'dispatch-payload-' });
  const scripts = { typecheck: 'apps/stack/bin/hstack-exec --script=typecheck:local' };
  const options = { repoRoot: fixture.root, cwd: fixture.root };
  await writeFile(fixture.path('package.json'), JSON.stringify({ scripts }));
  assert.equal(await isSelfDispatchingPackageCommand(['npx', 'typecheck'], options), false);
  for (const hook of ['pretypecheck', 'posttypecheck']) {
    await writeFile(fixture.path('package.json'), JSON.stringify({ scripts: { ...scripts, [hook]: 'compiler' } }));
    assert.equal(await isSelfDispatchingPackageCommand(['yarn', 'typecheck'], options), false, hook);
  }
  await writeFile(fixture.path('package.json'), JSON.stringify({ scripts: { typecheck: `${scripts.typecheck} && compiler` } }));
  assert.equal(await isSelfDispatchingPackageCommand(['yarn', 'typecheck'], options), false);
});

test('public self-dispatching package scripts reach placement without a controller admission', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'host-admission-public-dispatch-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const checkout = fixture.path('native-owner');
  await writeFile(`${checkout}/pnpm-workspace.yaml`, 'packages:\n  - packages/*\n');
  await mkdir(`${checkout}/packages/probe`, { recursive: true });
  await writeFile(`${checkout}/package.json`, JSON.stringify({ workspaces: ['packages/*'], scripts: {
    typecheck: 'apps/stack/bin/hstack-exec --script=typecheck:local',
  } }));
  await writeFile(`${checkout}/packages/probe/package.json`, JSON.stringify({ name: '@probe/package', scripts: {
    typecheck: '../../apps/stack/bin/hstack-exec --script=typecheck:local',
    'typecheck:local': 'compiler',
  } }));
  // Yarn is the external process boundary. The source manifest proves it
  // dispatches itself; observe native admission state at that boundary.
  writeFakeBin({ root: fixture.root, name: 'yarn', content: `#!/bin/sh
for owner in "$FIXTURE_ADMISSION_ROOT/owners/"*; do [ ! -d "$owner" ] || exit 99; done
printf placed
exit 23
` });
  writeFakeBin({ root: fixture.root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "1048576 %s\\n" "${FIXTURE_MEMORY_TOTAL_KIB:-33554432}" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HOME: fixture.root, CI: '',
    FIXTURE_ADMISSION_ROOT: admissionRoot, HAPPIER_EXEC_CONFIG_PATH: '', HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_EXECUTION: '', HAPPIER_HSTACK_DISPATCH_CONTROL: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' };
  for (const command of [ ['yarn', 'typecheck'], ['yarn', '--cwd', 'packages/probe', 'typecheck'], ['yarn', 'workspace', '@probe/package', 'typecheck'] ]) {
    for (const prefix of [ ['--heavyweight-admission', '--class=compilation', '--no-wait', '--'], ['--'] ]) {
      const result = spawnSync('/bin/sh', [launcher, ...prefix, ...command], { cwd: checkout, env, encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 23, `${command.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, 'placed');
    }
  }
  // The implementation target performs real work and must keep its envelope.
  const implementation = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=compilation', '--no-wait', '--',
    'yarn', '--cwd', 'packages/probe', 'typecheck:local'], { cwd: checkout, env, encoding: 'utf8' });
  assert.equal(implementation.status, 75, implementation.stderr);
  assert.equal(implementation.stdout, '');
  const alreadyPlaced = spawnSync('/bin/sh', [launcher, '--', 'yarn', 'typecheck'], {
    cwd: checkout, env: { ...env, HAPPIER_HSTACK_EXECUTION: '1', FIXTURE_MEMORY_TOTAL_KIB: '10485760' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(alreadyPlaced.status, 23, 'a public script retains its own dispatcher even on an already selected host');
  assert.equal(alreadyPlaced.stdout, 'placed');
});

const posix = {
  name: 'linux',
  platform: 'posix',
  ssh: 'happier-stack-linux',
  repoDir: '/home/dev/Happier repo',
  cliHomeDir: '/home/dev/.happier/dev linux',
  remoteServerPort: null,
};

const windows = {
  name: 'windows',
  platform: 'windows',
  ssh: 'happier-stack-windows',
  repoDir: 'C:/Users/test qa/Happier',
  cliHomeDir: 'C:/Users/test qa/.happier/windows',
  remoteServerPort: 43105,
};

const execFileAsync = promisify(execFile);

test('remote credential seeding preserves an enrolled credential across repeated starts', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-auth-seed-' });
  const target = { ...posix, cliHomeDir: fixture.path('remote cli') };
  const { cliHomeDir, activeServerId } = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'source-snapshot' });
  const finalPath = join(cliHomeDir, 'servers', activeServerId, 'access.key');
  const stagedPath = join(cliHomeDir, '.access-key-agent-qa.tmp');
  const token = suffix => `header.${Buffer.from(JSON.stringify({ sub: 'qa-account' })).toString('base64url')}.${suffix}`;
  await mkdir(join(cliHomeDir, 'servers', activeServerId), { recursive: true });
  const command = buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath });
  for (const enrolledToken of [token('enrolled'), 'opaque-enrollment']) {
    const enrolled = JSON.stringify({ token: enrolledToken, encryption: { publicKey: Buffer.alloc(32, 1).toString('base64'), machineKey: Buffer.alloc(32, 2).toString('base64') } });
    await writeFile(finalPath, enrolled, { mode: 0o600 });
    for (const seedToken of [token('older-seed'), 'opaque-controller']) {
      await writeFile(stagedPath, JSON.stringify({ token: seedToken, secret: Buffer.alloc(32, 3).toString('base64') }));
      await execFileAsync('/bin/bash', ['-c', command]);
      assert.equal(readFileSync(finalPath, 'utf8'), enrolled, 'startup must preserve enrollment unless both Account subjects are known and differ');
      assert.equal(existsSync(stagedPath), false, 'unused staged credentials must be retired');
    }
  }
});

test('remote credential seeding adopts a changed controller Account and preserves its next enrollment', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-auth-account-switch-' });
  const target = { ...posix, cliHomeDir: fixture.path('remote cli') };
  const { cliHomeDir, activeServerId } = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'source-snapshot' });
  const finalPath = join(cliHomeDir, 'servers', activeServerId, 'access.key');
  const stagedPath = join(cliHomeDir, '.access-key-agent-qa.tmp');
  const credential = (accountId, signature) => JSON.stringify({
    token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.${signature}`,
    encryption: { publicKey: Buffer.alloc(32, 1).toString('base64'), machineKey: Buffer.alloc(32, 2).toString('base64') },
  });
  await mkdir(join(cliHomeDir, 'servers', activeServerId), { recursive: true });
  await writeFile(finalPath, credential('previous-account', 'enrolled'), { mode: 0o600 });
  const seed = credential('replacement-account', 'controller');
  await writeFile(stagedPath, seed);
  const command = buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath });
  await execFileAsync('/bin/bash', ['-c', command]);
  assert.equal(readFileSync(finalPath, 'utf8'), seed, 'the next start must adopt the controller Account change');
  assert.equal((await stat(finalPath)).mode & 0o777, 0o600);
  assert.equal(existsSync(stagedPath), false);

  const enrolled = credential('replacement-account', 'remote-enrolled');
  await writeFile(finalPath, enrolled);
  await writeFile(stagedPath, seed);
  await execFileAsync('/bin/bash', ['-c', command]);
  assert.equal(readFileSync(finalPath, 'utf8'), enrolled, 'same-Account restarts must preserve the new remote enrollment');
  assert.equal(existsSync(stagedPath), false);
});

test('remote credential seeding initializes missing or empty target credentials privately', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-auth-initial-seed-' });
  const target = { ...posix, cliHomeDir: fixture.path('remote cli') };
  const { cliHomeDir, activeServerId } = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa' });
  const finalPath = join(cliHomeDir, 'servers', activeServerId, 'access.key');
  const stagedPath = fixture.path('staged credential');
  const seed = JSON.stringify({ token: 'qa-seed', secret: Buffer.alloc(32, 3).toString('base64') });
  const command = buildRemoteInstallCredentialCommand(target, { stagedPath, finalPath });
  for (const empty of [false, true]) {
    if (empty) await writeFile(finalPath, '');
    await writeFile(stagedPath, seed);
    await execFileAsync('/bin/bash', ['-c', command]);
    assert.deepEqual(JSON.parse(readFileSync(finalPath, 'utf8')), JSON.parse(seed));
    assert.equal((await stat(finalPath)).mode & 0o777, 0o600);
    assert.equal(existsSync(stagedPath), false);
  }
});

test('remote narrow stack operations keep literal CLI arguments and retained stack scope on POSIX and Windows', () => {
  for (const target of [posix, windows]) {
    for (const operation of ['happier', 'daemon', 'build']) {
      const options = { stackName: 'agent-qa', runtimeMode: 'source-snapshot',
        passthrough: ['--identity=account-b', '--runtime', '--', 'actions', 'get', "widget's $literal; --json"] };
      const raw = operation === 'happier' ? buildRemoteStackHappierCommand(target, options)
        : buildRemoteStackOperationCommand(target, { ...options, operation });
      const command = target.platform === 'windows' ? Buffer.from(raw.split(' ').at(-1), 'base64').toString('utf16le') : raw;
      assert.ok(command.includes(`stack ${operation}`));
      assert.ok(command.includes('/stack-state/agent-qa/cli'));
      assert.ok(command.includes('--identity=account-b'));
      assert.match(command, /HAPPIER_DEV_TARGET_EXECUTION/);
      assert.doesNotMatch(command, /stack (start|dev|new|stop)|stack env/);
      if (target.platform === 'windows') {
        assert.ok(command.includes("'widget''s $literal; --json'"));
        assert.match(command, /exit \$LASTEXITCODE/);
      } else {
        // Both the SSH shell and its bash payload must retain this argument literally.
        assert.ok(command.includes('$literal; --json'));
        assert.match(command, new RegExp(`exec node .*stack ${operation}`));
      }
    }
  }
});

test('CLI command prerequisites distinguish Vitest setup from generator-only projection checks', async () => {
  const vitest = await commandPolicy.resolvePackageCommandPolicy(['corepack', 'yarn', '--cwd', 'apps/cli', 'vitest', 'run', 'src/example.test.ts']);
  const projection = resolveRemoteCommandPolicy(['corepack', 'yarn', '--cwd', 'apps/cli', 'test:migration:bundled-plugin-projections']);
  assert.equal(vitest.requiredTools, 'go');
  assert.equal(vitest.heavyClass, 'validation', 'non-compiling focused requests retain validation');
  assert.equal(projection.requiredTools, '', 'generator-only checks do not run Vitest global setup');
  assert.equal(vitest.workspaceLock, '');
  assert.equal(projection.workspaceLock, '');
  const unrelated = resolveRemoteCommandPolicy(['vitest', 'run'], { cwd: 'packages/plugin-sdk' });
  assert.equal(unrelated.workspaceLock, '');
  const integration = resolveRemoteCommandPolicy(['vitest', 'run', '--config', 'vitest.integration.config.ts'], { cwd: 'apps/cli' });
  assert.equal(integration.workspaceLock, '.project/tmp/cli-dist-build.lock');
  const unit = resolveRemoteCommandPolicy(['corepack', 'yarn', '--cwd', 'apps/cli', 'test:unit']);
  assert.equal(unit.workspaceLock, '');
  assert.equal(unit.heavyClass, 'compilation', 'the complete CLI unit lane contains real compiler consumers');
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  if (process.platform !== 'win32') for (const [component, expected] of [['apps/cli', vitest.workspaceLock], ['packages/plugin-sdk', '']]) {
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/$3; resolve_native_command_policy vitest run; printf "%s" "$policy_workspaceLock"', 'policy', artifact, root, component], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, expected);
  }
});

test('source-test native requirements belong to the selected package declaration', async t => {
  const fixture = await createTempFixture(t, { prefix: 'selected-source-test-tools-' });
  await installNativeAdmissionFixture({ root: fixture.root });
  const root = join(fixture.root, 'native-owner');
  const cliDir = join(root, 'apps/cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const manifest = { name: '@happier-dev/cli', scripts: {
    vitest: 'vitest',
    'test:unit': 'yarn -s test:unit:vitest && yarn -s test:import-cycles',
    'test:unit:vitest': 'node scripts/runVitestShards.mjs --config vitest.config.ts',
    'test:import-cycles': 'node scripts/importCycleGuard.mjs',
  } };
  const owner = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
  const requests = [
    { cwd: cliDir, args: ['vitest', 'run', 'src/example.test.ts'] },
    { cwd: root, args: ['yarn', '--cwd', 'apps/cli', 'vitest', 'run', 'src/example.test.ts'] },
    { cwd: root, args: ['pnpm', '--dir', 'apps/cli', 'exec', 'vitest', 'run', 'src/example.test.ts'] },
    { cwd: cliDir, args: ['hstack-exec', '--heavyweight-admission', '--class=compilation', '--', 'vitest', 'run', 'src/example.test.ts'] },
    { cwd: root, args: ['yarn', 'workspace', '@happier-dev/cli', 'test:unit'] },
    { cwd: cliDir, args: ['yarn', 'test:unit'] },
    { cwd: cliDir, args: ['vitest', 'run', '--config', 'vitest.integration.config.ts', 'src/example.test.ts'] },
  ];
  const nativePolicy = request => spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}
repo_root=$1; invoked_cwd=$2; projection_command_policy=$3; shift 3
resolve_native_command_policy "$@" || exit $?
# Workspace selection belongs to the launcher's canonical package-policy probe,
# not the argv-only native classifier. Exercise that real projection too.
if [ -n "$policy_workspace" ]; then
  assignments=$(node "$projection_command_policy" --package-policy "$repo_root" "$invoked_cwd" "$@") || exit $?
  eval "$assignments"
fi
printf '%s' "$policy_requiredTools"`,
    'policy', root, request.cwd, owner, ...request.args], { encoding: 'utf8' });
  for (const [declaration, expected] of [[undefined, ''], [['go'], 'go']]) {
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ ...manifest,
      ...(declaration === undefined ? {} : { happierSourceTestTools: declaration }) }));
    for (const request of requests) {
      const policy = await commandPolicy.resolvePackageCommandPolicy(request.args, { repoRoot: root, cwd: request.cwd });
      assert.equal(policy.requiredTools, expected, request.args.join(' '));
      if (process.platform !== 'win32') {
        const native = nativePolicy(request);
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout, expected, request.args.join(' '));
      }
      if (declaration === undefined && policy.kind === 'source-test') {
        // A predecessor-shaped checkout has no native source owner or loader.
        // Its declared flow must remain usable without either new private API.
        const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
        const result = await prepareRemoteValidationWorkspace({ repoDir: root,
          componentRelativeDir: policy.component, validationKind: policy.kind,
          requiredTools: policy.requiredTools });
        assert.deepEqual(result.skipped, ['workspace-source-test']);
      }
    }
    if (declaration !== undefined) {
      const { prepareRemoteValidationWorkspace } = await import('./remote_validation_preparation.mjs');
      await assert.rejects(prepareRemoteValidationWorkspace({ repoDir: root,
        componentRelativeDir: 'apps/cli', validationKind: 'source-test', requiredTools: expected,
        env: buildNativeAdmissionFixtureEnv() }),
      error => error.exitCode === 1 && error.signal === null,
      'a declared native prerequisite must not silently skip a missing selected source owner');
    }
  }
  for (const declaration of ['go', ['go;not-a-tool']]) {
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ ...manifest, happierSourceTestTools: declaration }));
    for (const request of requests) {
      await assert.rejects(commandPolicy.resolvePackageCommandPolicy(request.args,
        { repoRoot: root, cwd: request.cwd }), /happierSourceTestTools/u);
      if (process.platform !== 'win32') {
        const native = nativePolicy(request);
        assert.notEqual(native.status, 0);
        assert.match(native.stderr, /happierSourceTestTools/u);
      }
    }
  }
});

async function createCliNativeCustodyDispatchFixture(t, placement) {
    const { root } = await createTempFixture(t, { prefix: 'cli-vitest-publication-' });
    const { launcher } = await installNativeAdmissionFixture({ root, prepareDependencies: true });
    const checkout = join(root, 'native-owner');
    await installCliNativeCustodySourceFixture(checkout);
    const cliDir = join(checkout, 'apps/cli');
    await cp(new URL('../../../../cli/vitest.config.ts', import.meta.url), join(cliDir, 'vitest.config.ts'));
    await cp(new URL('../../../../cli/src/test-setup.unit.ts', import.meta.url), join(cliDir, 'src/test-setup.unit.ts'));
    const controlDir = join(checkout, 'packages/plugin-ui');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(join(cliDir, 'native/processcustody'), { recursive: true });
    mkdirSync(controlDir, { recursive: true });
    const lockPath = join(cliDir, '.project/tmp/process-custody-publication.lock');
    const lockOwner = fileURLToPath(new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url));
    const payload = join(root, 'payload.mjs');
    writeFileSync(payload, `import { callerHoldsWorkspaceBundleLock } from ${JSON.stringify(lockOwner)};
import { readFileSync } from 'node:fs';
const lockPath = ${JSON.stringify(lockPath)};
const held = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
if (process.cwd() === ${JSON.stringify(cliDir)}) {
  if (readFileSync(${JSON.stringify(join(cliDir, 'tools/unpacked/happier-process-custody'))}, 'utf8') !== 'prepared-native') throw new Error('native preparation missing');
}
process.stdout.write(JSON.stringify({ admitted: Boolean(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT), inherited: callerHoldsWorkspaceBundleLock(lockPath, held), buildMode: process.env.HAPPIER_WORKSPACE_BUILD_MODE }));
`);
    // The test runner executable and OS capacity are genuine boundaries. Both
    // dispatchers, native admission and authenticated publication remain real.
    writeFakeBin({ root, name: 'vitest', content: `#!/bin/sh\nexec '${process.execPath}' '${payload}'\n` });
    writeFakeBin({ root, name: 'go', content: `#!/bin/sh
if [ "\${1-}" = env ] && [ "\${2-}" = -json ]; then
  printf '%s\\n' '{"GOVERSION":"fixture-go","GOFLAGS":"","GOEXPERIMENT":"","GOAMD64":"v1","GOARM":"","GOARM64":""}'
  exit 0
fi
[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT" ] || exit 91
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; output=$1; fi
  shift
done
printf 'prepared-native' > "$output"
` });
    writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "33554432 33554432\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
    writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
    const bin = join(root, 'bin');
    const environment = {
      HOME: root, PATH: `${bin}:${process.env.PATH}`, CI: '', HAPPIER_DEV_TARGET_EXECUTION: '1',
      HAPPIER_HSTACK_EXECUTION: '', HAPPIER_EXEC_CONFIG_PATH: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '',
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '',
    };
    const policies = new Map(await Promise.all(['apps/cli', 'packages/plugin-ui'].map(async component => [
      component, await commandPolicy.resolvePackageCommandPolicy(['vitest', 'run', 'src/example.test.ts'],
        { repoRoot: checkout, cwd: join(checkout, component) }),
    ])));
    const run = (component, buildMode) => {
      // Bind scratch at the worker process boundary, before remote custody
      // starts. The fixture owns its teardown; per-dispatch scratch reclamation
      // otherwise censuses this shared host, unrelated to publication leases.
      const fixtureEnv = { ...buildNativeAdmissionFixtureEnv(), TMPDIR: root };
      delete fixtureEnv.HAPPIER_WORKSPACE_BUILD_MODE;
      const commandEnvironment = { ...environment,
        HAPPIER_DEV_TARGET_EXECUTION: placement === 'remote' ? '1' : '',
        ...(buildMode ? { HAPPIER_WORKSPACE_BUILD_MODE: buildMode } : {}) };
      if (placement === 'remote') {
        const policy = policies.get(component);
        const command = buildRemoteExecCommand({ ...posix, repoDir: checkout, cliHomeDir: join(root, 'home'), remotePath: [bin] }, {
          executionId, cwd: component, commandArgs: ['vitest', 'run', 'src/example.test.ts'],
          admissionClass: policy.heavyClass, commandPolicy: policy,
          environment: commandEnvironment,
          preparation: { componentRelativeDir: component, validationKind: 'source-test' },
        });
        return execFileAsync('/bin/bash', ['-c', command], { env: fixtureEnv, signal: t.signal });
      }
      return execFileAsync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'src/example.test.ts'], {
        cwd: join(checkout, component), env: { ...fixtureEnv, ...commandEnvironment }, signal: t.signal,
      });
    };
    return { run, lockPath, cliDir };
}

for (const placement of ['remote', 'local']) {
  test(`unrelated source Vitest does not acquire the CLI publication lease (${placement})`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const { run, lockPath } = await createCliNativeCustodyDispatchFixture(t, placement);
    await withWorkspaceBundleLock(async () => {
      for (const buildMode of [undefined, 'strict']) {
        const control = await run('packages/plugin-ui', buildMode);
        assert.deepEqual(JSON.parse(control.stdout), {
          admitted: true, inherited: false, buildMode: buildMode ?? 'qa-runtime',
        });
      }
    }, { lockPath });
  });

  test(`CLI source Vitest releases its admitted native-preparation publication lease before the payload (${placement})`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const { run, lockPath, cliDir } = await createCliNativeCustodyDispatchFixture(t, placement);
    let release;
    let ready;
    let refuse;
    const acquired = new Promise((resolve, reject) => { ready = resolve; refuse = reject; });
    const held = withWorkspaceBundleLock(async () => {
      await new Promise(resolve => { release = resolve; ready(); });
    }, { lockPath });
    held.catch(refuse);
    await acquired;
    const pending = run('apps/cli');
    let settled = false;
    let stderr = '';
    pending.child.stderr.on('data', value => { stderr += value; });
    const result = pending.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    // Observe the canonical publication owner's authenticated waiter. Native
    // preparation waits directly on this lease, without admission's busy log.
    result.catch(() => {});
    try {
      while (!settled && !isWorkspaceBundleLockActive(`${lockPath}.priority-claim`)) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(settled, false, stderr);
      assert.equal(existsSync(join(cliDir, 'tools/unpacked/happier-process-custody')), false,
        'native preparation must not publish while another CLI writer holds the lease');
    } finally { release(); }
    await held;
    const completed = await result;
    assert.deepEqual(JSON.parse(completed.stdout), { admitted: true, inherited: false, buildMode: 'qa-runtime' });
  });
}

test('source snapshot remote commands retain the QA stack home and start source without watching on both platforms', () => {
  for (const target of [posix, windows]) {
    const options = {
      stackName: 'agent-qa', runtimeMode: 'source-snapshot',
      services: { server: false, expo: false, daemon: true },
      serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    };
    assert.deepEqual(resolveRemoteStackStatePaths(target, options), resolveRemoteStackStatePaths(target, { ...options, runtimeMode: 'controlled' }));
    const invocation = buildRemoteStackCommand(target, options);
    const command = target.platform === 'windows' ? Buffer.from(invocation.split(' ').at(-1), 'base64').toString('utf16le') : invocation;
    assert.match(command, /stack start/);
    assert.match(command, /--runtime=.*source/);
    assert.match(command, /--no-dev-targets/);
    assert.match(command, /--no-browser/);
    assert.match(command, /--no-server/);
    assert.match(command, /--no-ui/);
    assert.doesNotMatch(command, /stack dev|--watch/);
    assert.doesNotMatch(command, /corepack|yarn/);
    assert.match(command, /apps\/stack\/bin\/hstack\.mjs/);
    const stopInvocation = buildRemoteStackStopCommand(target, options);
    const stopCommand = target.platform === 'windows' ? Buffer.from(stopInvocation.split(' ').at(-1), 'base64').toString('utf16le') : stopInvocation;
    assert.doesNotMatch(stopCommand, /corepack|yarn/);
    assert.match(stopCommand, /apps\/stack\/bin\/hstack\.mjs/);
    const recoveryInvocation = buildRemoteStackCommand(target, { ...options, reuseSourceRuntime: true,
      sourceStartRequestId: executionId });
    const recoveryCommand = target.platform === 'windows' ? Buffer.from(recoveryInvocation.split(' ').at(-1), 'base64').toString('utf16le') : recoveryInvocation;
    assert.match(recoveryCommand, /--reuse-source-runtime/);
    assert.match(recoveryCommand, /--restart/);
    assert.match(recoveryCommand, new RegExp(`--source-start-request-id=[^ ]*${executionId}`),
      'both remote launchers carry the parent pending-start identity');
    const refreshInvocation = buildRemoteStackCommand(target, { ...options, refreshSourceRuntime: true });
    const refreshCommand = target.platform === 'windows' ? Buffer.from(refreshInvocation.split(' ').at(-1), 'base64').toString('utf16le') : refreshInvocation;
    assert.match(refreshCommand, /--restart/, 'a crashed source worker enters preparation before retirement');
    assert.doesNotMatch(refreshCommand, /--reuse-source-runtime|--prepared-source-reload/);
  }
});

test('source snapshot launches the canonical Stack entry directly and preserves initialization failure', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-direct-entry-' });
  const { launcher } = await installNativeAdmissionFixture({ root: join(root, 'repo with spaces') });
  const repoDir = join(root, 'repo with spaces', 'native-owner');
  const binDir = join(root, 'bin');
  const recorded = join(root, 'invocations');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // The remote JavaScript executable is an OS/process boundary; Stack argument
  // selection and shell error propagation remain the real command owner.
  // Source builders admit their finite work themselves; startup must not hold
  // an outer payload envelope while those builders acquire their leases.
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\ncase "$1" in ./apps/stack/bin/hstack.mjs) ;; *) exec '${process.execPath}' "$@" ;; esac\nprintf '%s\\n' "$*" >> '${recorded}'\nif [ "$3" = new ] && [ "\${FAIL_NEW:-0}" = 1 ]; then exit 23; fi\nif [ "$3" = start ]; then [ -z "\${HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN:-}" ] || exit 99; fi\n`);
  chmodSync(join(binDir, 'node'), 0o755);
  chmodSync(launcher, 0o755);
  writeFakeBin({ root, name: 'uname', content: '#!/bin/sh\nprintf "Linux\\n"\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "33554432 33554432\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  const target = { ...posix, repoDir, cliHomeDir: join(root, 'home'), remotePath: [binDir] };
  const command = buildRemoteStackCommand(target, {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot',
    services: { server: false, expo: false, daemon: true }, serverUrl: 'http://127.0.0.1:43001',
  });
  const env = buildNativeAdmissionFixtureEnv();
  await execFileAsync('/bin/bash', ['-c', command], { env });
  const invocations = readFileSync(recorded, 'utf8').trim().split('\n');
  assert.equal(invocations.length, 3);
  assert.match(invocations[0], /^\.\/apps\/stack\/bin\/hstack\.mjs stack new agent-qa /);
  assert.match(invocations[1], /^\.\/apps\/stack\/bin\/hstack\.mjs stack env agent-qa set /);
  assert.match(invocations[2], /^\.\/apps\/stack\/bin\/hstack\.mjs stack start agent-qa .*--runtime=source/);
  writeFileSync(recorded, '');
  await assert.rejects(execFileAsync('/bin/bash', ['-c', command], { env: { ...env, FAIL_NEW: '1' } }), error => error.code === 23);
  assert.equal(readFileSync(recorded, 'utf8').trim().split('\n').length, 1);
});

test('source snapshot identity probe observes selected and loaded component identities and fails closed', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-identity-' });
  const target = { ...posix, repoDir: join(root, 'repo'), cliHomeDir: join(root, 'home') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'controlled' });
  mkdirSync(paths.stackBaseDir, { recursive: true });
  const command = buildRemoteRuntimeSnapshotProbeCommand(target, {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot', services: { server: true, daemon: true },
  });
  const sourceUiLaunch = { uiDir: '/remote/server/source-export/ui' };
  for (const sourceRuntimeIdentities of [
    {}, { server: { selected: 'server-a', loaded: 'server-b' }, daemon: { selected: 'daemon-a', loaded: 'daemon-a' } },
    { server: { selected: 'server-a', loaded: 'server-a' }, daemon: { selected: '', loaded: '' } },
  ]) {
    writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities, sourceUi: 'export', sourceUiLaunch }));
    await assert.rejects(execFileAsync('/bin/bash', ['-c', command]));
  }
  const sourceRuntimeIdentities = { server: { selected: 'server-a', loaded: 'server-a' }, daemon: { selected: 'daemon-a', loaded: 'daemon-a' } };
  writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities, sourceUi: 'export', sourceUiLaunch }));
  const withUi = await execFileAsync('/bin/bash', ['-c', command]);
  assert.deepEqual(JSON.parse(withUi.stdout), { sourceRuntimeIdentities, sourceUi: 'export', sourceUiLaunch });
  const daemonProbe = buildRemoteRuntimeSnapshotProbeCommand(target, {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot', services: { daemon: true },
  });
  const daemonResult = await execFileAsync('/bin/bash', ['-c', daemonProbe]);
  assert.deepEqual(JSON.parse(daemonResult.stdout), { sourceRuntimeIdentities: { daemon: sourceRuntimeIdentities.daemon } });
  const preservedProbe = buildRemoteRuntimeSnapshotProbeCommand(target, {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot', services: { daemon: true }, includeDaemonServerUrl: true,
  });
  writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities,
    ports: { server: 43865 },
    serverConnection: { internalServerUrl: 'http://127.0.0.1:43001', publicServerUrl: 'https://home.example' } }));
  const preserved = await execFileAsync('/bin/bash', ['-c', preservedProbe]);
  assert.equal(JSON.parse(preserved.stdout).daemonServerUrl, 'http://127.0.0.1:43001', 'transport adoption observes the native daemon endpoint rather than allocating another');
  assert.equal(JSON.parse(preserved.stdout).serverPort, 43865,
    'a co-located server restart consumes its recorded private port separately from the daemon route');
  writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities, sourceUi: 'export' }));
  await assert.rejects(execFileAsync('/bin/bash', ['-c', command]));
  writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities }));
  await assert.rejects(execFileAsync('/bin/bash', ['-c', command]));
  writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities, sourceUi: 'disabled' }));
  await assert.rejects(execFileAsync('/bin/bash', ['-c', command]));
  for (const sourceUi of ['disabled', 'borrowed']) {
    const noExportProbe = buildRemoteRuntimeSnapshotProbeCommand(target, {
      stackName: 'agent-qa', runtimeMode: 'source-snapshot', services: { server: true, daemon: true }, sourceUi,
    });
    const noExportResult = await execFileAsync('/bin/bash', ['-c', noExportProbe]);
    assert.deepEqual(JSON.parse(noExportResult.stdout), { sourceRuntimeIdentities, sourceUi: 'disabled' });
  }
});

test('runtime identity probe reports actionable structured errors for absent, empty and invalid state', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-identity-unavailable-' });
  const target = { ...posix, cliHomeDir: root };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'source-snapshot' });
  mkdirSync(paths.stackBaseDir, { recursive: true });
  const statePath = join(paths.stackBaseDir, 'stack.runtime.json');
  const command = buildRemoteRuntimeSnapshotProbeCommand(target, {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot', services: { daemon: true },
  });
  for (const [raw, code] of [[null, 'runtime_state_missing'], ['', 'runtime_state_empty'], ['{invalid', 'runtime_state_invalid']]) {
    if (raw !== null) writeFileSync(statePath, raw);
    await assert.rejects(execFileAsync('/bin/bash', ['-c', command]), error => {
      const diagnostic = JSON.parse(error.stderr);
      assert.equal(diagnostic.ok, false);
      assert.equal(diagnostic.error.code, code);
      assert.equal(diagnostic.error.statePath, statePath);
      assert.equal(typeof diagnostic.error.recovery, 'string');
      return true;
    });
  }
});

test('source snapshot server placement exports its UI unless borrowed or disabled while daemon-only placement never exports', async t => {
  const options = {
    stackName: 'agent-qa', runtimeMode: 'source-snapshot',
    services: { server: true, expo: false, daemon: false }, remoteServerPort: 43001,
    serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    remoteServerRuntimeConfig: { serverComponentName: 'happier-server-light', dbProvider: 'sqlite', environment: {} },
  };
  for (const target of [posix, windows]) {
    const decode = command => target.platform === 'windows' ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    assert.match(decode(buildRemoteStackCommand(target, options)), /--ui=.*export/);
    assert.doesNotMatch(decode(buildRemoteStackCommand(target, options)), /--no-ui/);
    assert.doesNotMatch(decode(buildRemoteStackCommand(target, { ...options, borrowedExpoProducerStackName: 'repo-producer' })), /--no-ui/);
    for (const sourceUi of ['borrowed', 'disabled']) assert.match(decode(buildRemoteStackCommand(target, { ...options, sourceUi })), /--no-ui/);
    assert.match(decode(buildRemoteStackCommand(target, { ...options, services: { server: false, expo: false, daemon: true } })), /--no-ui/);
  }
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-export-mode-' });
  const target = { ...posix, repoDir: fixture.path('repo with spaces'), cliHomeDir: fixture.path('home'), remotePath: [fixture.path('bin')] };
  mkdirSync(target.repoDir, { recursive: true });
  // Replace only the external Stack process: execute the real remote shell and
  // pass its argv through the same parser, UI policy and server-env owners.
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!${process.execPath}\nif (process.argv[4] === 'start') process.stdout.write(JSON.stringify(process.argv.slice(2)));\n` });
  const paths = resolveRemoteStackStatePaths(target, options);
  const uiDir = join(paths.stackBaseDir, 'source-runtime/ui');
  for (const launch of [{}, { reuseSourceRuntime: true, sourceUiLaunch: { uiDir } }, { refreshSourceRuntime: true }]) {
    for (const sourceUi of ['export', 'borrowed', 'disabled']) {
      const { stdout } = await execFileAsync('/bin/bash', ['-c', buildRemoteStackCommand(target, { ...options, ...launch, sourceUi })]);
      const { flags, kv } = parseArgs(JSON.parse(stdout));
      const resolved = resolveSourceQaUiMode({ uiMode: kv.get('--ui'), noUi: flags.has('--no-ui'), consumerStackName: options.stackName });
      assert.equal(resolved, sourceUi === 'export' ? 'export' : 'disabled');
      const serverEnv = buildServerRuntimeEnv({ baseEnv: {}, serverPort: options.remoteServerPort,
        publicServerUrl: options.publicServerUrl, serveUi: resolved === 'export', uiRequired: resolved === 'export',
        uiBuildDir: kv.get('--source-ui-dir') ?? uiDir, uiBuildDirExists: true });
      assert.equal(serverEnv.HAPPIER_SERVER_UI_REQUIRED, sourceUi === 'export' ? '1' : undefined);
      assert.equal(serverEnv.HAPPIER_SERVER_UI_DIR, sourceUi === 'export' ? uiDir : undefined);
      assert.equal(serverEnv.HAPPIER_SERVER_LIGHT_UI_DIR, sourceUi === 'export' ? uiDir : undefined);
    }
  }
});

function installRemoteCustody(repoDir) {
  const directory = join(repoDir, 'apps/stack/scripts/utils/dev_targets');
  mkdirSync(directory, { recursive: true });
  copyFileSync(fileURLToPath(new URL('./remote_execution_custody.sh', import.meta.url)), join(directory, 'remote_execution_custody.sh'));
  copyFileSync(fileURLToPath(new URL('./native_execution_signals.sh', import.meta.url)), join(directory, 'native_execution_signals.sh'));
  mkdirSync(join(repoDir, 'apps/stack/scripts/utils/proc'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../proc/native_process_identity.sh', import.meta.url)), join(repoDir, 'apps/stack/scripts/utils/proc/native_process_identity.sh'));
  const hostState = join(repoDir, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh');
  if (!existsSync(hostState)) copyFileSync(fileURLToPath(new URL('../proc/native_host_admission_state.sh', import.meta.url)), hostState);
}

test('controlled remote stacks isolate CLI state and scratch and start the selected runtime without watch', () => {
  const options = {
    stackName: 'agent-qa', runtimeMode: 'controlled', runtimeSnapshotId: 'snapshot-x64',
    services: { server: true, expo: false, daemon: true }, remoteServerPort: 43001,
    serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    canonicalServerUrl: 'http://happier-agent-qa.localhost:3005',
    remoteServerRuntimeConfig: { serverComponentName: 'happier-server-light', dbProvider: 'sqlite', environment: {} },
  };
  const paths = resolveRemoteStackStatePaths(posix, options);
  assert.equal(paths.cliHomeDir, `${paths.stackBaseDir}/cli`);
  assert.equal(paths.workspaceDir, `${paths.stackBaseDir}/workspace`);
  assert.equal(paths.activeServerId, buildStackStableScopeId({ stackName: 'agent-qa', cliIdentity: 'default' }));
  const command = buildRemoteStackCommand(posix, options);
  assert.match(command, /stack start .*--runtime/);
  assert.match(command, /--no-dev-targets/);
  assert.doesNotMatch(command, /stack dev|--watch/);
  assert.ok(command.includes(paths.cliHomeDir));
  assert.ok(command.includes(paths.workspaceDir));
  assert.match(command, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=0/);
  assert.match(command, /HAPPIER_PUBLIC_SERVER_URL=http:\/\/127\.0\.0\.1:3005/);
  assert.match(command, /mkdir -p -- .*workspace/);
});

test('controlled writable state rejects the one-way source replica and accepts sibling paths on both platforms', () => {
  for (const target of [
    { ...posix, repoDir: '/remote/repo', cliHomeDir: '/remote/repo/.happier' },
    { ...windows, repoDir: 'C:/Remote/Repo', cliHomeDir: 'c:\\remote\\repo\\state' },
  ]) assert.throws(() => resolveRemoteStackStatePaths(target, { stackName: 'qa', runtimeMode: 'controlled' }), /outside.*source replica/);
  assert.ok(resolveRemoteStackStatePaths({ ...posix, repoDir: '/remote/repo', cliHomeDir: '/remote/repo-state' }, { stackName: 'qa', runtimeMode: 'controlled' }).workspaceDir);
});

test('controlled daemon-only commands reach the forwarded server without starting a server or UI', () => {
  for (const target of [posix, windows]) {
    const invocation = buildRemoteStackCommand(target, {
      stackName: 'agent-qa', runtimeMode: 'controlled', runtimeSnapshotId: 'daemon-linux',
      services: { server: false, expo: false, daemon: true },
      serverUrl: 'http://127.0.0.1:43001', publicServerUrl: 'http://127.0.0.1:3005',
    });
    const command = target.platform === 'windows'
      ? Buffer.from(invocation.split(' ').at(-1), 'base64').toString('utf16le')
      : invocation;
    assert.match(command, /--no-server/);
    assert.match(command, /--no-ui/);
    assert.ok(command.includes('http://127.0.0.1:43001'));
    assert.doesNotMatch(command, /--no-daemon/);
  }
});

test('dependency disk refusal stops generated remote bootstrap before installation', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-dependency-disk-ingress-' });
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  installRemoteCustody(repoDir);
  const trace = join(root, 'bootstrap-calls');
  // The OS process boundary supplies the disk owner's refusal. The generated
  // execution and custody path must preserve it before starting an installer.
  const { binDir } = writeFakeBin({ root, name: 'node', content: `#!/bin/sh
case "$1" in
  *worker_disk_budget.mjs) exit 76 ;;
  *) printf invoked >> "$BOOTSTRAP_CALLS"; exit 0 ;;
esac
` });
  const target = { ...posix, repoDir, cliHomeDir: join(root, 'home'), remotePath: [binDir, ...process.env.PATH.split(':')] };
  const command = buildRemoteExecCommand(target, { executionId,
    commandArgs: ['/usr/bin/true'], environment: { BOOTSTRAP_CALLS: trace },
    preparation: { bootstrap: true, validationKind: 'source-test' } });
  const result = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 76, result.stderr);
  await assert.rejects(access(trace), { code: 'ENOENT' });
});

test('preparation precedes payload admission, preserves cwd/env and stops on preparation failure', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-whole-operation-' });
  const { launcher } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  installRemoteCustody(checkout);
  mkdirSync(join(checkout, 'node_modules'), { recursive: true });
  writeFileSync(join(checkout, 'node_modules', 'data'), 'installed dependencies');
  mkdirSync(join(root, 'cli-home/cache/yarn/v6'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(checkout, 'apps/cli'), { recursive: true });
  chmodSync(launcher, 0o755);
  const executable = (name, body) => { writeFileSync(join(bin, name), '#!/bin/sh\n' + body + '\n'); chmodSync(join(bin, name), 0o755); };
  // Mock only OS tool/resource boundaries. The native admission logic is real.
  executable('uname', 'printf "Linux\\n"');
  executable('getconf', 'printf "8\\n"');
  executable('systemctl', 'exit 1');
  executable('awk', 'case "$*" in */proc/meminfo*) printf "25480397 28311552\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac');
  executable('node', `case "$*" in *service_memory.mjs*|*worker_disk_budget.mjs*|*workspace_build_admission.mjs*|*remote_commands.mjs*|*admission_client.mjs*|*admission_broker.mjs*) exec '${process.execPath}' "$@" ;; esac\n[ -z "$HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT" ] || exit 99\ncase "$*" in *remote_dependency_bootstrap*) stage=bootstrap ;; *) stage=prepare ;; esac\nprintf "%s\\n" "$stage" >> "$TRACE"\n[ "$FAIL_STAGE" != "$stage" ] || exit 42`);
  executable('probe-command', '[ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT" ] || exit 99\nprintf "payload:%s:%s\\n" "$PWD" "$VALUE" >> "$TRACE"');
  const localTarget = { ...posix, repoDir: checkout, cliHomeDir: join(root, 'cli-home'), remotePath: [bin, '/usr/bin', '/bin'] };
  const trace = join(root, 'trace');
  const request = failStage => buildRemoteExecCommand(localTarget, {
    executionId, cwd: 'apps/cli', commandArgs: ['probe-command'], admissionClass: 'targeted-validation',
    preparation: { bootstrap: true, componentRelativeDir: 'apps/cli', validationKind: 'runtime' },
    environment: { HOME: root, HAPPIER_STACK_CLI_HOME_DIR: join(root, 'admission-home'), TRACE: trace, VALUE: "literal '$value'", FAIL_STAGE: failStage,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
  });
  await execFileAsync('/bin/bash', ['-c', request('')], { env: buildNativeAdmissionFixtureEnv() });
  assert.equal(readFileSync(trace, 'utf8'), `bootstrap\nprepare\npayload:${checkout}/apps/cli:literal '$value'\n`);
  writeFileSync(trace, '');
  await assert.rejects(execFileAsync('/bin/bash', ['-c', request('bootstrap')], { env: buildNativeAdmissionFixtureEnv() }), error => error.code === 42);
  assert.equal(readFileSync(trace, 'utf8'), 'bootstrap\n');
  writeFileSync(trace, '');
  await assert.rejects(execFileAsync('/bin/bash', ['-c', request('prepare')], { env: buildNativeAdmissionFixtureEnv() }), error => error.code === 42);
  assert.equal(readFileSync(trace, 'utf8'), 'bootstrap\nprepare\n');
});

test('remote payload admission delegates finite publishers on the selected host', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'remote-finite-publisher-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  const checkout = join(root, 'native-owner');
  installRemoteCustody(checkout);
  const packageDir = join(checkout, 'packages/probe');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ scripts: {
    build: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json', unsafe: 'compiler',
    premixed: 'node ../../scripts/workspaces/buildTypeScriptPackageDist.mjs -p tsconfig.json',
    mixed: 'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
  } }));
  const lifecycle = join(root, 'mixed-lifecycle.mjs');
  const trace = join(root, 'mixed-parent.json');
  const foreignLock = join(root, 'foreign-publication.lock');
  const compilerRunner = fileURLToPath(new URL('../../../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url));
  writeFileSync(join(packageDir, 'input.ts'), 'export const value = 1;\n');
  writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], noEmit: true }, files: ['input.ts'] }));
  // Package-manager execution is the OS boundary. Its fixture preserves the
  // real prebuild publisher and canonical compiler runner beneath that boundary.
  writeFileSync(lifecycle, `
    import {writeFileSync} from 'node:fs';
    import {runWorkspaceBuildAdmission} from ${JSON.stringify(new URL('../proc/workspace_build_admission.mjs', import.meta.url).href)};
    import {runCommand} from ${JSON.stringify(new URL('../proc/proc.mjs', import.meta.url).href)};
    writeFileSync(${JSON.stringify(trace)}, JSON.stringify({admitted:Boolean(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT)}));
    const prepared=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e',''],
      locks:[{path:${JSON.stringify(foreignLock)}}],launcherPath:${JSON.stringify(native.launcher)},env:process.env});
    if(prepared.error || prepared.status!==0 || prepared.signal) throw prepared.error ?? new Error('prebuild did not complete');
    const compiled=await runCommand(process.execPath,[${JSON.stringify(compilerRunner)},'--noEmit','-p','tsconfig.json'],
      {cwd:${JSON.stringify(packageDir)},env:process.env,ownedProcessGroup:true,stdio:'inherit'});
    if(compiled.error || compiled.status!==0 || compiled.signal) throw compiled.error ?? new Error('compiler did not complete');
  `);
  writeFakeBin({ root, name: 'yarn', content: `#!/bin/sh
if [ "$1" = mixed ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(lifecycle)}; fi
printf "%s" "\${HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT:+reserved}"
` });
  const compilerFloorKiB = commandPolicy.resolveHeavyweightMemoryFloorKiB('compilation');
  writeFakeBin({ root, name: 'awk', content: `#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "${compilerFloorKiB} ${compilerFloorKiB}\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n` });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const target = { ...posix, repoDir: checkout, cliHomeDir: join(root, 'home'), remotePath: [join(root, 'bin'), '/usr/bin', '/bin'] };
  const request = script => buildRemoteExecCommand(target, { executionId, cwd: 'packages/probe', commandArgs: ['yarn', script], admissionClass: 'compilation', environment: {
    HOME: root, CI: '', HAPPIER_WORKSPACE_BUILD_MODE: 'strict', HAPPIER_DEV_TARGET_EXECUTION: script === 'mixed' ? '1' : '', HAPPIER_HSTACK_EXECUTION: '',
    HAPPIER_WORKSPACE_BUILD_STARTUP: '', HAPPIER_TYPECHECK_REPORT_DIR: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
  } });
  assert.equal((await execFileAsync('/bin/bash', ['-c', request('build')], { env: native.env })).stdout, '');
  assert.equal((await execFileAsync('/bin/bash', ['-c', request('unsafe')], { env: native.env })).stdout, 'reserved');
  let child, terminal, stderr = '';
  try {
    await withWorkspaceBundleLock(async () => {
      child = spawn('/bin/bash', ['-c', request('mixed')], { env: native.env });
      terminal = once(child, 'close');
      child.stderr.on('data', chunk => { stderr += chunk; });
      let waiting;
      while (child.exitCode === null && child.signalCode === null) {
        waiting = await requestAdmissionSample(native.admissionRoot);
        if (waiting.waitingCount === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(child.exitCode, null, stderr);
      assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), { admitted: false });
      assert.equal(waiting.activeCount, 0, 'waiting prebuild must not reserve the parent compiler envelope');
    }, { lockPath: foreignLock, env: native.env });
    assert.deepEqual(await terminal, [0, null], stderr);
    assert.equal((await requestAdmissionSample(native.admissionRoot)).activeCount, 0,
      'the compiler leaf releases its broker admission when it finishes');
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await terminal;
  }
});

test('remote Stack state paths use one canonical target CLI-home derivation', () => {
  const posixState = resolveRemoteStackStatePaths(
    { ...posix, cliHomeDir: '/home/dev/.happier/dev linux/' },
    { stackName: 'repo-local-dev' },
  );
  assert.equal(posixState.stackStorageDir, '/home/dev/.happier/dev linux/stack-state');
  assert.match(posixState.stackName, /^dev-target-linux-[a-f0-9]{16}$/);
  assert.notEqual(posixState.stackName, 'repo-local-dev');
  assert.equal(posixState.stackBaseDir, `/home/dev/.happier/dev linux/stack-state/${posixState.stackName}`);
  assert.equal(posixState.stackEnvPath, `${posixState.stackBaseDir}/env`);
  assert.equal(
    posixState.activeServerId,
    buildStackStableScopeId({ stackName: posixState.stackName, cliIdentity: 'default' }),
  );
  assert.notEqual(
    posixState.stackName,
    resolveRemoteStackStatePaths(posix, { stackName: 'repo-other-dev' }).stackName,
    'controller stacks sharing a target must retain separate target runtime identity',
  );

  const windowsState = resolveRemoteStackStatePaths(
    { ...windows, cliHomeDir: 'C:/Users/test qa/.happier/windows\\' },
    { stackName: 'repo-local-dev' },
  );
  assert.equal(windowsState.stackStorageDir, 'C:/Users/test qa/.happier/windows/stack-state');
  assert.match(windowsState.stackName, /^dev-target-windows-[a-f0-9]{16}$/);
  assert.notEqual(windowsState.stackName, 'repo-local-dev');
  assert.equal(windowsState.stackBaseDir, `C:/Users/test qa/.happier/windows/stack-state/${windowsState.stackName}`);
  assert.equal(windowsState.stackEnvPath, `${windowsState.stackBaseDir}/env`);
});

test('remote Stack stop needs only its canonical identity, not startup service options', () => {
  for (const target of [posix, windows]) {
    for (const runtimeMode of ['source', 'source-snapshot', 'controlled']) {
      const options = {
        stackName: 'agent-qa', runtimeMode,
        services: { server: true, expo: true, daemon: true },
      };
      const invocation = buildRemoteStackStopCommand(target, options);
      const command = target.platform === 'windows'
        ? Buffer.from(invocation.split(' ').at(-1), 'base64').toString('utf16le')
        : invocation;
      const paths = resolveRemoteStackStatePaths(target, options);
      assert.ok(command.includes(paths.cliHomeDir));
      assert.match(command, new RegExp(`stack stop .*${paths.stackName}.* --yes --no-docker`));
      assert.doesNotMatch(command, /stack new|stack env|--server-url|HAPPIER_STACK_SERVER_PORT|HAPPIER_STACK_EXPO_DEV_PORT/);
      assert.equal(invocation, buildRemoteStackStopCommand(target, { stackName: options.stackName, runtimeMode }));
      assert.doesNotMatch(command, /--preserve-daemon/);
      const preserveInvocation = buildRemoteStackStopCommand(target, { ...options, preserveDaemon: true });
      const preserveCommand = target.platform === 'windows'
        ? Buffer.from(preserveInvocation.split(' ').at(-1), 'base64').toString('utf16le') : preserveInvocation;
      assert.match(preserveCommand, /--preserve-daemon/);
      assert.throws(() => buildRemoteStackCommand(target, options), /remote server port/);
    }
  }
});

test('remote Stack retirement probe includes a live legacy Expo without runtime state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-remote-retirement-probe-'));
  const posixTarget = { ...posix, cliHomeDir: root,
    repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)) };
  const posixState = resolveRemoteStackStatePaths(posixTarget, { stackName: 'repo-local-dev' });
  const statePath = join(posixState.stackBaseDir, 'stack.runtime.json');
  try {
    const command = buildRemoteStackRetirementProbeCommand(posixTarget, { stackName: 'repo-local-dev' });

    assert.match(command, new RegExp(`stack-state/${posixState.stackName}/stack\\.runtime\\.json`));
    assert.doesNotMatch(command, /stack stop/);
    await execFileAsync('/bin/bash', ['-lc', command]);

    await execFileAsync('/bin/mkdir', ['-p', posixState.stackBaseDir]);
    await execFileAsync('/bin/sh', ['-c', "printf '%s\\n' '{}' > \"$1\"", 'sh', statePath]);
    await execFileAsync('/bin/bash', ['-lc', command]);

    rmSync(statePath);
    const expoStateDir = join(posixState.stackBaseDir, 'expo-dev', 'legacy');
    mkdirSync(expoStateDir, { recursive: true });
    const expoStatePath = join(expoStateDir, 'expo.state.json');
    writeFileSync(expoStatePath, JSON.stringify({ pid: process.pid, projectDir: '/recorded/ui' }));
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]), 'a live recorded Expo must require retirement even after its runner state vanished');
    writeFileSync(expoStatePath, JSON.stringify({ pid: 2147483647, projectDir: '/recorded/ui' }));
    await execFileAsync('/bin/bash', ['-lc', command]);

    const windowsState = resolveRemoteStackStatePaths(windows, { stackName: 'repo-local-dev' });
    const windowsCommand = buildRemoteStackRetirementProbeCommand(windows, {
      stackName: 'repo-local-dev',
    });
    const decodedWindows = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
    assert.match(decodedWindows, new RegExp(`stack-state/${windowsState.stackName}/stack\\.runtime\\.json`));
    assert.match(decodedWindows, /expo-dev/);
    assert.doesNotMatch(decodedWindows, /stack stop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote Stack retirement probe accepts rebooted runtime records but requires retirement of their surviving owned processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-remote-reboot-probe-'));
  const target = { ...posix, cliHomeDir: root, repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)) };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa-reboot', runtimeMode: 'source-snapshot' });
  const statePath = join(paths.stackBaseDir, 'stack.runtime.json');
  mkdirSync(paths.stackBaseDir, { recursive: true });
  let child;
  try {
    const command = buildRemoteStackRetirementProbeCommand(target, { stackName: 'agent-qa-reboot', runtimeMode: 'source-snapshot' });
    writeFileSync(statePath, JSON.stringify({ ownerPid: 2147483647, processes: { daemonPid: 2147483647 } }));
    await execFileAsync('/bin/bash', ['-lc', command]);
    writeFileSync(statePath, JSON.stringify({ ownerPid: process.pid, processes: { daemonPid: process.pid } }));
    await execFileAsync('/bin/bash', ['-lc', command]); // A live PID with another identity is not this Stack's runtime.
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env,
      HAPPIER_STACK_STACK: paths.stackName, HAPPIER_STACK_ENV_FILE: paths.stackEnvPath, HAPPIER_STACK_PROCESS_KIND: 'infra' } });
    await once(child, 'spawn');
    writeFileSync(statePath, JSON.stringify({ ownerPid: child.pid, processes: { daemonPid: child.pid } }));
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]), 'a surviving owned runtime is not retired');
    const preservedCommand = buildRemoteStackRetirementProbeCommand(target, {
      stackName: 'agent-qa-reboot', runtimeMode: 'source-snapshot', preserveDaemon: true,
    });
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', preservedCommand]), 'preservation still requires the controller to retire');
    writeFileSync(statePath, JSON.stringify({ ownerPid: null, processes: { daemonPid: child.pid, daemonPids: [child.pid] } }));
    await execFileAsync('/bin/bash', ['-lc', preservedCommand]);
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]), 'a later full stop must still see the preserved daemon');
    writeFileSync(statePath, JSON.stringify({ ownerPid: null, processes: { daemonPid: child.pid },
      stopRequest: { preserveDaemon: false, requestedBy: 'stack stop', reason: 'interrupted full stop' } }));
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', preservedCommand]),
      'preserving the daemon must complete the interrupted native stop before startup consumes its state');
    writeFileSync(statePath, JSON.stringify({ ownerPid: null, processes: { daemonPid: child.pid, serverPid: child.pid } }));
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', preservedCommand]), 'preservation does not exempt server retirement');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await execFileAsync('/bin/bash', ['-lc', command]);
    assert.equal(existsSync(statePath), true, 'absence observation must not mutate retained state');
    writeFileSync(statePath, '{invalid');
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]), 'unreadable runtime membership is not proof of retirement');
    for (const raw of ['', '{invalid']) {
      writeFileSync(statePath, raw);
      // A native host reboot cannot retain the prior runtime's processes.
      // Current-boot corruption above must still fail closed.
      utimesSync(statePath, new Date(0), new Date(0));
      await execFileAsync('/bin/bash', ['-lc', command]);
      assert.equal(readFileSync(statePath, 'utf8'), raw, 'reboot observation must not rewrite state');
    }
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote command classification keeps Git/index/worktree operations on the authority', () => {
  for (const args of [
    ['git', 'status'],
    ['/usr/bin/git', 'diff'],
    ['git', 'grep', 'needle'],
    ['git', 'worktree', 'list'],
  ]) {
    assert.deepEqual(classifyRemoteCommand(args), {
      placement: 'primary-only',
      commandClass: 'vcs-authority',
      requiresDependencyBootstrap: false,
    });
  }
  assert.deepEqual(classifyRemoteCommand(['rg', '-n', 'needle']), {
    placement: 'worker-eligible',
    commandClass: 'source-search',
    requiresDependencyBootstrap: false,
  });
});

test('lockfile-only installs are dependency input writers in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  for (const args of [
    ['pnpm', 'install', '--lockfile-only'],
    ['pnpm', 'i', '--lockfile-only', '--no-frozen-lockfile'],
    ['corepack', 'pnpm', '--dir', 'apps/stack', 'install', '--lockfile-only=true'],
    ['pnpm', '--lockfile-only', 'install'],
    ['pnpm.cmd', 'install', '--lockfile-only'],
    ['pnpm.exe', 'i', '--lockfile-only'],
    ['pnpm', 'install', '--no-lockfile-only', '--lockfile-only'],
  ]) await t.test(args.join(' '), () => {
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: root });
    assert.equal(policy.bootstrap, '0');
    assert.equal(policy.commandClass, 'dependency-input-writer');
    assert.equal(policy.placement, 'primary-only');
    assert.equal(policy.heavyClass, 'dependency-install');
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s,%s,%s" "$policy_bootstrap" "$policy_commandClass" "$policy_placement" "$policy_heavyClass"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '0,dependency-input-writer,primary-only,dependency-install');
    }
  });
  for (const args of [
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'install', '--no-frozen-lockfile'],
    ['pnpm', 'install', '--lockfile-only=false'],
    ['pnpm', 'install', '--lockfile-only', '--no-lockfile-only'],
    ['pnpm', 'run', 'install', '--lockfile-only'],
    ['npm', 'install', '--lockfile-only'],
    ['pnpm', 'install:custom', '--lockfile-only'],
  ]) await t.test(args.join(' '), () => {
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: root });
    assert.equal(policy.bootstrap, '1');
    assert.notEqual(policy.commandClass, 'dependency-input-writer');
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_bootstrap"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '1');
    }
  });
});

test('lockfile-only install policy does not expand a same-named lifecycle script', async t => {
  const fixture = await createTempFixture(t, { prefix: 'lockfile-only-lifecycle-policy-' });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, scripts: {
    install: 'node scripts/api-governance/cli.mjs --write',
  } }));
  const policy = await commandPolicy.resolvePackageCommandPolicy(['pnpm', 'install', '--lockfile-only'],
    { repoRoot: fixture.root, cwd: fixture.root });
  assert.equal(policy.commandClass, 'dependency-input-writer');
  assert.equal(policy.bootstrap, '0');
  assert.equal(policy.selfPublisher, '0');
});

test('remote command classification owns dependency bootstrap scope', () => {
  for (const args of [
    [],
    ['node', '-e', 'console.log("ok")'],
    ['nodejs', 'source-script.mjs'],
    ['rg', 'needle'],
    ['find', '.', '-name', '*.mjs'],
    ['git', 'status'],
    ['yarn', '--version'],
  ]) {
    assert.equal(classifyRemoteCommand(args).requiresDependencyBootstrap, false, args.join(' '));
    assert.equal(requiresRemoteDependencyBootstrap(args), false, args.join(' '));
  }
  for (const args of [
    ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
    ['yarn', 'custom:script'],
    ['npm', 'run', 'custom:script'],
    ['pnpm', '-C', 'apps/ui', 'run', 'build'],
    ['npx', 'vitest', 'run'],
    ['vitest', 'run'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['nodejs', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run'],
    ['nodejs', 'node_modules/vitest/vitest.mjs', 'run'],
    ['/usr/bin/node', '--test', 'owner.test.mjs'],
    ['node', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
    ['nodejs', '--test', '--test-name-pattern=owner', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
  ]) {
    assert.equal(classifyRemoteCommand(args).requiresDependencyBootstrap, true, args.join(' '));
    assert.equal(requiresRemoteDependencyBootstrap(args), true, args.join(' '));
  }
  assert.equal(classifyRemoteCommand(['node', '--test', 'scripts/owner.test.mjs'], { cwd: 'apps/stack' }).requiresDependencyBootstrap, true);
  assert.equal(classifyRemoteCommand(['node', '--test', 'scripts/owner.test.mjs'], { cwd: 'apps/stack2' }).requiresDependencyBootstrap, true);
});

test('proven SDK native source suites skip emitted preparation in both dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  const proven = [
    'actionFamilyPublication',
    'buildExampleProjects',
    'buildHostedHtmlGuestBootstrap',
    'capabilityMatrixMetadata',
    'externalSessionUserProjectionContract',
    'generateActionTypeMap',
    'projectCatalogMetadata',
    'publicDeclarationReport',
  ];
  const cases = proven.flatMap(name => [
    [root, ['node', '--test', `packages/plugin-sdk/scripts/${name}.test.mjs`], 'source-test'],
    [join(root, 'packages/plugin-sdk'), ['node', '--test', `scripts/${name}.test.mjs`], 'source-test'],
  ]);
  cases.push(
    [root, ['node', '--test', 'packages/plugin-sdk/scripts/packageInventory.test.mjs'], 'runtime'],
    [root, ['node', '--test', 'packages/plugin-sdk/scripts/unproven.test.mjs'], 'runtime'],
    [root, ['node', '--test', 'packages/plugin-sdk/scripts/actionFamilyPublication.test.mjs',
      'packages/plugin-sdk/scripts/packageInventory.test.mjs'], 'runtime'],
  );
  for (const [cwd, args, kind] of cases) {
    const policy = resolveRemoteCommandPolicy(args, { cwd });
    assert.equal(policy.kind, kind, args.join(' '));
    assert.equal(policy.validation, '1');
    assert.equal(requiresRemoteWorkspacePreparation(args, { cwd }), true);
    assert.equal(classifyRemoteCommand(args, { cwd }).commandClass, 'targeted-validation');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_validation" "$policy_bootstrap" "$policy_kind"',
      'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `1,${policy.bootstrap},${kind}`, args.join(' '));
  }
});

test('native source tests and generator checks use their real preparation contract', () => {
  const sdk = ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'];
  assert.equal(classifyRemoteCommand(sdk).requiresDependencyBootstrap, true);
  assert.equal(resolveRemoteValidationKind(sdk), 'source-test');
  // These owner suites load repository source modules and prepare their own
  // isolated fixtures; they do not consume Stack's emitted package closure.
  for (const path of [
    'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_validation_preparation.test.mjs',
    'apps/stack/scripts/utils/dev_targets/mutagen_project.test.mjs',
    'apps/stack/scripts/utils/dev_targets/qa_browser.test.mjs',
    'apps/stack/scripts/utils/proc/workspace_build_admission.test.mjs',
    'apps/stack/scripts/utils/test/test_process.test.mjs',
    'apps/stack/scripts/utils/dev_targets/remote_commands.test.mjs',
    'apps/stack/scripts/build/build_source_runtime.test.mjs',
    'apps/stack/scripts/runtime/shared/pending_source_start.test.mjs',
    'apps/stack/scripts/runtime/launch/resolveLaunchSpecs.test.mjs',
  ]) {
    const args = ['node', '--test', path];
    assert.equal(classifyRemoteCommand(args).requiresDependencyBootstrap, true);
    assert.equal(resolveRemoteValidationKind(args), 'source-test');
    assert.equal(resolveRemoteValidationKind(['node', '--test', path.slice('apps/stack/'.length)], { cwd: 'apps/stack' }), 'source-test');
    if (process.platform !== 'win32') {
      // Execute the shipped projection at its shell/platform boundary too.
      const root = fileURLToPath(new URL('../../../../../', import.meta.url));
      const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_bootstrap" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '1,source-test');
    }
  }
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs']), 'runtime');
  assert.equal(requiresRemoteWorkspacePreparation(['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs']), true);
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'unknown.test.mjs']), 'runtime');
  assert.equal(resolveRemoteValidationKind(['node', '--test', 'apps/stack/scripts/config.test.mjs']), 'runtime');
  const generator = ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'];
  assert.equal(classifyRemoteCommand(generator).commandClass, 'targeted-validation');
  assert.equal(requiresRemoteWorkspacePreparation(generator), true);
  assert.equal(classifyRemoteCommand(['node', '--experimental-strip-types', 'other/generateBundledPluginEntries.ts', '--mode', 'check']).commandClass, 'unclassified');
  assert.equal(classifyRemoteCommand(['tsc', '-p', 'apps/cli/tsconfig.json']).commandClass, 'targeted-validation');
});

test('the UI Vitest tool source keepers admit dependencies without emitted workspace preparation', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
  for (const [cwd, path] of [
    [root, 'apps/ui/scripts/runVitestShards.test.mjs'],
    [join(root, 'apps/ui'), 'scripts/runVitestShards.test.mjs'],
    [root, 'apps/ui/scripts/activitySurfacesValidationContract.test.mjs'],
    [join(root, 'apps/ui'), 'scripts/activitySurfacesValidationContract.test.mjs'],
  ]) {
    const args = ['node', '--test', path];
    const policy = resolveRemoteCommandPolicy(args, { cwd, repoRoot: root });
    assert.equal(policy.kind, 'source-test', 'the keeper loads authored tools and external Vitest, not emitted workspaces');
    assert.equal(policy.bootstrap, '1');
    assert.equal(policy.heavyClass, 'validation');
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$3; shift 3; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_kind" "$policy_bootstrap" "$policy_heavyClass"', 'policy', artifact, root, cwd, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'source-test,1,validation');
    }
  }
  for (const path of ['apps/ui/scripts/unknown.test.mjs', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs', 'apps/ui/scripts/runActivitySurfacesCertification.test.mjs']) {
    const args = ['node', '--test', path];
    assert.equal(resolveRemoteCommandPolicy(args, { cwd: root, repoRoot: root }).kind, 'runtime');
    if (process.platform !== 'win32') {
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'runtime');
    }
  }
});

test('source-condition lifecycle fixtures admit authored exports without Stack publication', () => {
  for (const path of [
    'apps/ui/scripts/metroNativeBundleResponse.test.mjs',
    'apps/stack/scripts/iroh_relay.integration.test.mjs',
    'apps/stack/scripts/utils/server/infra/iroh/listener.test.mjs',
    'apps/stack/scripts/utils/dev/expo_dev_crash_supervision.test.mjs',
    'apps/stack/scripts/preferred_execution_launcher.test.mjs',
    'apps/stack/scripts/utils/dev_targets/service_placement.test.mjs',
    'apps/stack/scripts/dev_targets_cmd.test.mjs',
    'apps/stack/scripts/daemon_start_verification.integration.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_command.test.mjs',
    'apps/stack/scripts/stack/stack_daemon_runtime_provenance.test.mjs',
    'apps/stack/scripts/stack_daemon_cmd.integration.test.mjs',
    'apps/stack/scripts/utils/stack/daemonControlClient.test.mjs',
  ]) {
    const args = ['node', '--conditions=happier-source', '--import', 'tsx', '--test', path];
    assert.equal(resolveRemoteValidationKind(args), 'source-test', path);
    assert.equal(resolveRemoteValidationKind(args.filter(arg => arg !== '--conditions=happier-source')), 'runtime',
      'default Node exports still consume emitted workspace code');
    if (process.platform !== 'win32') {
      const root = fileURLToPath(new URL('../../../../../', import.meta.url));
      const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_bootstrap" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '1,source-test');
    }
  }
  assert.equal(resolveRemoteValidationKind(['node', '--conditions=happier-source', '--import', 'tsx', '--test',
    'apps/stack/scripts/config.test.mjs']), 'runtime', 'unknown suite closures are not assumed source-only');
});

test('remote command classification admits generated workspace preparation only for validation commands', () => {
  for (const args of [
    ['vitest', 'run'],
    ['corepack', 'yarn', '-s', 'test:unit:local'],
    ['tsc', '--noEmit'],
    ['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['yarn', '-s', 'typecheck:local'],
    ['yarn', '-s', 'tsc'],
    ['nodejs', '../../scripts/workspaces/runTypeScriptCli.mjs', '-p', 'tsconfig.json'],
    ['corepack', 'yarn', '--cwd', 'apps/ui', 'typecheck'],
  ]) {
    assert.equal(requiresRemoteWorkspacePreparation(args, { cwd: 'apps/cli' }), true);
  }

  assert.equal(
    requiresRemoteWorkspacePreparation(['corepack', 'yarn', '-s', 'typecheck:local'], { cwd: '.' }),
    false,
    'repository-root scripts retain ownership of their declared build pipeline',
  );
  assert.equal(requiresRemoteWorkspacePreparation(['rg', '-n', 'needle'], { cwd: 'apps/cli' }), false);
  assert.equal(requiresRemoteWorkspacePreparation(['node', 'script.mjs'], { cwd: 'apps/cli' }), false);
});

test('source-test classification follows the configured resolver contract rather than test filenames', () => {
  const assertCliKind = (args, expected) => {
    assert.equal(resolveRemoteValidationKind(args, { cwd: 'apps/cli' }), expected, JSON.stringify(args));
    if (process.platform === 'win32') return;
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/cli; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, expected, `native ${JSON.stringify(args)}`);
  };
  for (const args of [
    ['corepack', 'yarn', '-s', 'vitest', 'run', 'arbitrary.test.ts'],
    ['corepack', 'yarn', '-s', 'vitest', 'run', 'src/plugins/authoring/bundleDaemonRuntime.test.ts'],
    ['vitest', 'run', '--config=vitest.config.ts', 'artifact-named.test.ts'],
    ['corepack', 'yarn', '-s', 'vitest:local', 'run', '--config=vitest.source.integration.config.ts', 'src/api/apiMachine.preflightCatalogs.runtimeCatalog.integration.test.ts'],
    ['vitest', 'run', '--config', 'vitest.inMemory.config.ts', 'selected.test.ts'],
    ['corepack', 'yarn', '-s', 'vitest:local', 'run', '--config=vitest.inMemory.config.ts', 'selected.test.ts'],
  ]) {
    assertCliKind(args, 'source-test');
  }
  for (const args of [
    ['vitest', 'run', '--config', 'vitest.integration.config.ts'],
    ['corepack', 'yarn', '-s', 'vitest', 'run', '--config=vitest.integration.config.ts', 'src/plugins/authoring/bundleDaemonRuntime.integration.test.ts'],
    ['vitest', 'run', '--config=unknown.config.ts'],
    ['vitest', 'run', '--root=../ui'],
    ['vitest', 'run', '--workspace', 'custom.workspace.ts'],
    ['vitest', 'run', '--project=artifact'],
    ['vitest', 'run', '-r../ui'],
    ['corepack', 'yarn', '-s', 'vitest:artifact'],
    ['vitest', 'run', '--config=vitest.inMemory.config.ts', '--root=../ui', 'selected.test.ts'],
    ['vitest', 'run', '--config=vitest.inMemory.config.ts', '--workspace=custom.workspace.ts', 'selected.test.ts'],
    ['vitest', 'run', '--config=vitest.inMemory.config.ts', '--project=artifact', 'selected.test.ts'],
    ['vitest', 'run', '--config=vitest.inMemory.config.ts', '-r../ui', 'selected.test.ts'],
  ]) assertCliKind(args, 'runtime');
  assert.equal(resolveRemoteValidationKind(['vitest', 'run'], { cwd: 'apps/ui' }), 'source-test');
  for (const args of [
    ['vitest', 'run', '--config', 'vitest.integration.config.ts'],
    ['corepack', 'yarn', '-s', 'vitest:local', 'run', '--config=vitest.integration.config.ts'],
  ]) {
    assert.equal(resolveRemoteValidationKind(args, { cwd: 'apps/ui' }), 'source-test');
    if (process.platform !== 'win32') {
      const root = fileURLToPath(new URL('../../../../../', import.meta.url));
      const artifact = fileURLToPath(new URL('./native_command_policy.sh', import.meta.url));
      const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2/apps/ui; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_bootstrap" "$policy_kind"', 'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, '1,source-test');
    }
  }
  assert.equal(resolveRemoteValidationKind(['vitest', 'run', '--config=vitest.integration.config.ts', '--root=../cli'], { cwd: 'apps/ui' }), 'runtime');
  assert.equal(resolveRemoteValidationKind(['vitest', 'run', '--config=vitest.source.integration.config.ts'], { cwd: 'apps/ui' }), 'runtime');
  assert.equal(resolveRemoteValidationKind(
    ['node', '../../../node_modules/vitest/vitest.mjs', 'run', '--config=vitest.config.ts'],
    { cwd: 'packages/plugins/triage' },
  ), 'source-test');
  assert.equal(resolveRemoteValidationKind(
    ['vitest', 'run', '--config=vitest.integration.config.ts'],
    { cwd: 'packages/plugins/triage' },
  ), 'runtime');
});

test('explicit admission retains UI and CLI payload preparation and its declared resource class', () => {
  for (const [component, script, resourceClass, heavyClass] of [
    ['apps/ui', 'vitest', 'targeted-validation', 'validation'],
    ['apps/cli', 'typecheck', 'compilation', 'compilation'],
  ]) {
    const payload = ['corepack', 'yarn', '--cwd', component, '-s', script];
    const wrapped = ['apps/stack/bin/hstack-exec', '--heavyweight-admission',
      `--class=${resourceClass}`, '--no-wait', '--', ...payload];
    const policy = resolveRemoteCommandPolicy(wrapped);
    assert.equal(policy.bootstrap, '1', `${component} preparation must precede the admitted payload`);
    assert.equal(policy.component, component);
    assert.equal(policy.kind, resolveRemoteValidationKind(payload));
    assert.equal(policy.commandClass, 'targeted-validation');
    assert.equal(policy.heavyClass, heavyClass);
    assert.equal(requiresRemoteWorkspacePreparation(wrapped), true);
  }
  for (const options of [['--unsupported-option'], []]) {
    const wrapped = ['hstack-exec', '--heavyweight-admission', ...options,
      '--class=targeted-validation', '--', 'bash', '-c', 'corepack yarn --cwd apps/ui vitest'];
    const policy = resolveRemoteCommandPolicy(wrapped);
    assert.equal(policy.bootstrap, '0', 'arbitrary shell bodies are not preparation inputs');
    assert.equal(policy.component, '.');
    assert.equal(policy.commandClass, 'full-validation');
    assert.equal(policy.heavyClass, 'validation');
  }
  const unsupported = resolveRemoteCommandPolicy(['hstack-exec', '--heavyweight-admission',
    '--unsupported-option', '--class=targeted-validation', '--',
    'corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'vitest']);
  assert.equal(unsupported.bootstrap, '0', 'unsupported wrapper flags cannot admit a payload');
  assert.equal(unsupported.component, '.');
});

test('public source shard entrypoints retain source preparation through admission and cwd expansion', () => {
  for (const [payload, cwd, component] of [
    [['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'test:unit'], '.', 'apps/ui'],
    [['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'test:unit'], '.', 'apps/cli'],
    [['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'test:unit:vitest'], '.', 'apps/cli'],
    [['node', 'apps/ui/scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], '.', 'apps/ui'],
    [['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], 'apps/cli', 'apps/cli'],
    [['node', 'scripts/runVitestShards.mjs', '--config', 'vitest.integration.config.ts'], 'apps/ui', 'apps/ui'],
    [['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], '.', 'apps/ui'],
  ]) {
    const args = ['apps/stack/bin/hstack-exec', '--heavyweight-admission',
      '--class=targeted-validation', '--', ...payload];
    assert.equal(resolveRemoteValidationKind(args, { cwd }), 'source-test', payload.join(' '));
    assert.equal(resolveRemoteValidationComponentRelativeDir(args, { cwd }), component);
    assert.equal(requiresRemoteDependencyBootstrap(args, { cwd }), true);
  }
  for (const [args, cwd] of [
    [['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'test:unit', '--config', 'vitest.integration.config.ts'], '.'],
    [['node', 'scripts/runVitestShards.mjs', '--config', 'vitest.artifact-cache.config.ts'], 'apps/ui'],
    [['node', 'custom/runVitestShards.mjs', '--config', 'vitest.config.ts'], 'apps/ui'],
    [['node', 'scripts/runVitestShards.mjs'], 'apps/stack'],
  ]) assert.equal(resolveRemoteValidationKind(args, { cwd }), 'runtime', args.join(' '));
});

test('remote command classification admits declaration preparation for package-manager component cwd', () => {
  assert.equal(requiresRemoteWorkspacePreparation(
    ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], { cwd: '.' },
  ), true);
  assert.equal(requiresRemoteWorkspacePreparation(
    ['yarn', '--cwd=packages/plugin-sdk', '-s', 'typecheck'], { cwd: '.' },
  ), true);
});

test('Windows directory bootstrap retires only Mutagen agents whose SSH owner is gone', () => {
  const command = buildRemoteEnsureDirectoriesCommand(windows);
  const decodedPowerShell = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');

  assert.match(decodedPowerShell, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(decodedPowerShell, /Name = 'mutagen-agent\.exe'/);
  assert.match(decodedPowerShell, /SilentlyContinue\);\s+foreach \(\$agent/);
  assert.match(decodedPowerShell, /Get-Process -Id \$sshParentPid/);
  assert.match(decodedPowerShell, /taskkill\.exe \/PID .* \/T \/F/);
  assert.match(
    decodedPowerShell,
    /if \(-not \(Get-Process -Id \$sshParentPid.*\)\).*taskkill\.exe/s,
    'an active SSH parent must prevent cleanup of its Mutagen agent tree',
  );
  assert.match(decodedPowerShell, /New-Item -ItemType Directory -Force/);
});

test('remote doctor checks prerequisites without changing the target', () => {
  const posixCommand = buildRemoteDoctorCommand({
    ...posix,
    remotePath: ['/Users/dev/.nvm/versions/node/v22/bin', '/opt/homebrew/bin'],
  });
  assert.match(posixCommand, /export PATH=.*nvm.*homebrew.*PATH/);
  assert.match(posixCommand, /command -v node/);
  assert.match(posixCommand, /command -v npm/);
  assert.match(posixCommand, /command -v rg/);
  assert.doesNotMatch(posixCommand, /pnpm install/);

  const windowsCommand = buildRemoteDoctorCommand({
    ...windows,
    remotePath: ['C:/Users/test qa/node', 'C:/Program Files/ripgrep'],
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:PATH = .*node.*ripgrep.*PathSeparator.*\$env:PATH/);
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command npm/);
  assert.match(decodedPowerShell, /Get-Command rg/);
  assert.doesNotMatch(decodedPowerShell, /pnpm install/);
});

test('remote daemon readiness probe requires a live pid from the server-scoped state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hstack-daemon-readiness-'));
  const target = { ...posix, cliHomeDir: root };
  const stackName = 'repo-local-dev';
  const { activeServerId } = resolveRemoteStackStatePaths(target, { stackName });
  const serverDir = join(root, 'servers', activeServerId);
  try {
    await execFileAsync('/bin/mkdir', ['-p', serverDir]);
    const statePath = join(serverDir, 'daemon.state.json');
    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":${process.pid}}' > "$1"`, 'sh', statePath]);
    const command = buildRemoteDaemonReadinessProbeCommand(target, { stackName });
    await execFileAsync('/bin/bash', ['-lc', command]);

    await execFileAsync('/bin/sh', ['-c', `printf '%s\\n' '{"pid":99999999}' > "$1"`, 'sh', statePath]);
    await assert.rejects(execFileAsync('/bin/bash', ['-lc', command]));

    const windowsCommand = buildRemoteDaemonReadinessProbeCommand(windows, { stackName });
    const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
    assert.match(decodedPowerShell, /daemon\.state\.json/);
    assert.match(decodedPowerShell, /ConvertFrom-Json/);
    assert.match(decodedPowerShell, /Get-Process -Id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote exec validates repo-relative cwd and preserves POSIX argument and env boundaries', () => {
  const target = posix;
  const command = buildRemoteExecCommand(target, {
    executionId,
    cwd: 'apps/cli',
    commandArgs: ['rg', '-n', "a'b", 'src'],
    environment: { CI: '1', HAPPIER_TEST_LABEL: "agent's run" },
  });

  assert.match(command, /cd -- .*\/home\/dev\/Happier repo\/apps\/cli/);
  assert.match(command, /export CI=.*1/);
  assert.match(command, /export HAPPIER_TEST_LABEL=.*agent.*s run/);
  assert.match(command, /exec .*rg.*-n.*a.*b.*src/);
  assert.throws(
    () => buildRemoteExecCommand(target, { executionId, cwd: '../outside', commandArgs: ['pwd'] }),
    /working directory must stay inside the synchronized repository/i,
  );
});

test('remote classification recognizes direct native TypeScript and nested launcher validation', () => {
  assert.deepEqual(
    classifyRemoteCommand(['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], { cwd: 'apps/ui' }),
    { placement: 'worker-eligible', commandClass: 'targeted-validation', requiresDependencyBootstrap: true },
  );
  assert.deepEqual(
    classifyRemoteCommand(['apps/stack/bin/hstack-exec', '--local', '--', 'sh', '-lc', 'typecheck']),
    { placement: 'worker-eligible', commandClass: 'full-validation', requiresDependencyBootstrap: false },
  );
});

test('remote exec POSIX shell layer preserves live native argument boundaries', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-arguments-' });
  installRemoteCustody(root);
  const command = buildRemoteExecCommand(
    { ...posix, repoDir: root, cliHomeDir: join(root, 'home') },
    {
      executionId,
      commandArgs: ['/usr/bin/printf', '<%s>\n', "a'b", 'two words', 'quote"double'],
    },
  );
  const result = await execFileAsync('/bin/bash', ['-c', command]);
  assert.equal(result.stdout, '<a\'b>\n<two words>\n<quote"double>\n');
});

test('remote exec preserves Windows argument and cwd boundaries', () => {
  const command = buildRemoteExecCommand(windows, {
    executionId,
    cwd: 'apps/cli',
    commandArgs: ['rg.exe', '-n', "a'b", 'say "hello"', 'src'],
    environment: { CI: '1' },
  });

  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  assert.doesNotMatch(command, /a'b/);
  const decodedPowerShell = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(decodedPowerShell, /'say \\"hello\\"'/);
});

test('Windows remote exec publishes an execution-scoped process identity and removes it on normal exit', () => {
  const windowsCommand = buildRemoteExecCommand(windows, {
    executionId,
    commandArgs: ['long-test.exe'],
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, new RegExp(`${executionId}\\.pid`));
  assert.match(decodedPowerShell, /Get-Process -Id \$PID/);
  assert.match(decodedPowerShell, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(decodedPowerShell, /finally .*Remove-Item/s);
});

test('Windows remote cancellation targets only the recorded execution identity and its descendants', () => {
  const windowsCancel = buildRemoteCancelCommand(windows, { executionId });
  const decodedPowerShell = Buffer.from(windowsCancel.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, new RegExp(`${executionId}\\.pid`));
  assert.match(decodedPowerShell, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(decodedPowerShell, /taskkill\.exe \/PID \$remoteProcessId \/T \/F/);
});

test('POSIX remote cancellation terminates the live execution tree and removes its identity file', async (t) => {
  try {
    await execFileAsync('/bin/ps', ['-p', String(process.pid), '-o', 'command=']);
  } catch (error) {
    if (error?.code === 'EPERM' || /operation not permitted/i.test(String(error?.stderr ?? error?.message ?? error))) {
      t.skip('local process inspection is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const root = mkdtempSync(join(tmpdir(), 'happier-remote-cancel-'));
  installRemoteCustody(root);
  const liveTarget = {
    ...posix,
    repoDir: root,
    cliHomeDir: join(root, 'home'),
  };
  const childPidFile = join(root, 'child.pid');
  const identityFile = join(liveTarget.cliHomeDir, 'remote-exec', `${executionId}.pid`);
  const command = buildRemoteExecCommand(liveTarget, {
    executionId,
    commandArgs: [
      '/bin/bash',
      '-lc',
      `printf '%s\\n' "$$" > '${childPidFile}'; while :; do sleep 1; done`,
    ],
  });
  const child = spawn('/bin/bash', ['-c', command], { stdio: 'ignore' });
  const completion = new Promise((resolve) => child.once('close', resolve));

  try {
    const deadline = Date.now() + 5_000;
    while ((!existsSync(identityFile) || !existsSync(childPidFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(identityFile), true, 'remote wrapper must publish its identity');
    assert.equal(existsSync(childPidFile), true, 'remote child must be running before cancellation');
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());

    await execFileAsync('/bin/bash', ['-c', buildRemoteCancelCommand(liveTarget, { executionId })]);
    let timeout;
    try {
      await Promise.race([
        completion,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('remote wrapper did not exit')), 10_000);
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(identityFile), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await completion;
    rmSync(root, { recursive: true, force: true });
  }
});

test('POSIX remote execution forwards wrapper termination to its live command tree', async (t) => {
  try {
    await execFileAsync('/bin/ps', ['-p', String(process.pid), '-o', 'command=']);
  } catch (error) {
    if (error?.code === 'EPERM' || /operation not permitted/i.test(String(error?.stderr ?? error?.message ?? error))) {
      t.skip('local process inspection is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const root = mkdtempSync(join(tmpdir(), 'happier-remote-signal-'));
  installRemoteCustody(root);
  const liveTarget = {
    ...posix,
    repoDir: root,
    cliHomeDir: join(root, 'home'),
  };
  const childPidFile = join(root, 'child.pid');
  const identityFile = join(liveTarget.cliHomeDir, 'remote-exec', `${executionId}.pid`);
  const command = buildRemoteExecCommand(liveTarget, {
    executionId,
    commandArgs: [
      '/bin/bash',
      '-lc',
      `printf '%s\\n' "$$" > '${childPidFile}'; while :; do sleep 1; done`,
    ],
  });
  const child = spawn('/bin/bash', ['-c', command], { stdio: 'ignore' });
  const completion = new Promise((resolve) => child.once('close', resolve));
  let commandPid = null;

  try {
    const deadline = Date.now() + 5_000;
    while ((!existsSync(identityFile) || !existsSync(childPidFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(identityFile), true, 'remote wrapper must publish its identity');
    assert.equal(existsSync(childPidFile), true, 'remote child must be running before termination');
    const wrapperPid = Number(readFileSync(identityFile, 'utf8').split('\n')[0]);
    commandPid = Number(readFileSync(childPidFile, 'utf8').trim());

    process.kill(wrapperPid, 'SIGTERM');
    let timeout;
    try {
      await Promise.race([
        completion,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('remote wrapper did not exit after SIGTERM')), 10_000);
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.throws(() => process.kill(commandPid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(identityFile), false);
  } finally {
    if (commandPid != null) {
      try { process.kill(commandPid, 'SIGKILL'); } catch { }
    }
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await completion;
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote execution ids are mandatory and path-safe', () => {
  assert.throws(
    () => buildRemoteExecCommand(posix, { commandArgs: ['pwd'] }),
    /execution id/i,
  );
  assert.throws(
    () => buildRemoteCancelCommand(posix, { executionId: '../other' }),
    /execution id/i,
  );
});

test('remote daemon launch projects the controller latency switch on POSIX and Windows', () => {
  for (const target of [posix, windows]) {
    for (const setting of ['1', '']) {
      const command = buildRemoteStackCommand(target, {
        services: { server: false, expo: false, daemon: true },
        serverUrl: 'http://127.0.0.1:43005', stackName: 'remote-qa',
        env: { HAPPIER_WEB_LATENCY_TRACE: setting, UNRELATED_SETTING: 'excluded-value' },
      });
      const rendered = target.platform === 'windows'
        ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
      assert.ok(rendered.includes(`HAPPIER_WEB_LATENCY_TRACE=${setting}`));
      assert.doesNotMatch(rendered, /UNRELATED_SETTING|excluded-value/);
    }
  }
  for (const target of [posix, windows]) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: true },
      serverUrl: 'http://127.0.0.1:43005', publicServerUrl: 'https://qa.example.test',
      remoteServerPort: 43005, stackName: 'remote-qa', env: {},
      remoteServerRuntimeConfig: { serverComponentName: 'happier-server-light', dbProvider: 'sqlite',
        environment: { HAPPIER_WEB_LATENCY_TRACE: '1' } },
    });
    const rendered = target.platform === 'windows'
      ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    assert.match(rendered, /HAPPIER_WEB_LATENCY_TRACE=1/);
    assert.equal([...rendered.matchAll(/HAPPIER_WEB_LATENCY_TRACE=/gu)].length, 1,
      'co-located services must consume one trace setting without a later daemon override');
  }
});

test('remote daemon launch carries the operator guest CLI payload root only when the Stack sets it', () => {
  for (const target of [posix, windows]) {
    const render = (env) => {
      const command = buildRemoteStackCommand(target, {
        services: { server: false, expo: false, daemon: true },
        serverUrl: 'http://127.0.0.1:43005', stackName: 'remote-qa', env,
      });
      return target.platform === 'windows'
        ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    };
    assert.ok(render({ HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: '/srv/qa/payload' })
      .includes('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT=/srv/qa/payload'));
    assert.doesNotMatch(render({}), /HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT/);
  }
});

test('remote daemon command reuses the Stack dev owner and adopts a last-green daemon on reconnect', () => {
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: 'repo-local-dev' }).stackName;
  const command = buildRemoteDaemonCommand(posix, {
    serverUrl: 'http://127.0.0.1:43005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  assert.match(
    command,
    new RegExp(`pnpm --filter @happier-dev/stack run stack dev .*${posixRemoteStack}.* --no-server --no-ui --no-browser --no-dev-targets --watch`),
  );
  assert.doesNotMatch(command, /--restart/);
  assert.match(command, new RegExp(`stack new .*${posixRemoteStack}.*--if-missing`));
  assert.match(command, new RegExp(`stack env .*${posixRemoteStack}.* set`));
  assert.match(command, /HAPPIER_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(command, /HAPPIER_STACK_STORAGE_DIR/);
  assert.match(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*\.happier\/dev linux\/cache/);
  assert.doesNotMatch(command, /HAPPIER_STACK_PM_CACHE_BASE_DIR=.*HOME.*\/\.cache/);
  assert.match(command, /HAPPIER_STACK_STACK/);
  assert.match(command, /HAPPIER_ACTIVE_SERVER_ID/);
  assert.match(command, /http:\/\/127\.0\.0\.1:43005/);
  assert.doesNotMatch(command, /stack stop/);
  assert.doesNotMatch(command, /pnpm run dev /);

  const windowsRemoteStack = resolveRemoteStackStatePaths(windows, { stackName: 'repo-local-dev' }).stackName;
  const windowsCommand = buildRemoteDaemonCommand(windows, {
    serverUrl: 'http://127.0.0.1:43105',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
  });
  const decodedPowerShell = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_HOME_DIR/);
  assert.match(decodedPowerShell, /\$env:HAPPIER_STACK_CLI_HOME_DIR/);
  assert.match(
    decodedPowerShell,
    /\$env:HAPPIER_STACK_PM_CACHE_BASE_DIR = 'C:\/Users\/test qa\/\.happier\/windows\/cache'/,
  );
  assert.match(decodedPowerShell, new RegExp(`\\$env:HAPPIER_STACK_STACK = '${windowsRemoteStack}'`));
  assert.match(
    decodedPowerShell,
    new RegExp(`pnpm --filter @happier-dev/stack run stack dev '${windowsRemoteStack}' --no-server --no-ui --no-browser --no-dev-targets --watch`),
  );
  assert.doesNotMatch(decodedPowerShell, /stack stop/);
  assert.doesNotMatch(decodedPowerShell, /--restart/);
  assert.match(decodedPowerShell, new RegExp(`stack new '${windowsRemoteStack}'.*--if-missing`));
  assert.match(decodedPowerShell, new RegExp(`stack env '${windowsRemoteStack}'.* set`));
});

test('remote lifecycle retirement is a separate lightweight command before the long-lived worker', () => {
  const options = {
    services: { server: false, expo: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteExpoPort: 48081,
    expoPublicUrl: 'http://192.168.1.20:18081',
    startMobile: true,
  };

  const stopCommand = buildRemoteStackStopCommand(posix, options);
  const workerCommand = buildRemoteStackCommand(posix, options);
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: options.stackName }).stackName;
  assert.match(stopCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES=.*0/);
  assert.match(stopCommand, new RegExp(`stack stop .*${posixRemoteStack}.* --yes --no-docker`));
  assert.doesNotMatch(stopCommand, /stack new/);
  assert.doesNotMatch(stopCommand, /stack env/);
  assert.doesNotMatch(stopCommand, /stack dev/);
  assert.doesNotMatch(workerCommand, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES/);
  assert.doesNotMatch(workerCommand, /stack stop/);
  assert.match(workerCommand, /HAPPIER_STACK_HOME_DIR/);
  assert.match(workerCommand, new RegExp(`stack new .*${posixRemoteStack}.*--if-missing`));
  assert.match(workerCommand, new RegExp(`stack env .*${posixRemoteStack}.* set`));
  assert.ok(
    workerCommand.indexOf('stack new') < workerCommand.indexOf('stack env')
      && workerCommand.indexOf('stack env') < workerCommand.indexOf('stack dev'),
    'the Stack lifecycle owner must create-or-preserve, then project target configuration, before dev',
  );
  assert.doesNotMatch(workerCommand, /printf '%s\\n'.*stack-state/);
  assert.match(workerCommand, new RegExp(`stack dev .*${posixRemoteStack}`));

  const windowsStopCommand = buildRemoteStackStopCommand(windows, options);
  const windowsRemoteStack = resolveRemoteStackStatePaths(windows, { stackName: options.stackName }).stackName;
  const decodedWindowsStop = Buffer.from(
    windowsStopCommand.split(' ').at(-1),
    'base64',
  ).toString('utf16le');
  assert.match(decodedWindowsStop, /HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES = '0'/);
  assert.match(decodedWindowsStop, new RegExp(`stack stop '${windowsRemoteStack}' --yes --no-docker`));
  assert.doesNotMatch(decodedWindowsStop, /stack new/);
  assert.doesNotMatch(decodedWindowsStop, /stack env/);
  assert.doesNotMatch(decodedWindowsStop, /stack dev/);

  const windowsWorkerCommand = buildRemoteStackCommand(windows, options);
  const decodedWindowsWorker = Buffer.from(
    windowsWorkerCommand.split(' ').at(-1),
    'base64',
  ).toString('utf16le');
  assert.match(decodedWindowsWorker, /\$env:HAPPIER_STACK_HOME_DIR/);
  assert.match(decodedWindowsWorker, new RegExp(`stack new '${windowsRemoteStack}'.*--if-missing`));
  assert.match(decodedWindowsWorker, new RegExp(`stack env '${windowsRemoteStack}'.* set`));
  assert.ok(
    decodedWindowsWorker.indexOf('stack new') < decodedWindowsWorker.indexOf('stack env')
      && decodedWindowsWorker.indexOf('stack env') < decodedWindowsWorker.indexOf('stack dev'),
    'the Windows worker must initialize through Stack before dev',
  );
  assert.doesNotMatch(decodedWindowsWorker, /Set-Content -LiteralPath \$stackEnvPath/);
});

test('remote Stack preserves an explicit allocator arena setting without supplying a default', () => {
  const config = resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: {
    HAPPIER_DB_PROVIDER: 'sqlite', MALLOC_ARENA_MAX: '2', UNRELATED_SETTING: 'not-forwarded',
  } });
  assert.equal(config.environment.MALLOC_ARENA_MAX, '2');
  const ordinary = resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: {
    HAPPIER_DB_PROVIDER: 'sqlite',
  } });
  assert.equal(Object.hasOwn(ordinary.environment, 'MALLOC_ARENA_MAX'), false);
  for (const target of [posix, windows]) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: true },
      stackName: 'remote-qa', runtimeMode: 'source-snapshot',
      serverUrl: 'http://127.0.0.1:43005', publicServerUrl: 'http://127.0.0.1:53005',
      remoteServerPort: 43005, remoteServerRuntimeConfig: config,
    });
    const rendered = target.platform === 'windows'
      ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    assert.ok(rendered.includes('MALLOC_ARENA_MAX=2'), `${target.platform} omitted allocator configuration`);
    assert.doesNotMatch(rendered, /UNRELATED_SETTING|not-forwarded/);
  }
});

test('source export forwards the explicit source-map option to POSIX and Windows without forwarding unrelated environment', () => {
  for (const target of [posix, windows]) for (const enabled of ['1', '0']) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: false },
      stackName: 'remote-qa', runtimeMode: 'source-snapshot', sourceUi: 'export',
      serverUrl: 'http://127.0.0.1:43005', publicServerUrl: 'http://127.0.0.1:53005', remoteServerPort: 43005,
      env: { HAPPIER_UI_EXPORT_SOURCE_MAPS: enabled, UNRELATED_SECRET: 'must-not-forward' },
      remoteServerRuntimeConfig: resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: { HAPPIER_DB_PROVIDER: 'sqlite' } }),
    });
    const rendered = target.platform === 'windows' ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    assert.ok(rendered.includes(`HAPPIER_UI_EXPORT_SOURCE_MAPS=${enabled}`), `${target.platform} dropped source-map option ${enabled}`);
    assert.doesNotMatch(rendered, /UNRELATED_SECRET|must-not-forward/);
  }
});

test('remote source server and daemon receive the canonical server runtime webapp origin', () => {
  const controllerOrigin = 'http://happier-agent-qa-embed.localhost:19364';
  const options = {
    services: { server: true, expo: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    env: { HAPPIER_WEBAPP_URL: controllerOrigin },
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    runtimeMode: 'source-snapshot',
    sourceUi: 'borrowed',
    remoteServerRuntimeConfig: resolveRemoteServerRuntimeConfig({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_DB_PROVIDER: 'sqlite', HAPPIER_WEBAPP_URL: controllerOrigin },
    }),
  };
  const command = buildRemoteStackCommand(posix, options);

  assert.match(command, /HAPPIER_WEBAPP_URL=http:\/\/happier-agent-qa-embed\.localhost:19364/);
  assert.doesNotMatch(command, /EXPO_PACKAGER_PROXY_URL=/);

  const unprojected = buildRemoteStackCommand(posix, {
    ...options,
    remoteServerRuntimeConfig: {
      ...options.remoteServerRuntimeConfig,
      environment: {},
    },
  });
  assert.doesNotMatch(unprojected, /HAPPIER_WEBAPP_URL=/,
    'the remote env writer must not make a second origin decision from its ambient env');

  const explicit = buildRemoteStackCommand(posix, {
    ...options,
    remoteServerRuntimeConfig: {
      ...options.remoteServerRuntimeConfig,
      environment: { HAPPIER_WEBAPP_URL: 'https://explicit.example.test' },
    },
  });
  assert.match(explicit, /HAPPIER_WEBAPP_URL=https:\/\/explicit\.example\.test/);
  assert.doesNotMatch(explicit, /HAPPIER_WEBAPP_URL=http:\/\/happier-agent-qa-embed\.localhost:19364/);
});

test('remote light Postgres admits the source-host authority without transporting its URL or secret', () => {
  const config = resolveRemoteServerRuntimeConfig({ serverComponentName: 'happier-server-light', env: {
    HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://fixture:private-pg-secret@host/dev',
    HANDY_MASTER_SECRET: 'private-master-secret', HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: '/source-host/dev/env',
  } });
  assert.equal(config.dbProvider, 'postgres');
  assert.equal(config.environment.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE, '/source-host/dev/env');
  for (const target of [posix, windows]) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: false }, serverUrl: 'http://127.0.0.1:43005',
      publicServerUrl: 'http://192.168.1.20:53005', activeServerId: 'stack_repo__id_default',
      stackName: 'repo-local-dev', remoteServerPort: 43005, remoteServerRuntimeConfig: config,
    });
    const decoded = target === windows ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    assert.match(decoded, /HAPPIER_DB_PROVIDER=postgres/);
    assert.doesNotMatch(decoded, /private-pg-secret|private-master-secret|DATABASE_URL=/);
  }
});

test('co-located remote server waits for deferred daemon credentials without creating another worker', () => {
  const options = {
    services: { server: true, expo: true, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {},
    },
    deferDaemonStartUntilCredentials: true,
  };

  const command = buildRemoteStackCommand(posix, options);
  const posixRemoteStack = resolveRemoteStackStatePaths(posix, { stackName: options.stackName }).stackName;
  assert.match(command, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
  assert.match(command, new RegExp(`stack dev .*${posixRemoteStack}`));

  const ordinaryCommand = buildRemoteStackCommand(posix, {
    ...options,
    deferDaemonStartUntilCredentials: false,
  });
  assert.doesNotMatch(ordinaryCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH/);

  const windowsCommand = buildRemoteStackCommand(windows, options);
  const decodedWindowsCommand = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedWindowsCommand, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
});

test('attended dev-target Stack preserves attended server readiness on the target', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:3005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    attended: true,
  });

  assert.match(command, /export HAPPIER_STACK_TUI=1/);
  const windowsCommand = buildRemoteStackCommand(windows, {
    services: { server: false, daemon: true },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://127.0.0.1:3005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    attended: true,
  });
  const decodedWindowsCommand = Buffer.from(windowsCommand.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(decodedWindowsCommand, /\$env:HAPPIER_STACK_TUI = '1'/);
});

test('remote Stack server receives the non-secret auth mail, email/password and mail-link origin settings, never the SMTP password', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: false, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    resolveServerPublicUrlOnTarget: false,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_AUTH_EMAIL_SMTP_HOST: '127.0.0.1',
        HAPPIER_AUTH_EMAIL_SMTP_PORT: '1025',
        HAPPIER_AUTH_EMAIL_SMTP_SECURE: 'false',
        HAPPIER_AUTH_EMAIL_SMTP_USERNAME: 'mailer',
        HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: 'smtp-secret-do-not-forward',
        HAPPIER_AUTH_EMAIL_FROM_ADDRESS: 'noreply@happier.localhost',
        HAPPIER_AUTH_EMAIL_FROM_NAME: 'Happier',
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: 'true',
        HAPPIER_WEBAPP_URL: 'http://127.0.0.1:19364',
      },
    },
  });
  // Mailed links are rendered on the application origin; without it a remote server mails nothing.
  assert.match(command, /HAPPIER_WEBAPP_URL=http:\/\/127\.0\.0\.1:19364/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_HOST=127\.0\.0\.1/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_PORT=1025/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_SECURE=false/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_SMTP_USERNAME=mailer/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_FROM_ADDRESS=noreply@happier\.localhost/);
  assert.match(command, /HAPPIER_AUTH_EMAIL_FROM_NAME=Happier/);
  assert.match(command, /HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED=true/);
  assert.match(command, /HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED=true/);
  // A secret would land in a remote command line and a persisted env file: never forwarded.
  assert.doesNotMatch(command, /smtp-secret-do-not-forward|HAPPIER_AUTH_EMAIL_SMTP_PASSWORD/);
});

test('remote Stack server projects feature configuration without secrets on POSIX and Windows', () => {
  const environment = {
    HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:qa-reports@happier.invalid',
    HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: 'true',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
    HAPPIER_FEATURE_TEAMS__ENABLED: 'false',
    HAPPIER_FEATURE_POLICY_ENV: 'preview',
    HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'qa.example.test',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: 'fixed_window',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: '120',
    HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: '60000',
  };
  const config = resolveRemoteServerRuntimeConfig({
    serverComponentName: 'happier-server-light',
    env: {
      ...environment,
      HAPPIER_MASTER_SECRET: 'private-secret',
      HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: 'smtp-secret-do-not-forward',
      UNRELATED_SETTING: 'unrelated',
    },
  });
  assert.deepEqual(config.environment, environment);
  for (const target of [posix, windows]) {
    const command = buildRemoteStackCommand(target, {
      services: { server: true, expo: false, daemon: false },
      stackName: 'remote-qa', serverUrl: 'http://127.0.0.1:43005',
      publicServerUrl: 'https://qa.example.test', remoteServerPort: 43005,
      remoteServerRuntimeConfig: config,
    });
    const rendered = target.platform === 'windows'
      ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
    for (const [key, value] of Object.entries(environment)) {
      assert.ok(rendered.includes(`${key}=${value}`), `${target.platform} omitted ${key}`);
    }
    assert.doesNotMatch(rendered, /HAPPIER_MASTER_SECRET|HAPPIER_AUTH_EMAIL_SMTP_PASSWORD|private-secret|smtp-secret-do-not-forward|UNRELATED_SETTING/);
  }
});

test('remote Stack server uses the stable outer public URL and projects only supported light/SQLite semantics', () => {
  const serverPlacedOptions = {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    canonicalServerUrl: 'http://happier-repo-local-dev.localhost:53288',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
    remoteExpoPort: 48081,
    expoPublicUrl: 'http://192.168.1.20:18081',
    startMobile: true,
    resolveServerPublicUrlOnTarget: false,
    resolveExpoPublicUrlOnTarget: false,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'required',
        HAPPIER_SERVER_RETENTION__ENABLED: 'true',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '60000',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SQLITE_BUSY_TIMEOUT_MS: '45000',
        HAPPIER_SQLITE_CONNECTION_LIMIT: '6',
        HAPPIER_DB_CONNECTION_LIMIT: '30',
        HAPPIER_STACK_SERVER_LOG_LEVEL: 'debug',
        HAPPIER_SERVER_LOG_LEVEL: 'info',
        HAPPIER_SERVER_LOG_FORMAT: 'json',
        HAPPIER_WEB_LATENCY_TRACE: '1',
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: '1',
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: '16777216',
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: '268435456',
        DATABASE_URL: 'postgresql://operator:do-not-forward@db.example.test/happier',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '/private/remote-state',
        HAPPIER_STACK_SERVER_PORT: '9999',
        HAPPIER_MASTER_SECRET: 'never-forward-this',
      },
    },
  };
  const command = buildRemoteStackCommand(posix, serverPlacedOptions);
  assert.match(command, /HAPPIER_STACK_SERVER_PORT=43005/);
  assert.match(command, /HAPPIER_STACK_SERVER_COMPONENT=happier-server-light/);
  assert.match(command, /HAPPIER_DB_PROVIDER=sqlite/);
  assert.match(command, /HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=required/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__ENABLED=true/);
  assert.match(command, /HAPPIER_SERVER_RETENTION__SESSIONS__MODE=delete_inactive/);
  assert.match(command, /HAPPIER_SQLITE_BUSY_TIMEOUT_MS=45000/);
  assert.match(command, /HAPPIER_SQLITE_CONNECTION_LIMIT=6/);
  // The Postgres pool budget is the same server-owned choice as the SQLite one.
  assert.match(command, /HAPPIER_DB_CONNECTION_LIMIT=30/);
  // A Stack's own server log level must reach its server wherever it is placed.
  assert.match(command, /HAPPIER_STACK_SERVER_LOG_LEVEL=debug/);
  assert.match(command, /HAPPIER_SERVER_LOG_LEVEL=info/);
  // Its log format travels with the level: a debug level without the chosen format falls back to pretty.
  assert.match(command, /HAPPIER_SERVER_LOG_FORMAT=json/);
  // So does its request-latency trace switch, the server's existing correlation owner.
  assert.match(command, /HAPPIER_WEB_LATENCY_TRACE=1/);
  assert.doesNotMatch(command, /do-not-forward|private\/remote-state|never-forward-this|HAPPIER_MASTER_SECRET/);
  assert.match(command, /--server-public-url=.*192\.168\.1\.20:53005/);
  // The originating Stack owns the signed auth audience: the remote server must sign the origin's
  // canonical origin, not one derived from the remote target's own Stack name and port.
  assert.match(command, /HAPPIER_CANONICAL_SERVER_URL=http:\/\/happier-repo-local-dev\.localhost:53288/);
  const windowsServerCommand = buildRemoteStackCommand(windows, serverPlacedOptions);
  for (const rendered of [command, Buffer.from(windowsServerCommand.split(' ').at(-1), 'base64').toString('utf16le')]) {
    assert.match(rendered, /HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED=1/);
    assert.match(rendered, /HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES=16777216/);
    assert.match(rendered, /HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES=268435456/);
  }
  assert.match(
    Buffer.from(windowsServerCommand.split(' ').at(-1), 'base64').toString('utf16le'),
    /HAPPIER_CANONICAL_SERVER_URL=http:\/\/happier-repo-local-dev\.localhost:53288/,
  );
  assert.match(Buffer.from(windowsServerCommand.split(' ').at(-1), 'base64').toString('utf16le'), /HAPPIER_WEB_LATENCY_TRACE=1/);
  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT=48081/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.match(command, /EXPO_PACKAGER_PROXY_URL=http:\/\/192\.168\.1\.20:18081/);
  assert.match(command, /--no-daemon/);
  assert.match(command, /--mobile/);
  assert.doesNotMatch(command, /--no-server/);
  assert.doesNotMatch(command, /--no-ui/);

  const expoOnly = buildRemoteStackCommand(posix, {
    services: { server: false, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:43006',
    publicServerUrl: 'http://192.168.1.20:53005',
    canonicalServerUrl: 'http://happier-repo-local-dev.localhost:53288',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteExpoPort: 48081,
  });
  assert.doesNotMatch(expoOnly, /HAPPIER_CANONICAL_SERVER_URL/);
  assert.match(expoOnly, /--no-server/);
  assert.match(expoOnly, /--server-url=.*127\.0\.0\.1:43006/);
  assert.match(expoOnly, /--server-public-url=.*192\.168\.1\.20:53005/);
});

test('remote target resolves automatically detected mobile public addresses at its own startup', () => {
  const command = buildRemoteStackCommand(posix, {
    services: { server: true, expo: true, daemon: false },
    serverUrl: 'http://127.0.0.1:52753',
    // This is the stale guest address that must not be injected into the Mac target.
    publicServerUrl: 'http://192.168.5.15:52753',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 52753,
    remoteExpoPort: 30685,
    expoPublicPort: 18829,
    expoPublicUrl: 'http://192.168.5.15:18829',
    startMobile: true,
    resolveServerPublicUrlOnTarget: true,
    resolveExpoPublicUrlOnTarget: true,
    remoteServerRuntimeConfig: {
      serverComponentName: 'happier-server-light',
      dbProvider: 'sqlite',
      environment: {},
    },
  });

  assert.match(command, /--mobile/);
  assert.match(command, /HAPPIER_STACK_EXPO_HOST=localhost/);
  assert.match(command, /HAPPIER_STACK_EXPO_PUBLIC_PORT=18829/);
  assert.match(command, /HAPPIER_STACK_EXPO_DEV_PORT=30685/);
  assert.doesNotMatch(command, /EXPO_PACKAGER_PROXY_URL=/);
  assert.doesNotMatch(command, /--server-public-url=/);
  assert.doesNotMatch(command, /192\.168\.5\.15/);
});

test('remote Stack server fails closed for unsupported server flavors and SQLite providers', () => {
  const base = {
    services: { server: true, expo: false, daemon: false },
    serverUrl: 'http://127.0.0.1:43005',
    publicServerUrl: 'http://192.168.1.20:53005',
    activeServerId: 'stack_repo__id_default',
    stackName: 'repo-local-dev',
    remoteServerPort: 43005,
  };

  assert.throws(
    () => buildRemoteStackCommand(posix, {
      ...base,
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server',
        environment: {},
      },
    }),
    /only supports.*happier-server-light/i,
  );
  assert.throws(
    () => buildRemoteStackCommand(posix, {
      ...base,
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server-light',
        dbProvider: 'pglite',
        environment: {},
      },
    }),
    /only supports.*sqlite/i,
  );
});

test('SSH tunnel owns the reverse forward independently from the monitored worker command', () => {
  assert.deepEqual(
    buildSshTunnelArgs(posix, {
      localServerPort: 3005,
      remoteServerPort: 43005,
    }),
    [
      '-T',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-N',
      '-R',
      '127.0.0.1:43005:127.0.0.1:3005',
      'happier-stack-linux',
    ],
  );

  assert.deepEqual(
    buildSshWorkerArgs(posix, {
      remoteCommand: 'bash -lc true',
    }),
    [
      '-tt',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'ServerAliveInterval=0',
      'happier-stack-linux',
      'bash -lc true',
    ],
  );

  const windowsArgs = buildSshWorkerArgs(windows, {
    remoteCommand: 'powershell.exe -EncodedCommand example',
  });
  assert.equal(windowsArgs[0], '-T');
  assert.equal(windowsArgs.includes('-tt'), false);
});

test('SSH forwarding supports local and reverse routes in one transport owner', () => {
  const args = buildSshForwardArgs(posix, {
    forwards: [
      { direction: 'reverse', listenHost: '127.0.0.1', listenPort: 43005, targetHost: '127.0.0.1', targetPort: 3005 },
      { direction: 'local', listenHost: '0.0.0.0', listenPort: 18081, targetHost: 'localhost', targetPort: 48081 },
    ],
  });
  assert.deepEqual(args.slice(0, 5), [
    '-T',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
  ]);
  assert.deepEqual(
    args.slice(-6),
    [
      '-R',
      '127.0.0.1:43005:127.0.0.1:3005',
      '-L',
      '*:18081:localhost:48081',
      '-N',
      'happier-stack-linux',
    ],
  );
});

test('SSH reverse dynamic forwarding keeps canonical browser origins and resolves from the controller', () => {
  const args = buildSshForwardArgs(posix, { forwards: [
    { direction: 'reverse-dynamic', listenHost: '127.0.0.1', listenPort: 43005 },
    { direction: 'local', listenPort: 18081, targetPort: 48081 },
  ] });
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:43005');
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:18081:127.0.0.1:48081');
});

test('policy CLI resolves a CLI package typecheck whose policy imports modules that import it back', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/u, '');
  const cli = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--package-policy', root, join(root, 'apps/cli'), 'pnpm', 'run', 'typecheck'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^policy_kind='typecheck'$/mu);
});

test('a cold command-replica probe reports the marker with status 0 under a login shell whose logout hook fails', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-cold-replica-probe-' });
  const home = join(fixture.root, 'home');
  mkdirSync(home);
  // Ubuntu's default ~/.bash_logout ends with a failing `[ -x /usr/bin/clear_console ]` test
  // on workers without clear_console (mac2-linux, 2026-10-29).
  writeFileSync(join(home, '.bash_logout'), 'false\n');
  const target = { name: 'worker', platform: 'posix', ssh: 'worker', repoDir: join(fixture.root, 'worker/sibling'),
    executorRepoDir: join(fixture.root, 'worker/0.3'), cliHomeDir: join(fixture.root, 'worker-home') };
  const probe = spawnSync('/bin/sh', ['-c', commandPolicy.buildRemoteEnsureDirectoriesCommand(target, {
    commandReplica: true, requireSourceAdmission: true })], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^__HAPPIER_COMMAND_REPLICA_UNMATERIALIZED__$/m);
  // The probe does not create the destination before the source owner admits its bytes.
  assert.equal(existsSync(target.repoDir), false);
});

test('commit coherence keeps private Git objects local with canonical compiler admission in both dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const args = ['node', 'scripts/workspaces/checkCommitTypeCoherence.mjs', '--base=HEAD', '--tree=private-tree'];
  const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root });
  assert.equal(policy.placement, 'primary-only');
  assert.equal(policy.heavyClass, 'compilation');
  assert.equal(policy.localCompile, '0', 'Git-local validation uses admission without the general controller compile refusal');
  const fixturePolicy = resolveRemoteCommandPolicy(['node', '--test', 'scripts/workspaces/checkCommitTypeCoherence.test.mjs'], { repoRoot: root, cwd: root });
  assert.equal(fixturePolicy.heavyClass, 'validation', 'small isolated Git/compiler fixtures retain their existing test envelope');
  assert.equal(fixturePolicy.placement, 'worker-eligible');
  if (process.platform === 'win32') return;
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@"; printf '%s,%s,%s' "$policy_placement" "$policy_heavyClass" "$policy_localCompile"`,
    'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'primary-only,compilation,0');
});


test('broker IPC owner suites prepare source while other Stack native suites retain runtime preparation', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'hstack-broker-source-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [file, kind] of [
    ['apps/stack/scripts/utils/proc/admission_broker.test.mjs', 'source-test'],
    ['apps/stack/scripts/utils/proc/admission_client.test.mjs', 'source-test'],
    ['apps/stack/scripts/unlisted_runtime.test.mjs', 'runtime'],
  ]) {
    const args = ['node', '--import', './packages/cli-common/registerSourceRuntime.mjs', '--test', file];
    const policy = resolveRemoteCommandPolicy(args, { cwd: root });
    assert.equal(policy.kind, kind, file);
    assert.equal(policy.heavyClass, 'validation', file);
    assert.equal(policy.bootstrap, '1', 'source preparation still admits private dependencies');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s,%s" "$policy_kind" "$policy_heavyClass" "$policy_bootstrap"',
      'policy', artifact, root, ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `${kind},validation,1`, file);
  }
});

test('declared native script suites skip publication through both dispatchers and local preparation', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'hstack-declared-source-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const declaration = '// @happier-test-preparation source\n';
  // createRequire makes automatic graph discovery inconclusive. The authored
  // declaration promises source inputs, while installed dependencies remain required.
  const body = "import { createRequire } from 'node:module';\n";
  for (const component of ['apps/ui', 'packages/example']) {
    await mkdir(fixture.path(component), { recursive: true });
    await writeFile(fixture.path(`${component}/package.json`), '{}\n');
  }
  const cases = [
    [root, '.', 'apps/ui/scripts/perf/webFeatureDependencies.test.mjs', 'source-test'],
    [fixture.root, '.', 'apps/ui/scripts/renamed.test.mjs', 'source-test'],
    [fixture.root, 'packages/example', 'scripts/other.test.mjs', 'source-test'],
    [fixture.root, '.', 'apps/ui/scripts/undeclared.test.mjs', 'runtime'],
    [fixture.root, '.', 'apps/ui/scripts/unknown.test.mjs', 'runtime'],
  ];
  for (const [repoRoot, cwd, file, kind] of cases) {
    if (repoRoot === fixture.root) {
      const path = join(repoRoot, cwd, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, (file.includes('undeclared') ? '' : file.includes('unknown')
        ? '// @happier-test-preparation unknown\n' : declaration) + body);
    }
    const args = ['node', '--test', file];
    const env = { ...process.env, NODE_OPTIONS: '' };
    const policy = resolveRemoteCommandPolicy(args, { repoRoot, cwd, env });
    assert.equal(policy.kind, kind, file);
    assert.equal(policy.bootstrap, '1', 'declarations retain installed-dependency readiness');
    assert.equal(policy.heavyClass, 'validation', 'a declaration does not lower payload admission');
    assert.equal(policy.workspaceLock, '');
    if (kind === 'source-test') {
      const preparation = await (await import('./remote_validation_preparation.mjs')).prepareRemoteValidationWorkspace({
        repoDir: fixture.root, componentRelativeDir: policy.component, validationKind: policy.kind,
      });
      assert.deepEqual(preparation.skipped, ['workspace-source-test']);
      const { readNativeTestSourceInputs } = await import('../fs/nativeTestInputs.mjs');
      assert.equal(readNativeTestSourceInputs(repoRoot, join(cwd, file)), null,
        'a preparation declaration does not prove a complete watcher input graph');
    }
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$2/$3; projection_command_policy=$4; shift 4; resolve_native_command_policy "$@" || exit $?; printf "%s,%s,%s" "$policy_kind" "$policy_heavyClass" "$policy_bootstrap"',
      'policy', artifact, repoRoot, cwd, join(root, 'apps/stack/scripts/utils/dev_targets/remote_commands.mjs'), ...args],
    { encoding: 'utf8', env });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `${kind},validation,1`, file);
  }
  // An undeclared loader still has authority to change module resolution.
  assert.equal(resolveRemoteCommandPolicy(['node', '--import', './unknown-loader.mjs', '--test', cases[0][2]],
    { repoRoot: root, cwd: root }).kind, 'runtime');
});

test('CLI integration skips publication and compilation admission only when setup skips its builds', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const cwd = join(root, 'apps/cli');
  const fixture = await createTempFixture(t, { prefix: 'hstack-cli-source-policy-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const args = ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
    'src/plugins/authoring/bundleDaemonRuntime.integration.test.ts', '-t', 'installs the maintained Store kind'];
  for (const value of ['', 'false', '1', 'true', ' YES ']) {
    const skipped = ['1', 'true', ' YES '].includes(value);
    const env = { ...process.env, HAPPIER_CLI_TEST_SKIP_BUILD: value };
    await t.test(value || 'unset', async () => {
      const policy = await commandPolicy.resolvePackageCommandPolicy(args, { cwd, env });
      assert.equal(policy.kind, skipped ? 'source-test' : 'runtime');
      assert.equal(policy.heavyClass, skipped ? 'validation' : 'compilation');
      if (skipped) {
        assert.equal(policy.workspaceLock, '');
        const preparation = await (await import('./remote_validation_preparation.mjs')).prepareRemoteValidationWorkspace({
          repoDir: fixture.root, componentRelativeDir: policy.component,
          // Native custody has its real preflight in the composed replay;
          // this isolated boundary proves the workspace-publication skip.
          validationKind: policy.kind,
        });
        assert.deepEqual(preparation.skipped, ['workspace-source-test']);
      }
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c',
        '. "$1"; repo_root=$2; invoked_cwd=$2/apps/cli; shift 2; resolve_native_command_policy "$@" || exit $?; printf "%s,%s,%s" "$policy_kind" "$policy_heavyClass" "$policy_workspaceLock"',
        'policy', artifact, root, ...args], { encoding: 'utf8', env });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, `${policy.kind},${policy.heavyClass},${policy.workspaceLock}`);
    });
  }
  for (const override of ['--root=../ui', '--workspace=other.ts', '--config=unknown.config.ts']) {
    const policy = resolveRemoteCommandPolicy([...args, override], {
      cwd, env: { ...process.env, HAPPIER_CLI_TEST_SKIP_BUILD: '1' },
    });
    assert.equal(policy.kind, 'runtime', override);
  }
  // Skipping setup does not skip compilers invoked by selected test bodies.
  for (const selection of [[], ['src/plugins/scaffold/scaffold.integration.test.ts']]) {
    const compilerArgs = [...args.slice(0, 6), ...selection];
    const env = { ...process.env, HAPPIER_CLI_TEST_SKIP_BUILD: '1' };
    const policy = await commandPolicy.resolvePackageCommandPolicy(compilerArgs, { cwd, env });
    assert.equal(policy.kind, 'source-test');
    assert.equal(policy.heavyClass, 'compilation', selection.join(' ') || 'whole integration suite');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$2/apps/cli; shift 2; resolve_native_command_policy "$@" || exit $?; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
      'policy', artifact, root, ...compilerArgs], { encoding: 'utf8', env });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test,compilation');
  }
});

test('unlisted Vitest configs retain their inherited workspace-source resolver in both dispatchers', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'hstack-inherited-source-policy-' });
  const cwd = fixture.path('packages/plugins/claude');
  await mkdir(cwd, { recursive: true });
  copyFileSync(join(root, 'packages/plugins/claude/vitest.config.ts'), join(cwd, 'vitest.config.ts'));
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  const owner = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));
  for (const [body, expected] of [
    ['...base, test: { ...base.test, globalSetup: [] }', 'source-test'],
    ['...base, plugins: [...(base.plugins ?? []), { name: "extra" }]', 'source-test'],
    ['...base, plugins: []', 'runtime'],
    ['...base, test: { ...base.test, globalSetup: chooseSetup() }', 'runtime'],
  ]) {
    await writeFile(join(cwd, 'vitest.future.config.ts'),
      `import base from './vitest.config'; export default { ${body} };`);
    const args = ['vitest', 'run', '--config', 'vitest.future.config.ts'];
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: fixture.root, cwd });
    assert.equal(policy.kind, expected, body);
    assert.equal(policy.heavyClass, 'validation');
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$2/packages/plugins/claude; projection_command_policy=$3; shift 3; resolve_native_command_policy "$@" || exit $?; printf "%s,%s" "$policy_kind" "$policy_heavyClass"',
      'policy', artifact, fixture.root, owner, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, `${expected},validation`);
  }
});

test('entry-load preparation emits runtime outputs without a strict type verdict', () => {
  const policy = resolveRemoteCommandPolicy(['node', 'apps/stack/scripts/perf/entry-load.mjs'], { cwd: '.' });
  assert.equal(policy.preparationBuildMode, 'qa-runtime');
  assert.equal(policy.heavyClass, 'entry-loads');
});
