import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { prepareCommandRepository, renderNativeExecutionProjection } from './utils/dev_targets/native_execution_projection.mjs';
import { buildRemoteExecCommand, resolveHeavyweightMemoryFloorKiB } from './utils/dev_targets/remote_commands.mjs';
import { installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { flushDevTargetSync } from './utils/dev_targets/sync_project.mjs';
import { syncDevTarget } from './utils/dev_targets/executor.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './utils/dev_targets/mutagen_project.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const launcher = join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
// Measured cksum fixture key for `probe-command  ` (empty build target/components).
const probeCommandCacheKey = '1086556756';
const repoToken = repoRoot.split('/').at(-1)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '') || 'repo';
const executionNeutralEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => ![
    'HAPPIER_DEV_TARGET_EXECUTION',
    'HAPPIER_PREFERRED_EXECUTION',
    'HAPPIER_EXEC_CONFIG_PATH',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE',
    'HAPPIER_HSTACK_DISPATCH_CONTROL',
    'HAPPIER_HSTACK_EXECUTION',
    'HAPPIER_TYPECHECK_DISPATCHED',
    'HAPPIER_STACK_CLI_HOME_DIR',
    'HAPPIER_HOME_DIR',
    'HAPPIER_STACK_PM_CACHE_BASE_DIR',
    // Synthetic package-manager fixtures must not inherit the suite's Yarn
    // executable and escape their external process boundary.
    'npm_node_execpath',
    'npm_execpath',
  ].includes(key)),
);

async function executable(path, contents) {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

function nativeFixtureRuntime(stackDir) {
  return resolveDevTargetMutagenRuntime({ stackBaseDir: stackDir, sourceDir: repoRoot,
    env: { HAPPIER_STACK_STORAGE_DIR: dirname(stackDir) } });
}

test('CLI test preflight rejects missing Go before bootstrap and admits the repaired worker', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-cli-go-preflight-' });
  const bin = join(root, 'bin');
  const stack = join(root, 'stack');
  const config = join(stack, 'dev-targets.json');
  const ready = join(root, 'go-ready');
  await mkdir(bin);
  await mkdir(stack);
  await writeFile(config, JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/worker/repo', cliHomeDir: '/worker/home' }],
    commandExecution: { mode: 'prefer-target', target: 'worker', fallback: 'local' } }));
  await executable(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(join(bin, 'mutagen'), '#!/bin/sh\n[ "$1" != sync ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  // SSH/tool availability is the system boundary. The real launcher performs
  // policy classification, prerequisite caching, selection and dispatch.
  await executable(join(bin, 'ssh'), `#!/bin/sh
case "$*" in
  *-MNf*|*-O\\ check*) exit 0 ;;
  *command\\ -v*) case "$*" in *"'go'"*) [ -f '${ready}' ] || exit 1 ;; esac; exit 0 ;;
  *getconf*) printf '48 0 0.9 100000000 10 0 100000000 100000000 0 0 0 0 0 0 0 linux\\n' ;;
  *) printf 'runner-started\\n'; exit 23 ;;
esac
`);
  const invocation = { cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv,
    HOME: root, HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root } };
  const args = [launcher, '--target=worker', '--', 'corepack', 'yarn', '--cwd', 'apps/cli', 'vitest', 'run', 'src/example.test.ts'];
  const missing = spawnSync('/bin/sh', args, invocation);
  assert.notEqual(missing.status, 0, missing.stderr);
  assert.doesNotMatch(missing.stdout, /runner-started/, 'missing Go must prevent bootstrap and payload dispatch');
  assert.match(missing.stderr, /command preflight failed/);
  await writeFile(ready, 'ready');
  const repaired = spawnSync('/bin/sh', args, invocation);
  assert.equal(repaired.status, 23, repaired.stderr);
  assert.match(repaired.stdout, /runner-started/);
});

async function writeNativeProjectionFixture(path, contents) {
  const runtime = nativeFixtureRuntime(dirname(path));
  // Even hand-authored external-process fixtures consume the shared-owner
  // fields. Keep their daemon/barrier namespace inside the isolated fixture.
  const body = contents.replace(/^projection_mutagen_(?:data_dir|ssh_path)=.*\n/gm, '');
  await writeFile(path, `projection_mutagen_data_dir=${JSON.stringify(runtime.dataDir)}\nprojection_mutagen_ssh_path=${JSON.stringify(runtime.opensshDir)}\n${body}`);
}

test('controller explicit local compilation refuses without override and override retains admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-local-compile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher: native } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Mock only compiler/process and OS telemetry boundaries; native policy,
  // placement, admission, process identity and reservations remain real.
  await executable(join(bin, 'node'), `#!/bin/sh\ncase "$1" in *runTypeScriptCli.mjs) printf 'compiler-started\\n'; exit 7 ;; *) exec ${JSON.stringify(process.execPath)} "$@" ;; esac\n`);
  await executable(join(bin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "%s %s\\n" "$MEMORY_KIB" "$MEMORY_KIB" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const invoke = (memory, options = [], extraEnv = {}, payload = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', 'apps/ui/tsconfig.json']) => spawnSync('/bin/sh', [native, '--local', ...options, '--', ...payload], {
    cwd: checkout, encoding: 'utf8', timeout: 15000,
    env: { ...executionNeutralEnv, HOME: root, PATH: `${bin}:${process.env.PATH}`, CI: '', MEMORY_KIB: String(memory), ...extraEnv },
  });
  const refused = invoke(40 * 1024 * 1024);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /AUTO.*--allow-local-compilation/);
  const uiFloorKiB = resolveHeavyweightMemoryFloorKiB('compilation-ui', { machine: 'local' });
  const insufficient = invoke(uiFloorKiB - 1, ['--allow-local-compilation'], { CI: '1' });
  assert.equal(insufficient.status, 1, insufficient.stderr);
  assert.equal(insufficient.stdout, '');
  assert.match(insufficient.stderr, new RegExp(`insufficient memory capacity.*compilation-ui.*requires=${uiFloorKiB}`));
  const admitted = invoke(40 * 1024 * 1024, ['--allow-local-compilation'], { CI: '1' });
  assert.equal(admitted.status, 7, admitted.stderr);
  assert.equal(admitted.stdout, 'compiler-started\n');
  const localFloor = invoke(7 * 1024 * 1024, ['--allow-local-compilation'], {}, ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=package-dist', '--', 'node', '-e', '']);
  assert.equal(localFloor.status, 1, localFloor.stderr);
  assert.match(localFloor.stderr, /insufficient memory capacity.*requires=8388608/);
});

test('worker disk admission rejects an exhausted write filesystem before starting payload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-disk-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher: native } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const cache = join(root, 'cli/cache');
  await mkdir(join(cache, 'yarn/v6'), { recursive: true });
  await mkdir(join(checkout, 'node_modules'), { recursive: true });
  await writeFile(join(checkout, 'node_modules/data'), 'dependency'.repeat(8192));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // df and memory telemetry are the OS boundaries; filesystem measurement,
  // class admission, process identity and retention execute their real owners.
  await executable(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000 100000 0 100%% /\\n"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const payload = join(root, 'started');
  const result = spawnSync('/bin/sh', [native, '--heavyweight-admission', '--class=runtime-build', '--machine=worker', '--failure-id=disk-test', '--no-wait', '--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', payload], {
    cwd: checkout, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:${process.env.PATH}`, HAPPIER_STACK_PM_CACHE_BASE_DIR: cache },
  });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /HSTACK_ADMISSION_DISK:disk-test/);
  await assert.rejects(access(payload), { code: 'ENOENT' });
});

test('inherited admission rechecks an exhausted write filesystem even for the same class', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-disk-escalation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher: native } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const cache = join(root, 'cli/cache');
  const phase = join(root, 'phase');
  const payload = join(root, 'started');
  await mkdir(join(cache, 'yarn/v6'), { recursive: true });
  await mkdir(join(checkout, 'node_modules'), { recursive: true });
  await writeFile(join(checkout, 'node_modules/data'), 'dependency');
  await writeFile(join(cache, 'native-output'), 'build'.repeat(65536));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Free disk changes between the admitted parent and its nested build.
  await executable(join(bin, 'df'), '#!/bin/sh\nif [ -f "$DISK_PHASE" ]; then free=0; else free=100000; fi\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 200000 100000 %s 50%% /\\n" "$free"\n');
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  const parent = `require('node:fs').writeFileSync(process.env.DISK_PHASE, 'build');
    const child = require('node:child_process').spawnSync('/bin/sh', [process.argv[1], '--heavyweight-admission', '--class=validation', '--machine=worker', '--failure-id=disk-escalation', '--no-wait', '--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', process.argv[2]], {encoding:'utf8',env:{...process.env,HAPPIER_STACK_PM_CACHE_BASE_DIR:process.env.FIXTURE_CACHE}});
    console.log(JSON.stringify({status:child.status,stderr:child.stderr}));`;
  const result = spawnSync('/bin/sh', [native, '--heavyweight-admission', '--class=validation', '--machine=worker', '--no-wait', '--', process.execPath, '-e', parent, native, payload], {
    cwd: checkout, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:${process.env.PATH}`, DISK_PHASE: phase, FIXTURE_CACHE: cache },
  });
  assert.equal(result.status, 0, result.stderr);
  const child = JSON.parse(result.stdout.trim());
  assert.equal(child.status, 75, child.stderr);
  assert.match(child.stderr, /HSTACK_ADMISSION_DISK:disk-escalation/);
  await assert.rejects(access(payload), { code: 'ENOENT' });
});

test('runtime control uses the command pool and forwards ACK only after worker READY without replaying a started exit', { timeout: 15000 }, async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *" cancel "*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  printf "starved\\n" >> "$DISPATCHES"',
    '  printf \'HAPPIER_RUNTIME_BUILD_READY={"worker":"starved","runtimeTarget":{"platform":"linux","arch":"x64"}}\\n\'',
    '  IFS= read -r ack || exit 130',
    '  printf "BODY:%s\\n" "$ack"',
    '  exit "${PAYLOAD_EXIT-75}" ;;',
    ' *) exit 0 ;;',
    'esac', '',
  ].join('\n'));
  for (const exitCode of [75, 255, 137]) {
    const child = spawn('/bin/sh', [launcher, '--runtime-build-target=darwin-arm64', '--runtime-build-components=server', '--control-stdin', '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: String(exitCode) }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGTERM'));
    let out = '', err = '', ack = false;
    child.stdout.on('data', chunk => {
      out += chunk;
      if (!ack && out.includes('HAPPIER_RUNTIME_BUILD_READY=')) { ack = true; child.stdin.write('{"requestPath":"/tmp/fixture-request"}\n'); }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(result.code, exitCode, err);
    assert.match(out, /BODY:\{"requestPath":"\/tmp\/fixture-request"\}/);
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved','starved','starved']);
});

async function runtimeAdmissionTransportFixture(t) {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 9437184, roomyAvailableKiB: 9437184, roomyLoad: 12 });
  const workers = {};
  for (const name of ['starved', 'roomy']) {
    workers[name] = await installNativeAdmissionFixture({ root: join(fixture.root, name) });
    // A physical runtime worker has an installed dependency footprint; the
    // real disk owner measures these bytes before its admission can succeed.
    const dependencies = resolve(workers[name].launcher, '../../../../node_modules');
    await mkdir(dependencies, { recursive: true });
    await writeFile(join(dependencies, 'runtime-fixture'), 'installed dependency');
    workers[name].sample = join(fixture.root, `${name}-sample`);
    await writeFile(workers[name].sample, `8 ${name === 'starved' ? '0.1' : '12'} 0.3 22000000 20 0 9437184 28311552 0 0 0 0 0 0 0 linux\n`);
  }
  const controller = join(fixture.root, 'worker-controller.mjs');
  await writeFile(controller, `
import { createInterface } from 'node:readline';
const worker = process.env.HAPPIER_RUNTIME_BUILD_WORKER_NAME;
console.log('HAPPIER_RUNTIME_BUILD_READY=' + JSON.stringify({worker,controllerPid:process.pid,runtimeTarget:{platform:process.platform,arch:process.arch}}));
process.stdin.on('end', () => { console.error('fixture-controller-input-EOF:' + worker); process.exitCode = 91; });
createInterface({input:process.stdin}).once('line', line => { console.log('BODY:' + worker + ':' + line); process.exit(Number(process.env.PAYLOAD_EXIT || 0)); });
`);
  await executable(join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(fixture.binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7,$8}\' "$RUNTIME_WORKER_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/bash',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$*" in *starved-host*) worker=starved; export RUNTIME_WORKER_SAMPLE="$STARVED_SAMPLE"; native="$STARVED_NATIVE" ;; *) worker=roomy; export RUNTIME_WORKER_SAMPLE="$ROOMY_SAMPLE"; native="$ROOMY_NATIVE" ;; esac',
    'for argument in "$@"; do remote=$argument; done',
    'case "$*" in',
    ' *getconf*) cat "$RUNTIME_WORKER_SAMPLE" ;;',
    ' *-O\\ check*|*-MNf*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  case "$remote" in *" cancel "*) eval "$remote"; exit $? ;; esac',
    '  printf "%s\\n" "$worker" >> "$DISPATCHES"',
    '  remote=${remote//"$RUNTIME_REAL_LAUNCHER"/"$native"}',
    '  remote=${remote//"apps/stack/scripts/build/remote_runtime_build.mjs"/"$RUNTIME_CONTROLLER"}',
    '  eval "$remote" ;;',
    ' *) eval "$remote" ;;',
    'esac', '',
  ].join('\n'));
  fixture.invocation.env = { ...fixture.invocation.env, STARVED_SAMPLE: workers.starved.sample, ROOMY_SAMPLE: workers.roomy.sample,
    STARVED_NATIVE: workers.starved.launcher, ROOMY_NATIVE: workers.roomy.launcher,
    RUNTIME_REAL_LAUNCHER: launcher, RUNTIME_CONTROLLER: controller };
  return { ...fixture, workers };
}

function startRuntimeController(t, fixture, extra = {}, { target = 'darwin-arm64', components = 'server', nodeOptions = [] } = {}) {
  const child = spawn('/bin/sh', [launcher, `--runtime-build-target=${target}`, `--runtime-build-components=${components}`, '--control-stdin', '--', 'node', ...nodeOptions, 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, env: { ...fixture.invocation.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  const result = { child, stdout: '', stderr: '', completion: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) };
  child.stdout.on('data', chunk => { result.stdout += chunk; });
  child.stderr.on('data', chunk => { result.stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await result.completion; });
  return result;
}

async function waitForRuntime(predicate, message) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message());
}

test('all-busy runtime placement preserves the real waiting head and backfill charge until later remote admission', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  fixture.config.commandExecution.fallback = 'local';
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const runtime = startRuntimeController(t, fixture);
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  let waiterPath;
  await waitForRuntime(async () => {
    const entries = await readdir(waiters).catch(() => []);
    if (entries.length !== 1) return false;
    waiterPath = join(waiters, entries[0]);
    return (await readFile(waiterPath, 'utf8')).includes(' runtime-build ') && runtime.stderr.includes('waiting for heavyweight admission');
  }, () => runtime.stderr);
  const original = (await readFile(waiterPath, 'utf8')).trim().split(' ');
  const small = () => spawnSync('/bin/sh', [fixture.workers.starved.launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--no-wait', '--', '/usr/bin/printf', 'backfill'], { ...fixture.invocation, env: { ...fixture.invocation.env, HAPPIER_DEV_TARGET_EXECUTION: '1', RUNTIME_WORKER_SAMPLE: fixture.workers.starved.sample }, encoding: 'utf8' });
  for (let index = 0; index < 3; index++) { const result = small(); assert.equal(result.status, 0, `backfill ${index}: ${result.stderr}; head=${await readFile(waiterPath, 'utf8')}`); }
  await waitForRuntime(async () => (await readFile(fixture.invocation.env.DISPATCHES, 'utf8').catch(() => '')).includes('roomy'), () => runtime.stderr);
  assert.equal(runtime.stdout, '');
  const retained = (await readFile(waiterPath, 'utf8')).trim().split(' ');
  assert.deepEqual(retained.slice(0, 4), original.slice(0, 4), 'failed alternative replaced or re-aged waiting demand');
  assert.equal(retained[4], '18874368', 'backfill charge was reset');
  assert.equal(small().status, 75, 'new validations bypassed exhausted runtime head');
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY='), () => runtime.stderr);
  assert.doesNotMatch(runtime.stdout, /BODY:/);
  runtime.child.stdin.write('{"requestPath":"/tmp/runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:starved:/);
  assert.doesNotMatch(runtime.stderr, /running locally/);
});


test('runtime placement switches only after an alternative is actually admitted and cancels the original queue', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const runtime = startRuntimeController(t, fixture);
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 1, () => runtime.stderr);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await waitForRuntime(() => runtime.stdout.includes('"worker":"roomy"'), () => runtime.stderr);
  assert.doesNotMatch(runtime.stdout, /BODY:/);
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 0, () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:roomy:/, runtime.stderr);
  assert.doesNotMatch(runtime.stdout, /BODY:starved:/);
});

test('runtime alternatives observe a recovered worker on the next cadence despite unavailable caches', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const down = join(fixture.root, 'roomy-down');
  await writeFile(down, '');
  const ssh = join(fixture.binDir, 'ssh');
  const body = await readFile(ssh, 'utf8');
  await executable(ssh, body.replace('#!/bin/bash\n', '#!/bin/bash\ncase "$*" in *roomy-host*) [ ! -f "$WORKER_DOWN" ] || exit 255 ;; esac\n'));
  const runtime = startRuntimeController(t, fixture, { WORKER_DOWN: down });
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 1 && runtime.stderr.includes('roomy command preflight failed'), () => runtime.stderr);
  const [original] = await readdir(waiters);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await rm(down);
  await waitForRuntime(() => runtime.stdout.includes('"worker":"roomy"'), () => runtime.stderr);
  assert.doesNotMatch(runtime.stdout, /BODY:/);
  runtime.child.stdin.write('{"requestPath":"/tmp/recovered-runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:roomy:/);
  await waitForRuntime(async () => !(await readdir(waiters)).includes(original), () => runtime.stderr);
});

test('daemon placement prefers a native worker over a less-loaded capable cross builder', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  for (const worker of Object.values(fixture.workers)) await writeFile(worker.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  const ssh = join(fixture.binDir, 'ssh');
  const body = await readFile(ssh, 'utf8');
  // The remote OS/capability probe is the boundary: both workers are eligible,
  // but only roomy matches the requested daemon's native support target.
  await executable(ssh, body.replace(' *getconf*)', ' *componentArtifactTarget.mjs*) case "$worker" in roomy) printf "linux-arm64\\n" ;; *) printf "linux-x64\\n" ;; esac ;;\n *getconf*)'));
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  const runtime = startRuntimeController(t, fixture, {}, { target: 'linux-arm64', components: 'daemon' });
  await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY='), () => runtime.stderr);
  assert.match(runtime.stdout, /"worker":"roomy"/, runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/native-daemon-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.3 22000000 20 0 9437184 28311552 0 0 0 0 0 0 0 linux\n');
  const cross = startRuntimeController(t, fixture, {}, { target: 'linux-arm64', components: 'daemon' });
  await waitForRuntime(() => cross.stdout.includes('HAPPIER_RUNTIME_BUILD_READY='), () => cross.stderr);
  assert.match(cross.stdout, /"worker":"starved"/, 'a busy native worker must not prevent a capable cross builder from admitting');
  cross.child.stdin.write('{"requestPath":"/tmp/cross-daemon-request"}\n');
  assert.equal((await cross.completion).code, 0, cross.stderr);
});

test('runtime alternatives keep evaluating the pool while another alternative is flushing', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  fixture.config.targets.push({ ...fixture.config.targets[1], name: 'recovered', ssh: 'recovered-host' });
  fixture.config.commandExecution.targets.push('recovered');
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const down = join(fixture.root, 'recovered-down');
  const flushing = join(fixture.root, 'alternative-flushing');
  await writeFile(down, '');
  const ssh = join(fixture.binDir, 'ssh');
  await executable(ssh, (await readFile(ssh, 'utf8')).replace('#!/bin/bash\n', '#!/bin/bash\ncase "$*" in *recovered-host*) [ ! -f "$RECOVERED_DOWN" ] || exit 255 ;; esac\n'));
  const mutagen = join(fixture.binDir, 'mutagen');
  await executable(mutagen, (await readFile(mutagen, 'utf8')).replace('#!/bin/sh\n', '#!/bin/sh\ncase "$*" in *"flush happier-roomy"*) : > "$ALTERNATIVE_FLUSHING"; exec /bin/sleep 60 ;; esac\n'));
  const runtime = startRuntimeController(t, fixture, { RECOVERED_DOWN: down, ALTERNATIVE_FLUSHING: flushing });
  await waitForRuntime(async () => (await readdir(join(fixture.workers.starved.admissionRoot, 'waiters')).catch(() => [])).length === 1, () => runtime.stderr);
  await writeFile(fixture.workers.roomy.sample, '8 12 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await waitForRuntime(async () => access(flushing).then(() => true, () => false), () => runtime.stderr);
  await rm(down);
  await waitForRuntime(() => runtime.stdout.includes('"worker":"recovered"'), () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/pool-recovered-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stdout, /BODY:recovered:/);
});

test('runtime worker eligibility uses the command pool, physical class floor and canonical component capability', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  fixture.config.targets[0].name = 'mac2-linux';
  fixture.config.targets.push({ ...fixture.config.targets[1], name: 'linux1', ssh: 'metro-host' });
  fixture.config.commandExecution.targets = ['mac2-linux','roomy'];
  fixture.config.runtimePlacement.build = { mode: 'prefer-target', targets: ['roomy'], fallback: 'local' };
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  await writeFile(fixture.workers.roomy.sample, '8 0.1 0.9 22000000 20 0 15000000 16000000 0 0 0 0 0 0 0 linux\n');
  const runtime = startRuntimeController(t, fixture);
  await waitForRuntime(() => runtime.stdout.includes('"worker":"mac2-linux"'), () => runtime.stderr);
  runtime.child.stdin.write('{"requestPath":"/tmp/runtime-request"}\n');
  assert.equal((await runtime.completion).code, 0, runtime.stderr);
  assert.match(runtime.stderr, /insufficient memory capacity on roomy/);
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /metro-host/);
  const daemon = spawn('/bin/sh', [launcher, '--runtime-build-target=darwin-arm64', '--runtime-build-components=daemon', '--control-stdin', '--', 'node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], { ...fixture.invocation, stdio: ['pipe','pipe','pipe'] });
  let error = '';
  daemon.stderr.on('data', chunk => { error += chunk; });
  const code = await new Promise(resolve => daemon.once('close', resolve));
  assert.equal(code, 1, error);
  assert.match(error, /daemon:.*host-native runtime packages require a matching host target/);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved'], 'cached server eligibility bypassed daemon capability filtering');
});

test('native runtime control admits web, mixed web and daemon, and all runtime components', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  for (const components of ['web', 'web,daemon', 'web,server,daemon']) {
    const runtime = startRuntimeController(t, fixture, {}, { target: `${process.platform}-${process.arch}`, components });
    await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY=') || runtime.child.exitCode !== null, () => runtime.stderr);
    assert.equal(runtime.child.exitCode, null, `${components} exited before admission: ${runtime.stderr}`);
    assert.match(runtime.stdout, /"worker":"starved"/);
    assert.doesNotMatch(runtime.stdout, /BODY:/);
    runtime.child.stdin.write('{"requestPath":"/tmp/runtime-web-request"}\n');
    assert.equal((await runtime.completion).code, 0, `${components}: ${runtime.stderr}`);
    assert.match(runtime.stdout, /BODY:starved:/);
  }
});

test('native runtime admission preserves Node preload arguments and runs the hook in the admitted controller before READY', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const hook = 'console.error("fixture-preload:" + process.pid + ":" + process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN)';
  const module = 'data:text/javascript;base64,' + Buffer.from(hook).toString('base64');
  await writeFile(fixture.workers.starved.sample, '8 0.1 0.9 22000000 20 0 28000000 28311552 0 0 0 0 0 0 0 linux\n');
  for (const nodeOptions of [[`--import=${module}`], ['--import', module]]) {
    const runtime = startRuntimeController(t, fixture, {}, { nodeOptions });
    await waitForRuntime(() => runtime.stdout.includes('HAPPIER_RUNTIME_BUILD_READY=') || runtime.child.exitCode !== null, () => runtime.stderr);
    assert.equal(runtime.child.exitCode, null, runtime.stderr);
    const preload = runtime.stderr.match(/fixture-preload:(\d+):(\d+:\d+)/);
    assert.ok(preload, runtime.stderr);
    const ready = JSON.parse(runtime.stdout.trim().slice('HAPPIER_RUNTIME_BUILD_READY='.length));
    assert.equal(Number(preload[1]), ready.controllerPid, 'preload ran in a different process from the admitted controller');
    runtime.child.stdin.write('{"requestPath":"/tmp/runtime-preload-request"}\n');
    assert.equal((await runtime.completion).code, 0, runtime.stderr);
    assert.match(runtime.stdout, /BODY:starved:/);
  }
});

test('EOF before runtime READY removes only its retained worker demand', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const fixture = await runtimeAdmissionTransportFixture(t);
  const runtime = startRuntimeController(t, fixture);
  const waiters = join(fixture.workers.starved.admissionRoot, 'waiters');
  await waitForRuntime(async () => (await readdir(waiters).catch(() => [])).length === 1, () => runtime.stderr);
  runtime.child.stdin.end();
  assert.equal((await runtime.completion).code, 130, runtime.stderr);
  assert.deepEqual(await readdir(waiters), []);
  assert.equal(runtime.stdout, '');
});

test('native launcher hands Mac workspace execution to the configured execution-host bridge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-host-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const stackHome = join(root, 'stack-home');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackHome, { recursive: true });
  await writeFile(join(stackHome, 'execution-host.json'), '{}');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  const invocation = { cwd: repoRoot, encoding: 'utf8', env: {
    ...executionNeutralEnv, HOME: root, HAPPIER_STACK_HOME_DIR: stackHome,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    HAPPIER_STACK_EXECUTION_HOST_REENTRY: '', CI: '', HAPPIER_STACK_SANDBOX_DIR: '',
    PATH: `${binDir}:/usr/bin:/bin`,
  } };
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'literal argument'], invocation);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${repoRoot}/apps/stack/bin/../scripts/execution_host_bridge.mjs`,
    `--native-launcher=${launcher}`, '--', '--', 'probe-command', 'literal argument',
  ]);
  const local = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command'], invocation);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.stdout, 'unexpected-local\n');
});

async function memoryRoutingFixture(t, { availableKiB = 5242880, totalKiB = 28311552, roomyLoad = 4, roomyAvailableKiB = 25480397, roomyTotalKiB = 28311552, fallback = 'error' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-memory-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-memory');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  const config = {
    version: 3,
    targets: ['starved', 'roomy'].map((name) => ({
      name, platform: 'posix', ssh: `${name}-host`, repoDir: repoRoot,
      cliHomeDir: join(root, name), remotePath: [binDir, '/usr/bin', '/bin'],
    })),
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'auto', targets: ['starved', 'roomy'], includeLocal: false, fallback },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot }));
  const samplePath = join(root, 'starved-sample');
  await writeFile(samplePath, `8 0.1 ${availableKiB / totalKiB} 22000000 20 0 ${availableKiB} ${totalKiB} 0 0 0 0 0 0 0 linux\n`);
  await executable(join(binDir, 'node'), '#!/bin/sh\ncase "$*" in *service_memory.mjs*) printf "service 0\\n"; exit 0 ;; esac\nprintf "node:%s\\n" "$*" >> "$FIXTURE_TRACE"\nexit 0\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "mutagen:%s\\n" "$*" >> "$FIXTURE_TRACE"\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$*" in',
    '  *getconf*)',
    '    case "$*" in',
    '      *starved-host*) cat "$STARVED_SAMPLE" ;;',
    `      *) printf "8 ${roomyLoad} ${roomyAvailableKiB / roomyTotalKiB} 22000000 20 0 ${roomyAvailableKiB} ${roomyTotalKiB} 0 0 0 0 0 0 0 linux\\n" ;;`,
    '    esac ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *)',
    '    case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '    printf "%s\\n" "$name" >> "$DISPATCHES"',
    '    [ "${PAYLOAD_EXIT-0}" = 137 ] && exit 137',
    '    printf "remote:%s\\n" "$name" ;;',
    'esac',
    '',
  ].join('\n'));
  return {
    root, binDir, configPath, config, stackDir, samplePath,
    invocation: { cwd: repoRoot, encoding: 'utf8', env: {
      ...executionNeutralEnv, HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath, HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_HOME_DIR: join(root, 'home'), HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      // The JS entry point fills missing toolchain paths at the front. Include
      // those directories here so our OS/transport fixtures retain precedence.
      PATH: `${binDir}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      DISPATCHES: join(root, 'dispatches'),
      FIXTURE_TRACE: join(root, 'trace'),
      STARVED_SAMPLE: samplePath,
    } },
  };
}

test('automatic placement excludes mac-host unless it is in the configured command pool', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  fixture.config.targets[0].name = 'mac-host';
  fixture.config.commandExecution.targets = ['roomy'];
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const automatic = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], fixture.invocation);
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.match(automatic.stderr, /selected roomy /);
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /starved-host/);
  fixture.config.commandExecution.targets.push('mac-host');
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  await writeNativeProjectionFixture(join(fixture.stackDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(fixture.config, { repoRoot }));
  const configured = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], fixture.invocation);
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stderr, /selected mac-host /);
});

test('automatic placement flushes an eligible no-watch first-cycle worker before dispatch', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  const marker = join(fixture.root, 'flushed');
  await executable(join(fixture.binDir, 'mutagen'), [
    '#!/bin/sh',
    'printf "mutagen:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$2" in',
    '  flush) : > "$FIRST_CYCLE_MARKER" ;;',
    '  list)',
    '    scanned=0; cycles=0',
    '    if [ -e "$FIRST_CYCLE_MARKER" ]; then scanned=1; cycles=1; fi',
    '    printf "%s|Watching|false|true|%s|0/0|0/0|true|%s|0/0|0/0|active|%s|ok|0|0|WatchModeNoWatch|WatchModeNoWatch\\n" "$3" "$scanned" "$scanned" "$cycles" ;;',
    'esac',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, FIRST_CYCLE_MARKER: marker },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected starved /);
  assert.equal(result.stdout.trim(), 'remote:starved');
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  assert.ok(trace.indexOf('mutagen:sync flush') < trace.lastIndexOf('remote_execution_custody.sh'), trace);
  assert.equal((trace.match(/mutagen:sync flush/g) ?? []).length, 1);
});

test('remote admission state failure is typed before payload dispatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-admission-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await installNativeAdmissionFixture({ root });
  await mkdir(fixture.admissionRoot);
  await writeFile(join(fixture.admissionRoot, 'waiters'), 'not a directory');
  const result = spawnSync('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--failure-id=native-io-test', '--', '/bin/sh', '-c', 'echo unexpected-payload'], {
    cwd: root, encoding: 'utf8', env: executionNeutralEnv,
  });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^HSTACK_ADMISSION_UNAVAILABLE:native-io-test$/m);
});

test('automatic placement reroutes admission I/O failure with unavailable TTL and preserves payload exit 75', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *starved-host*)',
    '    case "$*" in *remote_execution_custody.sh*) ;; *) exit 0 ;; esac',
    '    printf "starved\\n" >> "$DISPATCHES"',
    '    for argument in "$@"; do remote=$argument; done',
    '    id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\(native-[A-Za-z0-9_-]*\\).*/\\1/p")',
    '    printf "HSTACK_ADMISSION_UNAVAILABLE:%s\\n" "$id" >&2',
    '    exit 75 ;;',
    '  *) printf "roomy\\n" >> "$DISPATCHES"; printf "payload-result\\n"; exit "${PAYLOAD_EXIT-0}" ;;',
    'esac',
    '',
  ].join('\n'));
  const first = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /payload-result/);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy']);
  const second = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: '75' },
  });
  assert.equal(second.status, 75, second.stderr);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'roomy']);
});

test('automatic disk rejection reroutes only this class and cannot replay a started payload', async t => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12, fallback: 'local' });
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *remote_execution_custody.sh*)',
    '  case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '  printf "%s\\n" "$name" >> "$DISPATCHES"',
    '  case "$*" in *starved-host*--heavyweight-admission*)',
    '    for argument in "$@"; do remote=$argument; done',
    '    id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\(native-[A-Za-z0-9_-]*\\).*/\\1/p")',
    '    printf "HSTACK_ADMISSION_DISK:%s\\n" "$id" >&2; exit 75 ;;',
    '  esac',
    '  printf "payload:%s\\n" "$name"; exit "${PAYLOAD_EXIT-0}" ;;',
    ' *) exit 0 ;;',
    'esac', '',
  ].join('\n'));
  const heavy = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.match(heavy.stderr, /disk budget rejected/);
  assert.match(heavy.stdout, /payload:roomy/);
  const search = spawnSync('/bin/sh', [launcher, '--', 'rg', 'source'], fixture.invocation);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, /payload:starved/, 'build disk rejection must not exclude a source search');
  const failedPayload = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: '75' },
  });
  assert.equal(failedPayload.status, 75, failedPayload.stderr);
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'starved', 'starved', 'roomy']);
});

test('native nonblocking admission certifies busy without certifying state failure', async (t) => {
  const fixture = await memoryRoutingFixture(t);
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  await executable(join(fixture.binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(fixture.binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "5242880 28311552\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  const result = spawnSync('/bin/sh', [native.launcher, '--heavyweight-admission', '--no-wait', '--class=validation', '--failure-id=busy-test', '--', '/usr/bin/printf', 'unexpected'], fixture.invocation);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^HSTACK_ADMISSION_BUSY:busy-test$/m);
  assert.doesNotMatch(result.stderr, /HSTACK_ADMISSION_UNAVAILABLE/);
});

async function installBusyAdmissionTransport(fixture) {
  // SSH is the process boundary. The native busy certification is exercised
  // separately above; no selector or admission domain logic is substituted.
  await executable(join(fixture.binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "ssh:%s\\n" "$*" >> "$FIXTURE_TRACE"',
    'case "$*" in',
    ' *getconf*) case "$*" in *starved-host*) cat "$STARVED_SAMPLE" ;; *) printf "8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n" ;; esac ;;',
    ' *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    ' *)',
    '  case "$*" in *remote_execution_custody.sh*) ;; *) exit 0 ;; esac',
    '  case "$*" in *starved-host*) name=starved ;; *) name=roomy ;; esac',
    '  printf "%s\\n" "$name" >> "$DISPATCHES"',
    '  attempts=$(wc -l < "$DISPATCHES")',
    '  case "$*" in',
    '   *--no-wait*)',
    '    if [ "$name" = starved ] || [ "$attempts" -le "${BUSY_ATTEMPTS-0}" ]; then',
    '     for argument in "$@"; do remote=$argument; done',
    '     id=$(printf "%s\\n" "$remote" | sed -n "s/.*--failure-id=\\([A-Za-z0-9_-]*\\).*/\\1/p")',
    '     printf "HSTACK_ADMISSION_BUSY:%s\\n" "$id" >&2',
    '     exit 75',
    '    fi ;;',
    '   *) printf "[preferred-execution] waiting for heavyweight admission on pinned fixture\\n" >&2 ;;',
    '  esac',
    '  printf "payload:%s\\n" "$name"; exit "${PAYLOAD_EXIT-0}" ;;',
    'esac', '',
  ].join('\n'));
}

test('automatic admission reroutes busy workers without an unavailable TTL while pins keep waiting', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12 });
  await installBusyAdmissionTransport(fixture);
  for (const payloadExit of [0, 75]) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
      ...fixture.invocation, env: { ...fixture.invocation.env, PAYLOAD_EXIT: String(payloadExit) }, timeout: 15_000,
    });
    assert.equal(result.status, payloadExit, result.stderr);
    assert.equal(result.stdout, 'payload:roomy\n');
    assert.match(result.stderr, /admission busy before dispatch.*re-evaluating/);
  }
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'starved', 'roomy']);
  const pinned = spawnSync('/bin/sh', [launcher, '--target=starved', '--', 'node', '--test', 'focused.test.mjs'], fixture.invocation);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, 'payload:starved\n');
  assert.match(pinned.stderr, /waiting for heavyweight admission on pinned/);
  const commands = (await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8')).split('\n').filter(line => line.includes('remote_execution_custody.sh') && line.includes('--heavyweight-admission'));
  assert.match(commands[0], /--no-wait/);
  assert.doesNotMatch(commands.at(-1), /--no-wait/);
});

test('automatic admission re-evaluates the pool after every worker is busy without local fallback', async (t) => {
  const fixture = await memoryRoutingFixture(t, { availableKiB: 28000000, roomyLoad: 12, fallback: 'local' });
  await installBusyAdmissionTransport(fixture);
  const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--test', 'focused.test.mjs'], {
    ...fixture.invocation, env: { ...fixture.invocation.env, BUSY_ATTEMPTS: '2' }, timeout: 25_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'payload:roomy\n');
  assert.deepEqual((await readFile(fixture.invocation.env.DISPATCHES, 'utf8')).trim().split('\n'), ['starved', 'roomy', 'starved', 'roomy']);
  assert.doesNotMatch(result.stderr, /running locally/);
});

test('hosted CI public compiler scripts execute locally on a small host and preserve nested dispatch and failure', async (t) => {
  const { root, invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 16373452 });
  // Mocked physical memory belongs to this isolated worker, not the live host
  // whose unrelated reservations must not affect the simulated CI capacity.
  const { launcher } = await installNativeAdmissionFixture({ root });
  invocation.cwd = join(root, 'native-owner');
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'corepack'), [
    '#!/bin/sh',
    'printf "script:%s:routed=%s:ci=%s:argument=%s\\n" "$3" "${HAPPIER_HSTACK_EXECUTION-unset}" "${CI-unset}" "${4-}"',
    'case "$3" in',
    '  typecheck:compiler:local) exec /bin/sh "$TEST_LAUNCHER" --script=typecheck:local -- "literal argument" ;;',
    '  typecheck:local) exit 23 ;;',
    '  *) exit 97 ;;',
    'esac',
    '',
  ].join('\n'));
  for (const configured of [true, false]) {
    const env = {
      ...invocation.env, CI: 'true', GITHUB_ACTIONS: 'true', TEST_LAUNCHER: launcher,
      npm_node_execpath: '', npm_execpath: '',
      ...(configured ? {} : {
        HAPPIER_EXEC_CONFIG_PATH: '',
        HAPPIER_STACK_STORAGE_DIR: join(invocation.env.HOME, 'unconfigured-stacks'),
      }),
    };
    const result = spawnSync('/bin/sh', [launcher, '--script=typecheck:compiler:local'], { ...invocation, env, timeout: 10_000 });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'script:typecheck:compiler:local:routed=1:ci=true:argument=',
      'script:typecheck:local:routed=1:ci=true:argument=literal argument',
    ]);
    assert.doesNotMatch(result.stderr, /heavyweight admission|memory capacity/);
    await assert.rejects(readFile(invocation.env.FIXTURE_TRACE), { code: 'ENOENT' });
    await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });

    const development = spawnSync('/bin/sh', [launcher, '--local', '--allow-local-compilation', '--script=typecheck:compiler:local'], {
      ...invocation, env: { ...env, CI: '', GITHUB_ACTIONS: '' }, timeout: 10_000,
    });
    assert.equal(development.status, 1, development.stderr);
    assert.equal(development.stdout, '');
    assert.match(development.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation')}`));

    const explicitlyAdmitted = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--', '/bin/sh', launcher, '--script=typecheck:compiler:local'], {
      ...invocation, env, timeout: 10_000,
    });
    assert.equal(explicitlyAdmitted.status, 1, explicitlyAdmitted.stderr);
    assert.equal(explicitlyAdmitted.stdout, '');
    assert.match(explicitlyAdmitted.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation')}`));

    const placedWorker = spawnSync('/bin/sh', [launcher, '--script=typecheck:compiler:local'], {
      ...invocation, env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' }, timeout: 10_000,
    });
    assert.equal(placedWorker.status, 1, placedWorker.stderr);
    assert.equal(placedWorker.stdout, '');
    assert.match(placedWorker.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation')}`));
  }
});

test('finite typecheck dispatch is granted by public script owners on remote and explicit local paths', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'corepack'), '#!/bin/sh\nprintf "dispatch=%s\\n" "${HAPPIER_TYPECHECK_DISPATCHED-}"\n');
  for (const script of ['typecheck:local', 'typecheck:compiler:local', 'check:public-sdk:finite:local']) {
    const local = spawnSync('/bin/sh', [launcher, '--local', `--script=${script}`], invocation);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, 'dispatch=1\n');
    await writeFile(invocation.env.FIXTURE_TRACE, '');
    const remote = spawnSync('/bin/sh', [launcher, `--script=${script}`], invocation);
    assert.equal(remote.status, 0, remote.stderr);
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /export HAPPIER_TYPECHECK_DISPATCHED=1;/);
  }
  const direct = spawnSync('/bin/sh', [launcher, '--local', '--script=typecheck:source:finite'], invocation);
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'dispatch=\n', 'host selection alone must not grant finite task permission');
});

test('native dispatch consumes the shared source-test, generator, compiler and admission decisions', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  for (const { args, kind, component } of [
    { args: ['node', '--conditions=happier-source', '--import', 'tsx', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], kind: 'source-test', component: 'apps/stack' },
    { args: ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'], kind: 'source-test', component: 'packages/plugin-sdk' },
    { args: ['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs'], kind: 'runtime', component: 'apps/ui' },
    { args: ['node', '--test', 'apps/stack/scripts/config.test.mjs'], kind: 'runtime', component: 'apps/stack' },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'], kind: 'runtime', component: 'apps/cli' },
    { args: ['node', '--conditions=happier-source', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check', '--scope', 'projections'], kind: 'source-test', component: 'apps/cli' },
    { args: ['tsc', '-p', 'apps/cli/tsconfig.json'], kind: 'typecheck', component: 'apps/cli' },
    { args: ['yarn', '-s', 'lint'], kind: 'runtime', component: '' },
  ]) {
    await writeFile(invocation.env.FIXTURE_TRACE, '');
    const result = spawnSync('/bin/sh', [launcher, '--', ...args], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n', args.join(' '));
    const trace = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
    assert.match(trace, /remote_dependency_bootstrap\.mjs/);
    assert.ok(trace.includes('--validation-kind=' + kind), trace);
    assert.ok(trace.includes('--component-relative-dir=' + component), trace);
    if (component) assert.match(trace, /remote_validation_preparation\.mjs/);
  }
  await writeFile(invocation.env.FIXTURE_TRACE, '');
  const control = spawnSync('/bin/sh', [launcher, '--', 'node', '-e', 'console.log("control")'], invocation);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(control.stdout, 'remote:starved\n');
  assert.doesNotMatch(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /remote_dependency_bootstrap\.mjs|remote_validation_preparation\.mjs/);
});

for (const dispatcher of ['native', 'javascript']) {
  const dispatch = (invocation, args) => dispatcher === 'native'
    ? spawnSync('/bin/sh', [launcher, '--', ...args], invocation)
    : spawnSync(process.execPath, [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', ...args], invocation);

  test(`queue policy ${dispatcher}: all memory-busy targets remain remotely eligible`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 0, roomyAvailableKiB: 5242880, fallback: 'local' });
    const result = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n');
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /--heavyweight-admission/);
    assert.doesNotMatch(result.stderr, /running locally|insufficient validation memory/);
  });

  test(`compilation capacity ${dispatcher}: typechecks and builds exclude small workers but focused tests remain eligible`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640, roomyLoad: 80, roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
    const focused = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(focused.status, 0, focused.stderr);
    assert.equal(focused.stdout, 'remote:starved\n');
    for (const args of [
      ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
      ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'build'],
      ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/ui/tsconfig.source.json'],
    ]) {
      const result = dispatch(invocation, args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'remote:roomy\n', args.join(' '));
      assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /--class=compilation/);
    }
    const focusedAgain = dispatch(invocation, ['vitest', 'run', 'fixture.test.ts']);
    assert.equal(focusedAgain.status, 0, focusedAgain.stderr);
    assert.equal(focusedAgain.stdout, 'remote:starved\n');
  });

  test(`compilation capacity ${dispatcher}: an undersized fleet fails visibly without local fallback`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640, roomyAvailableKiB: 14680064, roomyTotalKiB: 15728640, fallback: 'local' });
    const result = dispatch(invocation, ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation-ui')}`));
    assert.doesNotMatch(result.stderr, /running locally/);
    await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
  });

  test(`workload admission ${dispatcher}: package builds use a 15 GiB worker while full daemon builds and UI typechecks do not`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 15728640, totalKiB: 16777216, roomyLoad: 80, roomyAvailableKiB: 41943040, roomyTotalKiB: 50331648 });
    for (const args of [
      ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'],
      ['node', 'packages/cli-common/scripts/build.mjs'],
      ['corepack', 'yarn', '--cwd', 'packages/protocol', '-s', 'build:finite'],
      ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'],
      ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'],
      ['corepack', 'yarn', '--cwd', 'packages/unmeasured', '-s', 'build'],
    ]) {
      await writeFile(invocation.env.FIXTURE_TRACE, '');
      const result = dispatch(invocation, args);
      assert.equal(result.status, 0, result.stderr);
      const runtime = args.some(arg => arg.startsWith('--worker-request='));
      const small = args.join(' ').includes('packages/cli-common') || args.join(' ').includes('packages/protocol');
      assert.equal(result.stdout, small ? 'remote:starved\n' : 'remote:roomy\n', args.join(' '));
      assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), runtime ? /--class=runtime-build/ : small ? /--class=package-dist/ : /--class=compilation/);
    }
  });

  test(`compilation capacity ${dispatcher}: capable workers remain eligible while memory is busy`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t, { availableKiB: 0, roomyAvailableKiB: 5242880, roomyTotalKiB: 50331648, fallback: 'local' });
    const result = dispatch(invocation, ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:roomy\n');
    assert.doesNotMatch(result.stderr, /running locally/);
  });

  for (const allFail of [false, true]) {
    test(`queue policy ${dispatcher}: sync failure ${allFail ? 'on every reachable target cannot fall back locally' : 'retries the next reachable target'}`, async (t) => {
      const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
      const binDir = invocation.env.PATH.split(':')[0];
      await executable(join(binDir, 'mutagen'), [
        '#!/bin/sh',
        'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; exit 0; fi',
        allFail ? 'exit 73' : '[ "$3" != happier-starved ] || exit 73',
        'exit 0', '',
      ].join('\n'));
      await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
      const result = dispatch(invocation, ['probe-command']);
      if (allFail) {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
        assert.match(result.stderr, /synchronization|sync.*flush/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'remote:roomy\n');
        assert.equal(await readFile(invocation.env.DISPATCHES, 'utf8'), 'roomy\n');
      }
      assert.doesNotMatch(result.stderr, /running locally/);
    });
  }

  for (const status of [76, 255]) {
    test(`queue policy ${dispatcher}: ${status === 255 ? 'unreachable fleet permits configured local fallback' : 'reachable prerequisite failure cannot fall back locally'}`, async (t) => {
      const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
      const binDir = invocation.env.PATH.split(':')[0];
      await executable(join(binDir, 'ssh'), `#!/bin/sh\nexit ${status}\n`);
      await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local-fallback\\n"\n');
      const result = dispatch(invocation, ['probe-command']);
      assert.equal(result.status, status === 255 ? 0 : 1, result.stderr);
      assert.equal(result.stdout, status === 255 ? 'local-fallback\n' : '');
      if (status === 255) assert.match(result.stderr, /no remote execution target is reachable.*running locally/);
      else assert.doesNotMatch(result.stderr, /running locally/);
    });
  }

  test(`memory-aware ${dispatcher} dispatcher avoids a low-CPU target below validation headroom`, async (t) => {
    const { invocation } = await memoryRoutingFixture(t);
    const result = dispatcher === 'native'
      ? spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation)
      : spawnSync(process.execPath, [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
    assert.equal(result.status, 0, `${result.stderr}\n${await readFile(invocation.env.FIXTURE_TRACE, 'utf8').catch(() => '')}`);
    assert.equal(result.stdout, 'remote:roomy\n');
  });
}

test('memory-aware cache ranks heavyweight work using a trivial command reachable result', async (t) => {
  const { invocation, stackDir } = await memoryRoutingFixture(t);
  const trivial = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(trivial.status, 0, trivial.stderr);
  assert.equal(trivial.stdout, 'remote:starved\n');
  const heavy = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(heavy.status, 0, heavy.stderr);
  assert.equal(heavy.stdout, 'remote:roomy\n');
  assert.match(await readFile(join(stackDir, 'dev-target-command-load-native', 'starved.cache'), 'utf8'), /^\d+ 1 /);
});

test('typecheck affinity prefers the most recently completed project worker and falls back immediately when busy', async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const args = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/cli/tsconfig.source.json'];
  const warm = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', ...args], fixture.invocation);
  assert.equal(warm.status, 0, warm.stderr);
  const repeat = spawnSync('/bin/sh', [launcher, '--', ...args, '--pretty', 'false'], fixture.invocation);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, 'remote:roomy\n', 'warm worker should win despite higher load');
  const other = spawnSync('/bin/sh', [launcher, '--', ...args.slice(0, -1), 'apps/ui/tsconfig.source.json'], fixture.invocation);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.stdout, 'remote:starved\n', 'another project must use normal selection');
  await installBusyAdmissionTransport(fixture);
  // The warm target is starved for the UI project. Actual nonblocking admission
  // rejects it; AUTO must immediately use the other worker, without a TTL.
  const fallback = spawnSync('/bin/sh', [launcher, '--', ...args.slice(0, -1), 'apps/ui/tsconfig.source.json'], {
    ...fixture.invocation, timeout: 15000,
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stdout, 'payload:roomy\n');
  assert.match(fallback.stderr, /admission busy before dispatch/);
  assert.doesNotMatch(fallback.stderr, /waiting for pool|running locally/);
});

test('warm project preference also applies to other compilation-class checks without coalescing builds', async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const args = ['yarn', '--cwd', 'apps/cli', '-s', 'build'];
  const warm = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', ...args], fixture.invocation);
  assert.equal(warm.status, 0, warm.stderr);
  const repeat = spawnSync('/bin/sh', [launcher, '--', ...args], fixture.invocation);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, 'remote:roomy\n');
  assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), /typecheck_dispatch\.mjs/);
});

test('in-flight typecheck demand stays on its leader worker and every follower flushes', { timeout: 20000 }, async t => {
  const fixture = await memoryRoutingFixture(t, {
    availableKiB: 40000000, totalKiB: 45000000,
    roomyAvailableKiB: 40000000, roomyTotalKiB: 45000000, roomyLoad: 12,
  });
  const ssh = join(fixture.binDir, 'ssh');
  const original = await readFile(ssh, 'utf8');
  await executable(ssh, original.replace('printf "remote:%s\\n" "$name"', `printf "remote:%s\\n" "$name"
    if [ "\${HOLD_TYPECHECK-0}" = 1 ]; then
      while [ ! -f "$RELEASE_TYPECHECK" ]; do sleep 0.02; done
    fi`));
  const args = ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/cli/tsconfig.source.json'];
  const release = join(fixture.root, 'release');
  const leader = spawn('/bin/sh', [launcher, '--target=roomy', '--', ...args], {
    ...fixture.invocation, env: { ...fixture.invocation.env, HOLD_TYPECHECK: '1', RELEASE_TYPECHECK: release },
  });
  t.after(() => { if (leader.exitCode === null) leader.kill('SIGTERM'); });
  const completed = new Promise(resolve => leader.once('close', resolve));
  let output = '';
  leader.stdout.on('data', data => { output += data; });
  leader.stderr.resume();
  await waitForRuntime(() => output.includes('remote:roomy'), () => output);
  // A shared cache can be read from another PID namespace. Keep the real
  // controller's flock held, but make its recorded PID/start identity resolve
  // to a different incarnation in this caller, as that boundary does live.
  const cacheDir = join(fixture.stackDir, 'dev-target-command-load-native');
  const reservation = (await readdir(cacheDir)).find(name => name.startsWith('roomy.active.'));
  assert.ok(reservation, 'the running leader must own a dispatch reservation');
  const reservationPath = join(cacheDir, reservation);
  const record = (await readFile(reservationPath, 'utf8')).split('\n');
  record[0] = String(process.pid);
  record[3] = '0';
  await writeFile(reservationPath, record.join('\n'));
  try {
    const probe = spawnSync('/bin/sh', [launcher, '--target=roomy', '--', 'probe-command'], fixture.invocation);
    assert.equal(probe.status, 0, probe.stderr);
    assert.doesNotMatch(await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8'), new RegExp(`reaping remote execution ${record[2]}`), 'an unrelated command must not cancel the live leader');
    assert.match(probe.stderr, /selected roomy .*active=1/, 'a held kernel lock must count even when its controller PID is not current here');
    const follower = spawnSync('/bin/sh', [launcher, '--', ...args], fixture.invocation);
    assert.equal(follower.status, 0, follower.stderr);
    assert.equal(follower.stdout, 'remote:roomy\n', 'follower must reach the existing flight instead of a colder worker');
  } finally {
    await writeFile(release, '');
    assert.equal(await completed, 0);
  }
  const trace = await readFile(fixture.invocation.env.FIXTURE_TRACE, 'utf8');
  assert.equal((trace.match(/mutagen:sync flush/g) ?? []).length, 3, 'each caller needs its own causal barrier');
});

test('memory-aware exit 137 carries target memory evidence without replaying an authoritative command', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    ...invocation, env: { ...invocation.env, PAYLOAD_EXIT: '137' },
  });
  assert.equal(result.status, 137, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /137.*SIGKILL.*possible.*(?:OOM|out.of.memory)/i);
  assert.match(result.stderr, /starved.*5242880.*28311552/);
  assert.equal(await readFile(invocation.env.DISPATCHES, 'utf8'), 'starved\n');
});

test('memory-aware placement weighs memory pressure above the absolute admission floor', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 8388608 });
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:roomy\n');
});

test('memory-aware Darwin probe measures absolute headroom through the native dispatch path', async (t) => {
  const { invocation, stackDir } = await memoryRoutingFixture(t);
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\ncase "$*" in *hw.memsize*) printf "28991029248\\n" ;; *) printf "{ 0.1 0.1 0.1 }\\n" ;; esac\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nif [ "$FIXTURE_REMOTE_TARGET" = starved ]; then ratio=18; else ratio=90; fi\nprintf "System-wide memory free percentage: %s%%\\n" "$ratio"\n');
  // Mock the remote login-shell boundary while executing its real probe body.
  await executable(join(binDir, 'bash'), '#!/bin/sh\n[ "$1" = -lc ] && shift\nexec /bin/sh -c "$1"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    'case "$*" in',
    '  *getconf*)',
    '    case "$*" in *starved-host*) FIXTURE_REMOTE_TARGET=starved ;; *) FIXTURE_REMOTE_TARGET=roomy ;; esac',
    '    export FIXTURE_REMOTE_TARGET',
    '    exec /bin/sh -c "$last_argument" ;;',
    '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *) printf "remote:roomy\\n" ;;',
    'esac', '',
  ].join('\n'));
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected roomy/);
  const telemetry = (await readFile(join(stackDir, 'dev-target-command-load-native', 'starved.telemetry'), 'utf8')).trim().split(' ');
  assert.equal(telemetry[15], 'darwin');
  assert.equal(Number(telemetry[7]), 28311552);
  assert.ok(Number(telemetry[6]) > 0 && Number(telemetry[6]) < 6291456);
});

test('memory-aware placement admits validation at the measured floor', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 6291456, roomyLoad: 80 });
  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:starved\n');
});

test('memory-aware memory-limited samples retain the positive TTL and recover after expiry', async (t) => {
  const { invocation, stackDir, samplePath } = await memoryRoutingFixture(t);
  const run = () => spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], invocation);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, 'remote:roomy\n');
  const traceBefore = await readFile(invocation.env.FIXTURE_TRACE, 'utf8');
  await writeFile(samplePath, '8 0.1 0.99 22000000 20 0 28028436 28311552 0 0 0 0 0 0 0 linux\n');
  const cached = run();
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(cached.stdout, 'remote:roomy\n');
  const countProbes = (trace) => trace.split('\n').filter((line) => line.includes('cpu=$(getconf')).length;
  assert.equal(countProbes(await readFile(invocation.env.FIXTURE_TRACE, 'utf8')), countProbes(traceBefore));
  const cachePath = join(stackDir, 'dev-target-command-load-native', 'starved.cache');
  const cache = await readFile(cachePath, 'utf8');
  await writeFile(cachePath, cache.replace(/^\d+/, String(Math.floor(Date.now() / 1000) - 16)));
  const recovered = run();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, 'remote:starved\n');
});

test('memory-aware cache preserves optional fields in a short probe sample', async (t) => {
  const { invocation, samplePath } = await memoryRoutingFixture(t);
  await writeFile(samplePath, '8 0.1 0.9\n');
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'remote:starved\n');
  }
});

for (const { admissionClass, belowFloorKiB, floorKiB, nested = false } of [
  { admissionClass: 'validation', belowFloorKiB: 5242880, floorKiB: 6291456 },
  { admissionClass: 'runtime-build', belowFloorKiB: 15728640, floorKiB: 18874368 },
  { admissionClass: 'compilation', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation') - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation') },
  { admissionClass: 'compilation', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation') - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation'), nested: true },
]) {
test(`memory-aware ${admissionClass} target admission${nested ? ' beneath focused admission' : ''} waits below its measured floor`, { timeout: 30_000 }, async (t) => {
  const totalKiB = 50331648;
  const { invocation, samplePath } = await memoryRoutingFixture(t, { availableKiB: belowFloorKiB, totalKiB });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;;',
    '  */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\ncount=0; for owner in "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT"/owners/*; do [ ! -d "$owner" ] || count=$((count + 1)); done\n[ "$count" = 1 ] || exit 99\nprintf "admitted\\n"\n');
  const directArgs = [launcher, '--heavyweight-admission', `--class=${admissionClass}`, '--machine=fixture', '--', 'probe-command'];
  const args = nested ? [launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--', '/bin/sh', ...directArgs] : directArgs;
  const child = spawn('/bin/sh', args, { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
  let stderr = '';
  let stdout = '';
  let recovery;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (!recovery && stderr.includes(`memory-available=${belowFloorKiB}/${totalKiB}`)) {
      assert.equal(stdout, '');
      const availableKiB = stderr.includes(`requires=${floorKiB} `) ? floorKiB : 41943040;
      recovery = writeFile(samplePath, `8 0.1 0.5 22000000 20 0 ${availableKiB} ${totalKiB} 0 0 0 0 0 0 0 linux\n`);
    }
  });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  await recovery;
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`waiting.*memory-available=${belowFloorKiB}/${totalKiB}`));
  assert.match(stderr, new RegExp(`requires=${floorKiB} KiB`));
  assert.equal(stdout, 'admitted\n');
});
}

test('compilation capacity target admission rejects a physically undersized machine directly and beneath focused admission', { timeout: 30_000 }, async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { availableKiB: 14680064, totalKiB: 15728640 });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-admission\\n"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "unexpected-admission\\n"\n');
  const directArgs = [launcher, '--heavyweight-admission', '--class=compilation', '--machine=fixture', '--', 'probe-command'];
  for (const ci of ['', 'true']) {
    for (const args of [directArgs, [launcher, '--heavyweight-admission', '--class=validation', '--machine=fixture', '--', '/bin/sh', ...directArgs], ...(ci === '' ? [[launcher, '--local', '--allow-local-compilation', '--', 'tsc', '--noEmit']] : [])]) {
      const result = spawnSync('/bin/sh', args, { ...invocation, env: { ...invocation.env, CI: ci }, timeout: 10_000 });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`memory capacity.*compilation.*${resolveHeavyweightMemoryFloorKiB('compilation')}`));
      assert.match(result.stderr, /route remotely/);
    }
  }
});

for (const { commandArgs, admissionClass, belowFloorKiB, floorKiB } of [
  { commandArgs: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'], admissionClass: 'package-dist', belowFloorKiB: 4194304, floorKiB: 8388608 },
  { commandArgs: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], admissionClass: 'compilation-ui', belowFloorKiB: resolveHeavyweightMemoryFloorKiB('compilation-ui', { machine: 'local' }) - 1, floorKiB: resolveHeavyweightMemoryFloorKiB('compilation-ui', { machine: 'local' }) },
  { commandArgs: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], admissionClass: 'runtime-build', belowFloorKiB: 15728640, floorKiB: 18874368 },
]) {
test(`workload admission explicit local ${admissionClass} waits for memory, keeps light commands runnable and recovers at its floor`, { timeout: 30_000 }, async (t) => {
  const { invocation, samplePath } = await memoryRoutingFixture(t, { availableKiB: belowFloorKiB, totalKiB: 50331648 });
  const { launcher } = await installNativeAdmissionFixture({ root: invocation.env.HOME });
  invocation.cwd = resolve(launcher, '../../../..');
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await executable(join(binDir, 'corepack'), '#!/bin/sh\nprintf "package-built\\n"\n');
  await executable(join(binDir, 'node'), '#!/bin/sh\ncase "$*" in *service_memory.mjs*) printf "service 0\\n" ;; *) printf "package-built\\n" ;; esac\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "light-ran\\n"\n');
  const child = spawn('/bin/sh', [launcher, '--local', '--allow-local-compilation', '--', ...commandArgs], { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
  let stderr = '', stdout = '', recovery;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (!recovery && stderr.includes('waiting for heavyweight admission')) {
      assert.equal(stdout, '');
      const light = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command'], invocation);
      assert.equal(light.status, 0, light.stderr);
      assert.equal(light.stdout, 'light-ran\n');
      // Release the old class too, so RED reports the wrong admission class
      // rather than leaving a live waiter until the harness times out.
      const availableKiB = stderr.includes('class=' + admissionClass) && stderr.includes(`requires=${floorKiB} `) ? floorKiB : 41943040;
      recovery = writeFile(samplePath, `8 0.1 0.5 22000000 20 0 ${availableKiB} 50331648 0 0 0 0 0 0 0 linux\n`);
    }
  });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  await recovery;
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`waiting for heavyweight admission.*class=${admissionClass}.*memory-available=${belowFloorKiB}`));
  assert.match(stderr, new RegExp(`requires=${floorKiB} KiB`));
  assert.equal(stdout, 'package-built\n');
});
}

test('queue policy cwd: outside-repository routing refuses with paths and a recovery action', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const outside = invocation.env.HOME;
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], { ...invocation, cwd: outside });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(outside), result.stderr);
  assert.ok(result.stderr.includes(repoRoot), result.stderr);
  assert.match(result.stderr, /cd|--cwd/);
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
});

test('queue policy cwd: source-dev publication and already-placed children may use fixture directories', async (t) => {
  const { invocation } = await memoryRoutingFixture(t);
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\npwd -P\n');
  for (const options of [
    // syncSharedDepsForSourceDev uses this explicit machine-authority path.
    { args: ['--local', '--', 'probe-command'], env: { HAPPIER_HSTACK_DISPATCH_CONTROL: '1' } },
    { args: ['--', 'probe-command'], env: { HAPPIER_DEV_TARGET_EXECUTION: '1' } },
  ]) {
    const result = spawnSync('/bin/sh', [launcher, ...options.args], {
      ...invocation, cwd: invocation.env.HOME, env: { ...invocation.env, ...options.env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), invocation.env.HOME);
  }
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
});

test('queue policy native: controller state failure cannot redirect a reachable remote command locally', async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
  const binDir = invocation.env.PATH.split(':')[0];
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  await executable(join(binDir, 'mktemp'), '#!/bin/sh\ncase "$*" in *.active.tmp.*) exit 1 ;; *) exec /usr/bin/mktemp "$@" ;; esac\n');
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /running locally/);
  await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
});

for (const masterState of ['unavailable', 'contended']) {
test(`queue policy native: ${masterState} SSH master ${masterState === 'contended' ? 'waits without a fresh connection and remains cancellable' : 'uses the reachable direct command connection'}`, async (t) => {
  const { invocation } = await memoryRoutingFixture(t, { fallback: 'local' });
  const binDir = invocation.env.PATH.split(':')[0];
  const sshPath = join(binDir, 'ssh');
  const sshSource = await readFile(sshPath, 'utf8');
  await executable(sshPath, sshSource.replace('case "$*" in', 'last=; for arg in "$@"; do last=$arg; done\n[ "$last" = : ] && exit 0\ncase "$*" in\n  *-MNf*) exit 255 ;;'));
  if (masterState === 'contended') {
    // Filesystem is a real boundary: a different live creator owns the socket.
    // Waiting must stay cancellable and must not open a direct connection.
    await executable(join(binDir, 'mkdir'), '#!/bin/sh\nlast=; for arg in "$@"; do last=$arg; done\ncase "$last" in *.lock) /bin/mkdir -p "$last"; printf "%s\\n" "$MASTER_CREATOR_PID" > "$last/pid"; exit 1 ;; esac\nexec /bin/mkdir "$@"\n');
    invocation.env.MASTER_CREATOR_PID = String(process.pid);
  }
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "unexpected-local\\n"\n');
  if (masterState === 'contended') {
    const child = spawn('/bin/sh', [launcher, '--', 'probe-command'], { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
    const completion = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(child.exitCode, null);
      await assert.rejects(readFile(invocation.env.DISPATCHES), { code: 'ENOENT' });
    } finally { child.kill('SIGTERM'); await completion; }
    return;
  }
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], invocation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:starved\n');
  assert.equal(await readFile(invocation.env.DISPATCHES, 'utf8'), 'starved\n');
});
}

for (const dispatcher of ['native', 'javascript', 'pinned']) {
  test(`queue policy ${dispatcher}: routed work recovers from real target admission pressure`, { timeout: 30_000 }, async (t) => {
    const { invocation, samplePath } = await memoryRoutingFixture(t, { roomyAvailableKiB: 5242880, fallback: 'local' });
    const { launcher: fixtureLauncher } = await installNativeAdmissionFixture({ root: invocation.env.HOME });
    const checkout = resolve(fixtureLauncher, '../../../..');
    const config = JSON.parse(await readFile(invocation.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
    for (const target of config.targets) target.repoDir = checkout;
    await writeFile(invocation.env.HAPPIER_EXEC_CONFIG_PATH, JSON.stringify(config));
    await writeNativeProjectionFixture(join(invocation.env.HAPPIER_STACK_STORAGE_DIR, 'repo-memory', 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot: dispatcher !== 'javascript' ? checkout : repoRoot }));
    if (dispatcher !== 'javascript') invocation.cwd = checkout;
    const binDir = invocation.env.PATH.split(':')[0];
    await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
    // SSH and procfs are genuine system boundaries. Run the real dispatched
    // shell, heavyweight admission, queue and reentrant descendant path.
    await executable(join(binDir, 'awk'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */proc/meminfo*) /usr/bin/awk \'{print $7, $8}\' "$STARVED_SAMPLE" ;;',
      '  */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;;',
      '  *) exec /usr/bin/awk "$@" ;;',
      'esac', '',
    ].join('\n'));
    await executable(join(binDir, 'ssh'), [
      '#!/bin/sh',
      'last=; for arg in "$@"; do last=$arg; done',
      '[ "$last" = : ] && exit 0',
      'case "$*" in',
      '  *getconf*) cat "$STARVED_SAMPLE" ;;',
      '  *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;',
      '  *) exec /bin/sh -c "$last" ;;',
      'esac', '',
    ].join('\n'));
    await executable(join(binDir, 'vitest'), '#!/bin/sh\nprintf "queued-remote-result\\n"\n');
    const args = dispatcher !== 'javascript'
      ? [fixtureLauncher, ...(dispatcher === 'pinned' ? ['--target=starved'] : []), '--', 'vitest', 'run', 'fixture.test.ts']
      : [join(import.meta.dirname, 'dev_targets.mjs'), 'exec', 'auto', '--stack=repo-memory', '--', 'vitest', 'run', 'fixture.test.ts'];
    const child = spawn(dispatcher !== 'javascript' ? '/bin/sh' : process.execPath, args, { ...invocation, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
    let stdout = '', stderr = '', recovery;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!recovery && /memory-available=5242880\/28311552|admission busy before dispatch/.test(stderr)) {
        assert.equal(stdout, '');
        recovery = writeFile(samplePath, '8 0.1 0.9 22000000 20 0 25480397 28311552 0 0 0 0 0 0 0 linux\n');
      }
    });
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    await recovery;
    assert.equal(code, 0, stderr);
    assert.ok(recovery, stderr);
    assert.match(stderr, dispatcher === 'pinned' ? /waiting for heavyweight admission on .*memory-available/ : /admission busy before dispatch.*re-evaluating/);
    assert.equal(stdout, 'queued-remote-result\n');
    assert.doesNotMatch(stderr, /running locally/);
    assert.match(await readFile(invocation.env.FIXTURE_TRACE, 'utf8'), /remote_dependency_bootstrap\.mjs/);
  });
}

test('native launcher bypasses Node when no repository target configuration can exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const tokenToolMarker = join(root, 'token-tool-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  for (const command of ['dirname', 'basename', 'tr', 'sed']) {
    await executable(
      join(binDir, command),
      `#!/bin/sh\nprintf '%s\\n' ${command} >> "${tokenToolMarker}"\nexec /usr/bin/${command} "$@"\n`,
    );
  }
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "direct:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'direct:ok\n');
  await assert.rejects(readFile(tokenToolMarker), { code: 'ENOENT' });
});

test('automatic local execution does not pin descendant commands to the local host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-env-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "%s\\n" "${HAPPIER_PREFERRED_EXECUTION-unset}"\n',
  );

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'unset\n');
});

test('explicit local execution is selected per invocation without consulting target configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "local:%s:routed=%s\\n" "$1" "${HAPPIER_HSTACK_EXECUTION-unset}"\n',
  );

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok:routed=1\n');
  assert.match(
    result.stderr,
    /explicit --local bypasses automatic load distribution/u,
  );

  const protectedResult = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command', 'internal'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_HSTACK_DISPATCH_CONTROL: '1',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(protectedResult.status, 0, protectedResult.stderr);
  assert.equal(protectedResult.stdout, 'local:internal:routed=1\n');
  assert.doesNotMatch(
    protectedResult.stderr,
    /explicit --local bypasses automatic load distribution/u,
  );
});

test('explicit local execution preserves placement while applying the adaptive nested-worker budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-local-budget-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const repoRoot = resolve(launcher, '../../../..');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "24\\n" ;;',
    '  */proc/pressure/cpu*) printf "0\\n" ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  */proc/meminfo*) printf "48000000 72000000\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s\\n" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'rg'), '#!/bin/sh\nprintf "rg:%s\\n" "$*"\n');

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /explicit --local bypasses automatic load distribution/u);
  assert.match(result.stdout, /workers:2:1:2:1/);
  assert.match(result.stdout, /args:run fixture\.test\.ts --maxWorkers=2 --minWorkers=1/);

  const search = spawnSync('/bin/sh', [launcher, '--local', '--', 'rg', 'needle', 'sources'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stderr, /explicit --local bypasses automatic load distribution/u);
  assert.equal(search.stdout, 'rg:--threads=2 needle sources\n');
});

test('automatic dispatch protects control work while keeping a selected local payload in the jobs slice', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dispatch-control-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const scopeLog = join(root, 'systemd-run.log');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='0'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), '#!/bin/sh\nexit 255\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 0.1 0.1 0.1 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 80%%\\n"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "payload:%s\\n" "$1"\n');
  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *happier-critical.slice*) printf "LoadState=loaded\\nMemoryLow=4294967296\\n" ;;',
    '  *happier-jobs.slice*) printf "loaded\\n" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SCOPE_LOG"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --slice=*) export TEST_CURRENT_CGROUP=/user.slice/${1#--slice=}/fixture.scope ;; esac',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'sed'), '#!/bin/sh\ncase "$*" in *"/proc/self/cgroup") printf "%s\\n" "${TEST_CURRENT_CGROUP-/user.slice/unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      DBUS_SESSION_BUS_ADDRESS: 'test-user-bus',
      PATH: `${binDir}:/usr/bin:/bin`,
      SCOPE_LOG: scopeLog,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'payload:ok\n');
  const scopes = await readFile(scopeLog, 'utf8');
  assert.match(scopes, /--slice=happier-critical\.slice .*hstack-exec.*probe-command ok/);
  // Routed tests may already inherit a lower background scheduling priority.
  assert.match(scopes, /--slice=happier-jobs\.slice --nice=1[0-9] -- probe-command ok/);
});

test('Yarn workspace validation receives the remote workload governor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-workspace-validation-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='0'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "14 360 0.8 22000000 20 420 48000000 72000000 0 0 90 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; printf "remote:%s\\n" "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'yarn', 'workspace', '@happier-dev/app', 'test', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VITEST_MAX_THREADS=.*1/);
  assert.match(result.stdout, /VITEST_MIN_THREADS=.*1/);
  assert.match(result.stdout, /nice -n 10/);
  for (const argument of ['yarn', 'workspace', '@happier-dev/app', 'test', 'fixture.test.ts']) {
    assert.match(result.stdout, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(result.stdout, /--maxWorkers=1|--minWorkers=1/);
});

test('native launcher keeps Git commands on the authoritative checkout without probing a replica', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-git-authority-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  const remoteMarker = join(root, 'remote-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    "primary_only_direct_commands='git'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'git'), '#!/bin/sh\nprintf "local-git:%s\\n" "$*"\n');
  // This fixture observes Git placement; dedicated admission tests exercise
  // the systemd boundary without borrowing a live user scope.
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\nprintf 'happier-linux|Scanning|7||false|0\\n'\n`);
  await executable(join(binDir, 'ssh'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\ncase "$*" in *getconf*) printf '8 1 0.5 9999999 10\\n' ;; esac\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', 'git', 'status'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local-git:status\n');
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
});

test('native launcher keeps bundled-plugin publication on the authoritative checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-plugin-writer-authority-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  const remoteMarker = join(root, 'remote-called');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    "primary_only_direct_commands='git'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-writer:%s\\n" "$*"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\nprintf 'happier-linux|Scanning|7||false|0\\n'\n`);
  await executable(join(binDir, 'ssh'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\ncase "$*" in *getconf*) printf '8 1 0.5 9999999 10\\n' ;; esac\n`);
  const generatorArguments = [
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
    '--mode',
    'write',
  ];
  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const result = spawnSync('/bin/sh', [launcher, '--', ...generatorArguments], invocation);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local-writer:--experimental-strip-types .* --mode write/u);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });

  const canonicalDefaultWriter = spawnSync('/bin/sh', [
    launcher,
    '--',
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
  ], invocation);
  assert.equal(canonicalDefaultWriter.status, 0, canonicalDefaultWriter.stderr);
  assert.match(
    canonicalDefaultWriter.stdout,
    /local-writer:--experimental-strip-types apps\/cli\/scripts\/build-owned\/generateBundledPluginEntries\.ts/u,
  );
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });

  const explicitRemote = spawnSync('/bin/sh', [launcher, '--target=linux', '--', ...generatorArguments], invocation);
  assert.equal(explicitRemote.status, 1);
  assert.match(explicitRemote.stderr, /bundled-plugin projection writer must execute on the authoritative primary checkout/u);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
});

test('native launcher uses Node once to publish a stale validated projection, then executes natively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-test`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n', 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(
    await readFile(join(stackDir, 'dev-target-exec-v1.sh'), 'utf8'),
    /^command_mode='local'$/m,
  );
});

test('native launcher discovers the matching repository projection when its directory name is not the stack token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-renamed-workspace-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-stack-unrelated-token');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='error'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) case "$*" in *ControlPath=none*) printf "8 1 0.5 22000000 10\\n" ;; *) exit 255 ;; esac ;;',
    '  *command\\ -v*) case "$*" in *ControlPath=none*) exit 0 ;; *) exit 255 ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };
  const localResult = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/printf', 'preserved-command\n'], invocation);
  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command'], invocation);

  assert.equal(localResult.status, 0, localResult.stderr);
  assert.equal(localResult.stdout, 'preserved-command\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:/);
});

test('native launcher refreshes an explicit stale projection instead of silently falling back locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='1'",
    `projection_repo_root='${repoRoot}'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(projectionPath, 'utf8'), /^HSTACK_EXEC_PROJECTION_VERSION='2'$/m);
});

test('native launcher preserves the canonical repository cwd boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cwd-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "node:%s\\n" "$*"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: root,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /working directory must stay inside the repository/i);
  assert.equal(result.stdout, '');
});

test('remote heavyweight admission starts from the configured repository when SSH login cwd is external', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-cwd-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const repoRoot = join(root, 'native-owner');
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='darwin'",
    "target_1_ssh='darwin-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "remote-tsc\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "4 0.1 0.9 22000000 20 0 48000000 72000000 0 0 0 0 0 0 0 darwin\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    cd -- "$REMOTE_LOGIN_CWD"',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'tsc', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      REMOTE_LOGIN_CWD: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote-tsc\n');
});

test('native launcher reuses one SSH master across sequential and concurrent commands for the same target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-shared-ssh-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const masterStarts = join(root, 'master-starts');
  const heldCommandStarted = join(root, 'held-command-started');
  const releaseHeldCommand = join(root, 'release-held-command');
  const masterCreating = join(root, 'master-creating');
  const releaseMaster = join(root, 'release-master');
  const configuredControlPath = join(root, 'runtime', 'configured-master');
  const provenancePath = join(stackDir, 'dev-target-command-load-native', 'provenance.jsonl');
  const historicalProvenance = JSON.stringify({ phase: 'completed', executionId: 'historical', target: 'x'.repeat(1024 * 1024) });
  const runtimeDir = join(root, 'runtime');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  const sshConfig = join(root, 'ssh.config');
  await writeFile(sshConfig, `Host linux-host\n  ControlMaster auto\n  ControlPath ${configuredControlPath}\n`);
  await mkdir(join(stackDir, 'dev-target-command-load-native'));
  await writeFile(provenancePath, `${historicalProvenance}\n`);
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    `target_1_ssh_config='${sshConfig}'`,
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), [
    '#!/bin/sh',
    'if [ "$1" = hold ]; then',
    '  : > "$HELD_COMMAND_STARTED"',
    '  while [ ! -e "$RELEASE_HELD_COMMAND" ]; do sleep 0.02; done',
    'fi',
    'printf "remote:%s\\n" "$1"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case " $* " in',
    '  *" -G "*) printf "controlpath %s\\n" "$CONFIGURED_CONTROL_PATH" ;;',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -S "$control_path" ] || [ -f "$control_path" ] ;;',
    '  *-MNf*) if [ "${DELAY_MASTER_START-}" = 1 ]; then : > "$MASTER_CREATING"; while [ ! -e "$RELEASE_MASTER" ]; do sleep 0.02; done; fi; mkdir -p "${control_path%/*}"; : > "$control_path"; printf "start\\n" >> "$MASTER_STARTS" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_EXEC_CONFIG_PATH: configPath,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    XDG_RUNTIME_DIR: runtimeDir,
    MASTER_STARTS: masterStarts,
    HELD_COMMAND_STARTED: heldCommandStarted,
    RELEASE_HELD_COMMAND: releaseHeldCommand,
    MASTER_CREATING: masterCreating,
    RELEASE_MASTER: releaseMaster,
    CONFIGURED_CONTROL_PATH: configuredControlPath,
  };

  const creating = spawn('/bin/sh', [launcher, '--', 'probe-command', 'first-startup'], {
    cwd: repoRoot, env: { ...env, DELAY_MASTER_START: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let creatingOutput = '', creatingError = '';
  creating.stdout.on('data', chunk => { creatingOutput += chunk; });
  creating.stderr.on('data', chunk => { creatingError += chunk; });
  const creatingCompletion = new Promise(resolve => creating.once('close', resolve));
  const startupCompletions = [];
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await readFile(masterCreating); break; }
      catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
    }
    await readFile(masterCreating);
    // Five simultaneous starts join the in-progress creator rather than
    // authenticating five dedicated command connections.
    const followers = Array.from({ length: 5 }, (_, index) => {
      const child = spawn('/bin/sh', [launcher, '--', 'probe-command', `startup-${index}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); });
      let out = '', err = '';
      child.stdout.on('data', value => { out += value; });
      child.stderr.on('data', value => { err += value; });
      const completion = new Promise(resolve => child.once('close', code => resolve({ code, out, err })));
      startupCompletions.push(completion);
      return { child, completion };
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const earlyResults = await Promise.all(followers.filter(({ child }) => child.exitCode != null).map(({ completion }) => completion));
    assert.deepEqual(earlyResults, [], `followers must await the single master: ${JSON.stringify(earlyResults)}`);
    await assert.rejects(readFile(masterStarts), { code: 'ENOENT' });
    await writeFile(releaseMaster, '', 'utf8');
    for (const { completion } of followers) {
      const result = await completion;
      assert.equal(result.code, 0, result.err);
      assert.match(result.out, /^remote:startup-/);
    }
  } finally {
    await writeFile(releaseMaster, '', 'utf8');
    // Retire the gated processes before fixture teardown removes their release
    // file. Otherwise a failed assertion can strand the fake SSH creator.
    await Promise.all([creatingCompletion, ...startupCompletions]);
  }
  const creatingExit = creating.exitCode;
  assert.equal(creatingExit, 0, creatingError);
  assert.equal(creatingOutput, 'remote:first-startup\n');
  assert.ok((await readFile(provenancePath, 'utf8')).split('\n')[0] === historicalProvenance, 'existing provenance remains in the active log');

  for (const value of ['one', 'two']) {
    const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', value], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `remote:${value}\n`);
  }

  assert.equal((await readFile(masterStarts, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await readFile(configuredControlPath, 'utf8'), '', 'native and configured clients must use the same socket');

  const held = spawn('/bin/sh', [launcher, '--', 'probe-command', 'hold'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const heldOutput = { stdout: '', stderr: '' };
  held.stdout.on('data', (chunk) => { heldOutput.stdout += chunk; });
  held.stderr.on('data', (chunk) => { heldOutput.stderr += chunk; });
  let heldExit;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await readFile(heldCommandStarted);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(heldCommandStarted);
    const concurrent = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'concurrent'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(concurrent.status, 0, concurrent.stderr);
    assert.equal(concurrent.stdout, 'remote:concurrent\n');
    assert.equal((await readFile(masterStarts, 'utf8')).trim().split('\n').length, 1);
  } finally {
    await writeFile(releaseHeldCommand, '', 'utf8');
    heldExit = held.exitCode ?? await new Promise((resolveExit) => held.once('exit', resolveExit));
  }
  assert.equal(heldExit, 0, heldOutput.stderr);
  assert.equal(heldOutput.stdout, 'remote:hold\n');
});

test('native launcher uses its private temporary SSH control root when XDG_RUNTIME_DIR is read-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-readonly-runtime-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const runtimeDir = join(root, 'runtime');
  const masterPath = join(root, 'master-path');
  t.after(async () => {
    await chmod(runtimeDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "remote:%s\\n" "$1"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path"; printf "%s\\n" "$control_path" > "$MASTER_PATH" ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));
  await chmod(runtimeDir, 0o555);

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
      MASTER_PATH: masterPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote:ok\n');
  assert.match(await readFile(masterPath, 'utf8'), new RegExp(`^${root}/happier-ssh-${process.getuid()}/`));
});

test('native launcher admits another remote heavyweight command while the worker has healthy pressure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-pretransport-admission-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const configPath = join(stackDir, 'dev-targets.json');
  const masterStarted = join(root, 'master-started');
  const runtimeDir = join(root, 'runtime');
  const owners = [
    spawn('/bin/sleep', ['300'], { stdio: 'ignore' }),
    spawn('/bin/sleep', ['300'], { stdio: 'ignore' }),
  ];
  t.after(async () => {
    for (const owner of owners) {
      if (owner.exitCode == null) owner.kill('SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "validation_direct_commands='tsc vitest'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  const now = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${now} 1 0.062500 8\n`, 'utf8');
  await writeFile(
    join(cacheDir, 'linux.telemetry'),
    '8 0.5 0.8 22000000 20 0 18000000 26000000 0 0 0 0 0 0 0 linux\n',
    'utf8',
  );
  for (const owner of owners) {
    await writeFile(join(cacheDir, `linux.active.${owner.pid}`), `${owner.pid}\nvalidation\nexisting\n`, 'utf8');
  }
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    '# Reservation fixtures model locks held by another dispatcher.',
    '[ "${1-}" = -n ] && [ "${3-}" = -c ] && exit 1',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'if [ "${REMOTE_MARKER-}" = 1 ]; then printf "remote\\n"; else printf "local\\n"; fi',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path"; : > "$MASTER_STARTED" ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; REMOTE_MARKER=1 /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_EXEC_CONFIG_PATH: configPath,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    XDG_RUNTIME_DIR: runtimeDir,
    MASTER_STARTED: masterStarted,
  };
  const child = spawn('/bin/sh', [launcher, '--', 'vitest', '--version'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  try {
    const exitCode = child.exitCode ?? await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, 0, output.stderr);
    assert.equal(output.stdout, 'remote\n');
    await readFile(masterStarted);
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
});

test('native launcher ignores an inherited local preference and dispatches to the least-loaded host without Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'), { recursive: true });
  await utimes(
    join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'),
    new Date(0),
    new Date(0),
  );
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Scanning|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 1 0.5\\n" ;; *) printf "8 4 0.5\\n" ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_PREFERRED_EXECUTION: 'local',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac2/);
  assert.doesNotMatch(result.stderr, /cannot open .*provenance\.jsonl/);
  assert.match(result.stdout, /remote:.*mac2-host.*probe-command.*ok/);
});

test('native launcher automatic placement remains compatible with GNU awk local scoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-gawk-score-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const reservedLoadMarker = join(root, 'reserved-load-variable');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    `for argument in "$@"; do case "$argument" in load=*) printf called > ${JSON.stringify(reservedLoadMarker)} ;; esac; done`,
    'exec /usr/bin/awk "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10 1 16000000 24000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
  await assert.rejects(readFile(reservedLoadMarker), { code: 'ENOENT' });
});

test('native launcher governs nested Vitest workers when automatic placement selects a pressured local Linux candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-governor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const repoRoot = resolve(launcher, '../../../..');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  // Admission's real OS observer needs Node; reject only the retired JS
  // dispatch path rather than disabling observation and waiting forever.
  await executable(join(binDir, 'node'), `#!/bin/sh\ncase "$1" in */service_memory.mjs|*/worker_disk_budget.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;; *) exit 97 ;; esac\n`);
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "14\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/meminfo*) printf "16000000 24000000\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac', '',
  ].join('\n'));
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 120 0.5 22000000 10 120 16000000 24000000 0 0 90 90 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "wrong-remote\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s\\n" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'corepack'), [
    '#!/bin/sh',
    'printf "workers:%s:%s:%s:%s\\n" "${VITEST_MAX_THREADS-}" "${VITEST_MIN_THREADS-}" "${VITEST_MAX_FORKS-}" "${VITEST_MIN_FORKS-}"',
    'printf "args:%s\\n" "$*"',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workers:1:1:1:1/);
  assert.match(result.stdout, /args:run fixture\.test\.ts --maxWorkers=1 --minWorkers=1/);
  assert.doesNotMatch(result.stdout, /wrong-remote/);

  const explicit = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /workers::::/);
  assert.match(explicit.stdout, /args:run --maxWorkers=6/);

  const packageScript = spawnSync(
    '/bin/sh',
    [launcher, '--', 'corepack', 'yarn', '-s', 'test:migration:bundled-plugin-projections'],
    {
      cwd: repoRoot,
      env: {
        ...executionNeutralEnv,
        HOME: root,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: root,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(packageScript.status, 0, packageScript.stderr);
  assert.match(packageScript.stdout, /workers:1:1:1:1/);
  assert.match(packageScript.stdout, /^args:yarn -s test:migration:bundled-plugin-projections$/m);
});

test('native launcher exact target preserves remote-only cwd, environment, and TTY on only the named healthy target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const remoteRepo = resolve(native.launcher, '../../../..');
  const remoteHome = join(root, 'remote-home');
  const sshLog = join(root, 'ssh.log');
  const environmentValue = "a 'quoted' $value $(exit 99)\n\n";
  await mkdir(binDir, { recursive: true });
  await mkdir(join(remoteRepo, 'apps/cli/dist'), { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${remoteRepo}'`,
    `target_1_cli_home='${remoteHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "value<%s>empty<%s>arg<%s>\\n" "$PROBE_VALUE" "$PROBE_EMPTY" "$1"\nprintf "remote-error\\n" >&2\nexit 23\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\n[ "$3" = "happier-mac--host" ] || exit 0\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'printf "called\\n" >> "$PROBE_SSH_LOG"',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 6 0.5 22000000 10\\n" ;; *) printf "8 0.1 0.9 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *probe-command*) printf "remote:mac:%s\\n" "$*"; for argument in "$@"; do remote_command=$argument; done; exec /bin/bash -c "$remote_command" ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--tty', '--cwd=apps/cli/dist', `--env=PROBE_VALUE=${environmentValue}`, '--env=PROBE_EMPTY=', '--', 'probe-command', "ok'\n"], {
    cwd: join(repoRoot, 'apps', 'stack'),
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      PROBE_SSH_LOG: sshLog,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stderr, /remote-error/);
  assert.match(result.stdout, /remote:mac:/);
  assert.match(result.stdout, /-tt -S/);
  assert.ok(result.stdout.includes(`${remoteRepo}/apps/cli/dist`));
  assert.match(result.stdout, /export PROBE_VALUE=/);
  assert.ok(result.stdout.includes(`value<${environmentValue}>empty<>arg<ok'\n>`), result.stdout);
  assert.doesNotMatch(result.stdout, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout, /wrong-target:linux/);
  const transportBeforeInvalidOptions = await readFile(sshLog, 'utf8');
  for (const option of ['--env=BAD-KEY=value', '--cwd=apps/../../outside']) {
    const rejected = spawnSync('/bin/sh', [launcher, '--target=mac-host', option, '--', 'probe-command'], {
      cwd: repoRoot,
      env: {
        ...executionNeutralEnv,
        HOME: root,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        TMPDIR: root,
        PROBE_SSH_LOG: sshLog,
      },
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1, rejected.stderr);
  }
  assert.equal(await readFile(sshLog, 'utf8'), transportBeforeInvalidOptions);
});

test('native launcher exact target fails closed when its command connection is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-connection-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/mac-repo'",
    "target_1_cli_home='/remote/mac-home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 0.1 0.9 22000000 10\\n" ;; *) printf "8 0.2 0.8 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*mac-host*) exit 72 ;;',
    '  *-MNf*linux-host*|*-O\\ exit*) exit 0 ;;',
    '  *mac-host*) exit 255 ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await writeFile(cacheDir, 'occupied\n');
  const cacheFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(cacheFailure.status, 1, cacheFailure.stderr);
  assert.doesNotMatch(cacheFailure.stdout, /wrong-target:linux|wrong-local/);
  await rm(cacheDir);

  const temporaryFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    ...invocation,
    env: { ...invocation.env, TMPDIR: join(root, 'missing') },
  });
  assert.equal(temporaryFailure.status, 1, temporaryFailure.stderr);
  assert.doesNotMatch(temporaryFailure.stdout, /wrong-target:linux|wrong-local/);

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mac-host.*command connection/i);
  assert.doesNotMatch(result.stdout, /wrong-target:linux|wrong-local/);
});

test('native launcher preserves a successful remote command when the login shell exit hook fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-exit-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = await installNativeAdmissionFixture({ root });
  const workerRepo = resolve(native.launcher, '../../../..');
  const exitHook = join(root, 'bash-exit-hook');
  await writeFile(exitHook, 'trap false EXIT\n');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const remoteRepo = resolve(native.launcher, '../../../..');
  const remoteHome = join(root, 'remote-home');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native'), { recursive: true });
  await mkdir(remoteRepo, { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${remoteRepo}'`,
    `target_1_executor_repo_dir='${workerRepo}'`,
    `target_1_cli_home='${remoteHome}'`,
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *"&& [ -x "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    BASH_ENV="$EXIT_HOOK" /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      EXIT_HOOK: exitHook,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  const javascriptCommand = buildRemoteExecCommand({ platform: 'posix', repoDir: remoteRepo, cliHomeDir: remoteHome }, {
    executionId: 'hook-fixture-javascript', commandArgs: ['/usr/bin/true'],
  });
  const javascript = spawnSync('/bin/bash', ['-c', `trap 'exit 41' EXIT; ${javascriptCommand}`], {
    encoding: 'utf8', env: executionNeutralEnv,
  });
  assert.equal(javascript.status, 0, javascript.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('native launcher exact target bypasses local automatic placement from a freshly generated projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-local-policy-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher refreshes a projection produced by older generator bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-generator-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  const oldTimestamp = new Date(0);
  await utimes(configPath, oldTimestamp, oldTimestamp);
  await utimes(projectionPath, oldTimestamp, oldTimestamp);
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher exact target re-probes a previously unavailable command immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-recovery-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const healthyMarker = join(root, 'healthy');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    `if [ ! -f ${JSON.stringify(healthyMarker)} ]; then exit 1; fi`,
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));
  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const unavailable = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.notEqual(unavailable.status, 0);
  await writeFile(healthyMarker, 'ready\n', 'utf8');

  const recovered = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /remote:mac:/);
  assert.doesNotMatch(recovered.stdout, /wrong-local/);
});

test('native launcher exact target fails closed when no target configuration exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-unconfigured-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no target configuration/i);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher excludes a target with no free repository filesystem space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-full-disk-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 0.5 0.8 0 99\\n" ;; *) printf "8 4 0.5 22000000 98\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*) printf "wrong-target:mac2\\n" ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-target:mac2/);
});

test('native launcher keeps remote execution available when sandboxing makes stack command state read-only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-readonly-state-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const runtimeDir = join(root, 'runtime');
  t.after(async () => {
    await chmod(stackDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${join(root, 'machine-home')}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "execution:%s\\n" "${HAPPIER_DEV_TARGET_EXECUTION-local}"\n',
  );
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -S "$control_path" ] || [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  await chmod(stackDir, 0o555);

  const runSandboxedSession = (sessionId) => spawnSync('/bin/sh', [launcher, '--', 'probe-command', sessionId], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      CODEX_SESSION_ID: sessionId,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
  });

  const result = runSandboxedSession('first-session');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /execution:1/);
  assert.doesNotMatch(result.stdout, /execution:local/);

  const secondResult = runSandboxedSession('second-session');
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.match(secondResult.stderr, /selected mac /);

  const fallbackCacheRoot = join(root, `happier-preferred-execution-${process.getuid()}`);
  assert.equal(
    (await readdir(fallbackCacheRoot)).length,
    1,
    'sandboxed sessions for one Stack must share load samples and active dispatch reservations',
  );
});

test('native launcher admits APFS targets that round capacity to 100 percent with useful free space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-apfs-free-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 100\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher re-probes a cached unavailable target as soon as its sync becomes ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-recovered-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(cacheDir, 'mac.cache'), `${Math.floor(Date.now() / 1_000)} 0 - 1\n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|8|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 50\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher retries another target when the selected host is unreachable before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-predispatch-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*mac-host*) exit 255 ;;',
    '  *-MNf*mac2-host*) exit 0 ;;',
    '  *mac2-host*) printf "remote:mac2:%s\\n" "$*" ;;',
    '  *mac-host*) exit 255 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:mac2:.*probe-command.*ok/);
});

test('native launcher retries another target when a live control master refuses the authoritative session channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-mux-session-refused-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const warmedMarker = join(root, 'mac-master-warmed');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'debug_log=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  if [ "$previous" = -E ]; then debug_log=$argument; fi',
    '  previous=$argument',
    '  last_argument=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *mac-host*)',
    '    if [ "$last_argument" = : ]; then',
    '      if [ -e "$WARMED_MARKER" ]; then',
    '        printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
    '        exit 255',
    '      fi',
    '      exit 0',
    '    fi',
    '    if [ -e "$WARMED_MARKER" ]; then',
    '      [ -z "$debug_log" ] || printf "mux_client_request_session: session request failed: Session open refused by peer\\n" > "$debug_log"',
      '      printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
    '      exit 255',
    '    fi',
    '    : > "$WARMED_MARKER"',
    '    printf "remote:mac:warm\\n"',
    '    ;;',
    '  *mac2-host*) printf "remote:mac2:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      WARMED_MARKER: warmedMarker,
    },
    encoding: 'utf8',
  };

  const warm = spawnSync('/bin/sh', [launcher, '--target=mac', '--', 'probe-command', 'warm'], invocation);
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /remote:mac:warm/);

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], invocation);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:mac2:.*probe-command.*ok/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher retries the same target without multiplexing when the authoritative mux session is refused before remote execution starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-authoritative-mux-refused-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=',
    'previous=',
    'last_argument=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -E ]; then debug_log=$argument; fi',
    '  previous=$argument',
    '  last_argument=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *mac-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    case "$*" in *ControlPath=none*) printf "remote:mac:dedicated:%s\\n" "$*"; exit 0 ;; esac',
    '    [ -z "$debug_log" ] || printf "mux_client_request_session: session request failed: Session open refused by peer\\n" > "$debug_log"',
    '    printf "mux_client_request_session: session request failed: Session open refused by peer\\n" >&2',
    '    exit 255',
    '    ;;',
    '  *mac2-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    [ -z "$debug_log" ] || printf "debug2: mux_client_request_session: master session id: 7\\n" > "$debug_log"',
    '    printf "remote:mac2:%s\\n" "$*"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const exact = spawnSync('/bin/sh', [launcher, '--target=mac', '--', 'probe-command', 'exact'], invocation);
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stderr, /mac.*dedicated SSH connection/i);
  assert.match(exact.stdout, /remote:mac:dedicated:.*ControlPath=none.*probe-command.*exact/);
  assert.doesNotMatch(exact.stdout, /remote:mac2|wrong-local/);

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], invocation);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stderr, /mac.*dedicated SSH connection/i);
  assert.match(result.stdout, /remote:mac:dedicated:.*ControlPath=none.*probe-command.*ok/);
  assert.doesNotMatch(result.stderr, /selected mac2 /);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher never replays an authoritative remote command that starts and exits 255', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-authoritative-255-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'debug_log=',
    'previous=',
    'last_argument=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -E ]; then debug_log=$argument; fi',
    '  previous=$argument',
    '  last_argument=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*|*-O\\ check*|*-MNf*) exit 0 ;;',
    '  *mac-host*)',
    '    [ "$last_argument" = : ] && exit 0',
    '    [ -z "$debug_log" ] || printf "client_loop: send disconnect: Broken pipe\\n" > "$debug_log"',
    '    printf "authoritative-command-started\\n"',
    '    exit 255',
    '    ;;',
    '  *mac2-host*) printf "wrong-target:mac2\\n"; exit 0 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 255, result.stderr);
  assert.match(result.stdout, /authoritative-command-started/);
  assert.match(result.stderr, /client_loop: send disconnect: Broken pipe/);
  assert.doesNotMatch(result.stdout, /wrong-target:mac2|wrong-local/);
  assert.doesNotMatch(result.stderr, /selected mac2 /);
});

test('native launcher accounts for an in-flight dispatch from another sandboxed session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-in-flight-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const holdMarker = join(root, 'first-started');
  const releaseMarker = join(root, 'release-first');
  const collisionMarker = join(root, 'second-selected-busy-target');
  t.after(async () => {
    await chmod(stackDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "2 0.25 0.5\\n" ;; *) printf "8 2.4 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*)',
    '    if [ -e "$HOLD_MARKER" ]; then : > "$COLLISION_MARKER"; printf "remote:mac2-second\\n"; exit 0; fi',
    '    : > "$HOLD_MARKER"',
    '    while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '    printf "remote:mac2-first\\n"',
    '    ;;',
    '  *mac-host*) printf "remote:mac-second\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    HOLD_MARKER: holdMarker,
    RELEASE_MARKER: releaseMarker,
    COLLISION_MARKER: collisionMarker,
  };
  await chmod(stackDir, 0o555);

  const first = spawn('/bin/sh', [launcher, '--', 'probe-command', 'first'], {
    cwd: repoRoot,
    env: { ...env, CODEX_SESSION_ID: 'first-sandboxed-session' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstOutput = { stdout: '', stderr: '' };
  first.stdout.on('data', (chunk) => { firstOutput.stdout += chunk; });
  first.stderr.on('data', (chunk) => { firstOutput.stderr += chunk; });
  let second;
  let dispatchError;
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await readFile(holdMarker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(holdMarker);
    second = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'second'], {
      cwd: repoRoot,
      env: { ...env, CODEX_SESSION_ID: 'second-sandboxed-session' },
      encoding: 'utf8',
    });
  } catch (error) {
    dispatchError = error;
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
  }
  const firstStatus = await new Promise((resolveExit) => first.once('exit', resolveExit));

  if (dispatchError) throw dispatchError;

  assert.equal(firstStatus, 0, firstOutput.stderr);
  assert.match(firstOutput.stderr, /selected mac2/);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /selected mac /);
  assert.match(second.stdout, /remote:mac-second/);
  await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
});

test('anonymous controller probe and dispatch locks cannot hold reachable work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dispatch-backoff-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const dispatchLock = join(cacheDir, 'dispatch.lock');
  const sleepAttempts = join(root, 'dispatch-sleep-attempts');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(dispatchLock, { recursive: true });
  await mkdir(join(cacheDir, 'remote.cache.lock'));
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'sleep'), [
    '#!/bin/sh',
    'printf "%s\\n" "$1" >> "$DISPATCH_SLEEP_ATTEMPTS"',
    'exec /bin/sleep "${DISPATCH_SLEEP_ACTUAL_SECONDS-$1}"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'stat'), [
    '#!/bin/sh',
    'case "$1" in',
    '  -c) printf "1\\n" ;;',
    '  -f) printf "/\\n" ;;',
    '  *) exec /usr/bin/stat "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote-host*) printf "remote:dispatch\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    DBUS_SESSION_BUS_ADDRESS: '',
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    DISPATCH_SLEEP_ATTEMPTS: sleepAttempts,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 1_000,
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}`);
  assert.match(result.stdout, /remote:dispatch/);
  assert.deepEqual(await readdir(dispatchLock), [], 'obsolete state is neither admission authority nor reclaimed by age');
});

test('native launcher cache writes and reservations survive reused sandbox process ids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-pid-namespace-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const staleReservation = join(cacheDir, 'remote.active.reused-namespace-pid');
  const wrapper = join(root, 'launch-with-reused-pid');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'remote.cache'), `${cachedAt} 1 0.125000 8\n`);
  await writeFile(join(cacheDir, `remote.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-remote-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *-MNf*|*-O\\ check*|*-O\\ exit*) exit 0 ;;',
    '  *) printf "remote:reused-pid\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(wrapper, [
    '#!/bin/sh',
    `printf '%s\\nvalidation\\nstale-execution\\n' "$$" > '${staleReservation}'`,
    `mkdir '${cacheDir}/remote.active.'"$$"'.'"$$"'.tmp'`,
    `exec /bin/sh '${launcher}' -- probe-command status`,
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [wrapper], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:reused-pid/);
  assert.doesNotMatch(result.stderr, /reservation failed|cannot create|cannot stat/i);
  const hasFlock = spawnSync('/bin/sh', ['-c', 'command -v flock'], {
    env: { PATH: `${binDir}:/usr/bin:/bin` },
    stdio: 'ignore',
  }).status === 0;
  if (hasFlock) {
    await assert.rejects(readFile(staleReservation), { code: 'ENOENT' });
  } else {
    t.diagnostic('flock unavailable; PID-namespace stale-reservation reclamation is Linux-only');
  }
});

for (const platform of ['linux', 'darwin']) {
test(`native launcher keeps ${platform} control commands preferred and adapts recognized worker tools to pressure`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-resource-governor-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    '# Reservation fixtures model locks held by another dispatcher.',
    '[ "${1-}" = -n ] && [ "${3-}" = -c ] && exit 1',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) if [ "$GOVERNOR_PLATFORM" = darwin ]; then printf "14 1 0.8 22000000 20 0 57600000 72000000 0 0 0 0 0 0 0 darwin\\n"; else case "${GOVERNOR_PRESSURE-}" in quiet) printf "14 1 0.8 22000000 20 2 48000000 72000000 0 0 0 0 0 0 0 linux\\n" ;; *) printf "14 360 0.8 22000000 20 420 48000000 72000000 0 0 90 0 0 0 0 linux\\n" ;; esac; fi ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; eval "set -- $remote_command"; /bin/bash -n -c "$3" || exit $?; printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    GOVERNOR_PLATFORM: platform,
  };

  // Darwin has no Linux PSI/run-queue sample. Existing live dispatch
  // reservations still share its CPU capacity between nested workers. Linux
  // must use observed pressure instead of treating waiting reservations as CPU.
  const reservations = [];
  const processToken = spawnSync('/bin/sh', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity',
    join(import.meta.dirname, 'utils/proc/native_process_identity.sh'), String(process.pid)], {
    encoding: 'utf8', env: executionNeutralEnv,
  }).stdout.trim();
  assert.notEqual(processToken, '-');
  if (platform === 'darwin' || platform === 'linux') {
    const cacheDir = join(stackDir, 'dev-target-command-load-native');
    await mkdir(cacheDir, { recursive: true });
    const reservationCount = platform === 'darwin' ? 13 : 7;
    for (let index = 0; index < reservationCount; index += 1) {
      const path = join(cacheDir, `linux.active.fixture-${index}`);
      await writeFile(path, `${process.pid}\nvalidation\nfixture-${index}\n${processToken}\n\n`);
      reservations.push(path);
    }
  }

  const control = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const vitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const search = spawnSync('/bin/sh', [launcher, '--', 'rg', 'needle', 'sources'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const typecheck = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedVitest = spawnSync('/bin/sh', [launcher, '--script=test:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedNonVitestTest = spawnSync('/bin/sh', [launcher, '--script=test:migration:bundled-plugin-projections'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const directNonVitestTest = spawnSync('/bin/sh', [launcher, '--', 'yarn', '-s', 'test:migration:bundled-plugin-projections'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedTypecheck = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestPoolWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--poolOptions.forks.maxForks=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestEnvironment = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, VITEST_MAX_THREADS: '7' },
    encoding: 'utf8',
  });
  const explicitRemoteVitestEnvironment = spawnSync('/bin/sh', [launcher, '--target=linux', '--env=VITEST_MAX_FORKS=3', '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, VITEST_MAX_FORKS: '7' },
    encoding: 'utf8',
  });
  const explicitTypeScriptEnvironment = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env: { ...env, GOMAXPROCS: '7' },
    encoding: 'utf8',
  });
  if (platform === 'darwin') {
    for (const path of reservations) await rm(path);
  }
  const quietVitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: { ...env, GOVERNOR_PRESSURE: 'quiet' },
    encoding: 'utf8',
  });
  if (platform === 'linux') {
    for (const path of reservations) await rm(path);
  }

  for (const [name, result] of Object.entries({
    control,
    vitest,
    search,
    typecheck,
    scriptedVitest,
    scriptedNonVitestTest,
    directNonVitestTest,
    scriptedTypecheck,
    quietVitest,
    explicitVitestWorkers,
    explicitVitestPoolWorkers,
    explicitVitestEnvironment,
    explicitRemoteVitestEnvironment,
    explicitTypeScriptEnvironment,
  })) {
    assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  }
  assert.doesNotMatch(control.stdout, /nice -n 10|--maxWorkers|--threads|--singleThreaded/);
  assert.match(vitest.stdout, /VITEST_MAX_THREADS=1.*VITEST_MIN_THREADS=1.*nice -n 10.*vitest/s);
  assert.match(vitest.stdout, /VITEST_MAX_FORKS=1.*VITEST_MIN_FORKS=1/s);
  assert.match(vitest.stdout, /vitest.*--maxWorkers=1.*--minWorkers=1/s);
  assert.doesNotMatch(vitest.stdout, /fi;;/);
  assert.match(search.stdout, /nice -n 10.*rg.*--threads=1/s);
  assert.match(typecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*runTypeScriptCli\.mjs/s);
  assert.doesNotMatch(typecheck.stdout, /--singleThreaded/);
  assert.match(scriptedVitest.stdout, /VITEST_MAX_THREADS=1.*nice -n 10.*corepack.*yarn.*test:local/s);
  assert.doesNotMatch(scriptedVitest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(
    scriptedNonVitestTest.stdout,
    /VITEST_MAX_THREADS=1.*nice -n 10.*corepack.*yarn.*test:migration:bundled-plugin-projections/s,
  );
  assert.doesNotMatch(scriptedNonVitestTest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(
    directNonVitestTest.stdout,
    /nice -n 10.*yarn.*-s.*test:migration:bundled-plugin-projections/s,
  );
  assert.doesNotMatch(directNonVitestTest.stdout, /--maxWorkers|--minWorkers/);
  assert.match(scriptedTypecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*corepack.*yarn.*typecheck:local/s);
  assert.match(quietVitest.stdout, /nice -n 10.*vitest/s);
  assert.doesNotMatch(quietVitest.stdout, /VITEST_MAX_THREADS=|--maxWorkers/);
  assert.match(explicitVitestWorkers.stdout, /vitest.*--maxWorkers=6/s);
  assert.doesNotMatch(explicitVitestWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestPoolWorkers.stdout, /vitest.*--poolOptions\.forks\.maxForks=6/s);
  assert.doesNotMatch(explicitVitestPoolWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=.*7/s);
  assert.doesNotMatch(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitRemoteVitestEnvironment.stdout, /VITEST_MAX_FORKS=.*7.*VITEST_MAX_FORKS=.*3/s);
  assert.doesNotMatch(explicitRemoteVitestEnvironment.stdout, /--maxWorkers=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=.*7/s);
  assert.doesNotMatch(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=1/);
  if (platform === 'darwin') {
    for (const result of [vitest, scriptedVitest, typecheck, search]) {
      assert.doesNotMatch(result.stdout, /--heavyweight-admission|systemd-run|\/proc\//);
    }
  }
});
}

test('native launcher excludes a low-load target that cannot launch the requested command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-command-capability-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 1 0.5\\n" ;; *) printf "8 4 0.5\\n" ;; esac ;;',
    '  *command\\ -v*probe-command*) case "$*" in *mac2-host*) exit 1 ;; *) exit 0 ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:.*mac-host.*probe-command.*ok/);
  assert.doesNotMatch(result.stdout, /mac2-host/);
});

test('native launcher bootstraps dependency-consuming commands and leaves source-only commands bootstrap-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dependency-admission-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "source_test_components='apps/cli'",
    "source_test_configs='vitest.config.ts'",
    "source_test_scripts='vitest vitest:local'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac2'",
    "target_1_ssh='mac2-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 20 2 48000000 72000000 1000 8000000 0.1 0.2 0.3 4 5 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*run-vitest-with-heartbeat.mjs*) printf "vitest-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*corepack*yarn*--cwd*apps/ui*vitest*) printf "cwd-vitest-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*typecheck:local*) printf "typed-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*generateBundledPluginEntries.ts*--mode*check*) printf "plugin-generator-check-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*test:migration:bundled-plugin-projections*) printf "plugin-projection-script-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*test:migration:governance*) printf "migration-governance-after-preparation:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*typecheck:local*) printf "typed-after-bootstrap:%s\\n" "$*" ;;',
    '  *typecheck:local*) printf "typed-without-bootstrap\\n"; exit 42 ;;',
    '  *remote_dependency_bootstrap.mjs*custom:script*) printf "custom-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*test:integration:local*) printf "integration-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*vitest*) printf "vitest-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*tsc*) printf "tsc-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*runTypeScriptCli.mjs*) printf "typescript-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*--test*) printf "stack-test-after-bootstrap:%s\\n" "$*" ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "unexpected-bootstrap\\n"; exit 43 ;;',
    '  *source-only*|*find*) printf "source-only:%s\\n" "$*" ;;',
    '  *rg*) printf "raw-search:%s\\n" "$*" ;;',
    '  *) printf "unexpected:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };

  const sourceOnlyCommands = [
    ['node', '-e', 'console.log("source-only")'],
    ['nodejs', 'source-only.mjs'],
    ['find', '.', '-name', '*.mjs'],
  ];
  for (const commandArgs of sourceOnlyCommands) {
    const result = spawnSync('/bin/sh', [launcher, '--', ...commandArgs], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${commandArgs.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /source-only:/);
    assert.doesNotMatch(result.stdout, /remote_dependency_bootstrap\.mjs/);
  }
  const dependencyCommands = [
    ['yarn', '-s', 'custom:script'],
    ['vitest', 'run', 'owner.test.ts'],
    ['tsc', '--noEmit'],
    ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    ['node', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
    ['nodejs', 'node_modules/vitest/vitest.mjs', 'run', 'owner.test.ts'],
    ['node', '--test', 'source-only.test.mjs'],
    ['node', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
    ['nodejs', '--test', 'apps/stack/scripts/utils/auth/auth.test.mjs'],
  ];
  for (const commandArgs of dependencyCommands) {
    const result = spawnSync('/bin/sh', [launcher, '--', ...commandArgs], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${commandArgs.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /after-bootstrap:/);
    assert.match(result.stdout, /remote_dependency_bootstrap\.mjs/);
  }

  const sourceTest = spawnSync('/bin/sh', [launcher, '--', 'corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'vitest', 'run', 'arbitrary.test.ts'], {
    cwd: repoRoot, env, encoding: 'utf8',
  });
  assert.equal(sourceTest.status, 0, `${sourceTest.stderr}\n${sourceTest.stdout}`);
  assert.match(sourceTest.stdout, /--validation-kind=source-test/);

  const integrationTest = spawnSync('/bin/sh', [launcher, '--script=test:integration:local'], {
    cwd: join(repoRoot, 'apps/cli'), env, encoding: 'utf8',
  });
  assert.equal(integrationTest.status, 0, `${integrationTest.stderr}\n${integrationTest.stdout}`);
  assert.match(integrationTest.stdout, /remote_validation_preparation\.mjs/);
  assert.match(integrationTest.stdout, /--validation-kind=runtime/);

  const typed = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(typed.status, 0, `${typed.stderr}\n${typed.stdout}`);
  assert.match(typed.stdout, /typed-after-bootstrap/);
  assert.match(typed.stdout, /remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /node .*remote_dependency_bootstrap\.mjs/);
  assert.doesNotMatch(typed.stdout, /corepack .*yarn .*node .*remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /HAPPIER_STACK_PM_CACHE_BASE_DIR.*remote\/home\/cache/);

  const componentTyped = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env,
    encoding: 'utf8',
  });
  assert.equal(componentTyped.status, 0, componentTyped.stderr);
  assert.match(componentTyped.stdout, /typed-after-preparation/);
  assert.match(componentTyped.stdout, /remote_validation_preparation\.mjs/);
  assert.match(componentTyped.stdout, /--validation-kind=typecheck/);

  for (const runtime of ['node', 'nodejs']) {
    const relativeCompiler = spawnSync('/bin/sh', [launcher, '--', runtime, '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
      cwd: join(repoRoot, 'apps', 'cli'), env, encoding: 'utf8',
    });
    assert.equal(relativeCompiler.status, 0, `${relativeCompiler.stderr}\n${relativeCompiler.stdout}`);
    assert.match(relativeCompiler.stdout, /typescript-after-bootstrap:/);
    assert.match(relativeCompiler.stdout, /remote_validation_preparation\.mjs/);
    assert.match(relativeCompiler.stdout, /--validation-kind=typecheck/);
    assert.match(relativeCompiler.stdout, /GOMAXPROCS/);
  }

  const composedVitest = spawnSync('/bin/sh', [
    launcher,
    '--',
    'yarn',
    '--cwd',
    'packages/tests',
    'node',
    'scripts/run-vitest-with-heartbeat.mjs',
    '--config',
    'vitest.core.slow.config.ts',
    'suites/example.slow.e2e.test.ts',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(composedVitest.status, 0, composedVitest.stderr);
  assert.match(composedVitest.stdout, /vitest-after-preparation/);
  assert.match(composedVitest.stdout, /remote_validation_preparation\.mjs/);
  assert.match(composedVitest.stdout, /--component-relative-dir=packages\/tests/);
  assert.match(composedVitest.stdout, /run-vitest-with-heartbeat\.mjs.*--maxWorkers=[1-9][0-9]*.*--minWorkers=1/s);

  const cwdVitest = spawnSync('/bin/sh', [
    launcher,
    '--',
    'corepack',
    'yarn',
    '--cwd',
    'apps/ui',
    'vitest',
    'run',
    'sources/example.test.ts',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(cwdVitest.status, 0, cwdVitest.stderr);
  assert.match(cwdVitest.stdout, /cwd-vitest-after-preparation/);
  assert.match(cwdVitest.stdout, /--component-relative-dir=apps\/ui/);

  const directPluginCheck = spawnSync('/bin/sh', [
    launcher,
    '--',
    'node',
    '--experimental-strip-types',
    'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
    '--mode',
    'check',
    '--scope',
    'projections',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(directPluginCheck.status, 0, directPluginCheck.stderr);
  assert.match(directPluginCheck.stdout, /plugin-generator-check-after-preparation/);
  assert.match(directPluginCheck.stdout, /--component-relative-dir=apps\/cli/);

  const pluginProjectionScript = spawnSync('/bin/sh', [
    launcher,
    '--script=test:migration:bundled-plugin-projections',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(pluginProjectionScript.status, 0, pluginProjectionScript.stderr);
  assert.match(pluginProjectionScript.stdout, /plugin-projection-script-after-preparation/);
  assert.match(pluginProjectionScript.stdout, /--component-relative-dir=apps\/cli/);

  const migrationGovernance = spawnSync('/bin/sh', [
    launcher,
    '--script=test:migration:governance',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(migrationGovernance.status, 0, migrationGovernance.stderr);
  assert.match(migrationGovernance.stdout, /migration-governance-after-preparation/);
  assert.match(migrationGovernance.stdout, /--component-relative-dir=apps\/cli/);

  const raw = spawnSync('/bin/sh', [launcher, '--', 'rg', '-n', 'needle'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /raw-search/);
  assert.doesNotMatch(raw.stdout, /remote_dependency_bootstrap\.mjs/);

  const provenanceLines = (await readFile(
    join(stackDir, 'dev-target-command-load-native', 'provenance.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));
  const admittedClasses = provenanceLines
    .filter((entry) => entry.phase === 'admitted')
    .map((entry) => entry.commandClass);
  assert.deepEqual(admittedClasses, [
    ...sourceOnlyCommands.map((args) => args[0] === 'find' ? 'source-search' : 'unclassified'),
    ...dependencyCommands.map((args) => args.includes('custom:script') ? 'unclassified'
      : args.some(arg => arg.startsWith('apps/stack/')) ? 'targeted-validation' : 'full-validation'),
    'targeted-validation',
    'targeted-validation',
    'full-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'targeted-validation',
    'source-search',
  ]);
  assert.equal(provenanceLines.filter((entry) => entry.phase === 'completed').length, admittedClasses.length);
  assert.equal(provenanceLines.every((entry) => entry.schemaVersion === 1), true);
  assert.equal(provenanceLines.every((entry) => !('commandArgs' in entry)), true);
  assert.equal(provenanceLines.every((entry) => (
    entry.phase !== 'admitted' || entry.activeClassReservations === 0
  )), true);
  assert.deepEqual(
    {
      runQueue: provenanceLines[0].runQueue,
      memAvailableKiB: provenanceLines[0].memAvailableKiB,
      swapUsedKiB: provenanceLines[0].swapUsedKiB,
      memoryPsiAvg10: provenanceLines[0].memoryPsiAvg10,
      swapInPages: provenanceLines[0].swapInPages,
      platform: provenanceLines[0].platform,
    },
    {
      runQueue: 2,
      memAvailableKiB: 48_000_000,
      swapUsedKiB: 1_000,
      memoryPsiAvg10: 0.2,
      swapInPages: 4,
      platform: 'linux',
    },
  );
});

test('queue policy native launcher delegates dependency refresh waiting to the remote lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-busy-dependencies-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const dependencyBusyMarker = join(root, 'dependency-busy');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(dependencyBusyMarker, '1\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node'",
    "dependency_corepack_subcommands=''",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-node:%s\\n" "$*"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "local-tsc:%s\\n" "$*"\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'last_argument=; for argument in "$@"; do last_argument=$argument; done',
    '[ "$last_argument" = : ] && exit 0',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 20 0 36000000 72000000 0 0 0 0 0 0 0 linux\\n" ;;',
    `  *dependency-install.lock*) [ -f "${dependencyBusyMarker}" ] && exit 75; exit 0 ;;`,
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "remote-node:%s\\n" "$*" ;;',
    '  *) printf "unexpected-remote:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'tsc', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      DBUS_SESSION_BUS_ADDRESS: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.doesNotMatch(result.stderr, /running locally/i);
  assert.match(result.stdout, /remote-node:/);
  assert.doesNotMatch(result.stdout, /unexpected-remote/);

});

for (const [entry, signal] of [['native', 'SIGTERM'], ['native', 'SIGHUP'], ['native', 'SIGKILL'], ['JavaScript entry', 'SIGHUP'], ['JavaScript entry', 'SIGKILL']]) {
test(`${entry} launcher ${signal} cancellation terminates a remote descendant that ignores SIGTERM`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-cancel-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stacks', 'repo-test');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const startedMarker = join(root, 'remote-started');
  const childPidPath = join(root, 'remote-child.pid');
  const runtimeDir = join(root, 'runtime');
  let remoteChildPid = null;
  t.after(async () => {
    if (remoteChildPid) {
      try { process.kill(remoteChildPid, 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 1, targets: [{
    name: 'linux', platform: 'posix', ssh: 'linux-host', repoDir: repoRoot,
    cliHomeDir: machineHome, remotePath: [binDir, '/usr/bin', '/bin'],
  }] }), 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'remote-ignore-term'), [
    '#!/bin/sh',
    "trap '' TERM",
    'printf "%s\\n" "$$" > "$REMOTE_CHILD_PID_PATH"',
    ': > "$REMOTE_STARTED_MARKER"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.1 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const child = entry === 'native'
    ? spawn('/bin/sh', [launcher, '--', 'remote-ignore-term'], spawnOptions())
    : spawn(process.execPath, [join(repoRoot, 'apps/stack/scripts/dev_targets.mjs'), 'exec', 'auto', '--stack=repo-test', '--', 'remote-ignore-term'], spawnOptions());
  function spawnOptions() { return {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      HAPPIER_STACK_HOME_DIR: join(root, 'home'),
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      PATH: `${binDir}:${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      REMOTE_CHILD_PID_PATH: childPidPath,
      REMOTE_STARTED_MARKER: startedMarker,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }; }
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(startedMarker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(startedMarker).catch((error) => assert.fail(`remote fixture did not start: ${stderr}\n${error}`));
    remoteChildPid = Number((await readFile(childPidPath, 'utf8')).trim());
    assert.ok(Number.isInteger(remoteChildPid) && remoteChildPid > 0);

    child.kill(signal);
    const exitCode = child.exitCode ?? await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, signal === 'SIGKILL' ? null : signal === 'SIGHUP' ? 129 : 130, stderr);
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        process.kill(remoteChildPid, 0);
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(remoteChildPid)], { encoding: 'utf8' });
        if (state.status === 0 && state.stdout.trim().startsWith('Z')) {
          remoteChildPid = null;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      } catch (error) {
        if (error?.code === 'ESRCH') {
          remoteChildPid = null;
          break;
        }
        throw error;
      }
    }
    assert.equal(remoteChildPid, null, 'remote descendant survived launcher cancellation');
  } finally {
    if (child.exitCode == null) child.kill('SIGKILL');
  }
});
}

test('native launcher cancels only its remote execution after an authoritative SSH connection is lost', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-ssh-loss-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const startedMarker = join(root, 'remote-started');
  const childPidPath = join(root, 'remote-child.pid');
  const cancelArgsPath = join(root, 'cancel-ssh-args');
  const runtimeDir = join(root, 'runtime');
  const neighbor = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  let remoteChildPid = null;
  t.after(async () => {
    if (remoteChildPid) {
      try { process.kill(remoteChildPid, 'SIGKILL'); } catch {}
    }
    if (neighbor.exitCode == null) neighbor.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3" ;;',
    '  flush) exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'remote-ignore-term'), [
    '#!/bin/sh',
    "trap '' TERM",
    'printf "%s\\n" "$$" > "$REMOTE_CHILD_PID_PATH"',
    ': > "$REMOTE_STARTED_MARKER"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    '  remote_command=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "8 0.1 0.8 22000000 20 0 18000000 25000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *remote-ignore-term*)',
    '    exec 3<&0',
    '    /bin/sh -c "$remote_command" >/dev/null 2>&1 <&3 &',
    '    attempt=0',
    '    while [ ! -f "$REMOTE_STARTED_MARKER" ] && [ "$attempt" -lt 250 ]; do sleep 0.02; attempt=$((attempt + 1)); done',
    '    [ -f "$REMOTE_STARTED_MARKER" ] || exit 97',
    '    exit 255',
    '    ;;',
    '  *) printf "%s\\n" "$*" > "$REMOTE_CANCEL_ARGS_PATH"; /bin/sh -c "$remote_command" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'remote-ignore-term'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      REMOTE_CHILD_PID_PATH: childPidPath,
      REMOTE_STARTED_MARKER: startedMarker,
      REMOTE_CANCEL_ARGS_PATH: cancelArgsPath,
      TMPDIR: root,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 255, result.stderr);
  remoteChildPid = Number((await readFile(childPidPath, 'utf8')).trim());
  assert.ok(Number.isInteger(remoteChildPid) && remoteChildPid > 0);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(remoteChildPid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } catch (error) {
      if (error?.code === 'ESRCH') {
        remoteChildPid = null;
        break;
      }
      throw error;
    }
  }
  assert.equal(remoteChildPid, null, 'remote descendant survived the SSH failure');
  assert.doesNotThrow(() => process.kill(neighbor.pid, 0), 'an unrelated process was terminated');
  const cancelArgs = await readFile(cancelArgsPath, 'utf8');
  assert.match(cancelArgs, /ControlPath=none/);
  assert.match(cancelArgs, /ServerAliveInterval=15/);
  assert.match(cancelArgs, /ServerAliveCountMax=3/);
});

test('native launcher executes locally when configured command targets are not POSIX', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok\n');
});

test('native launcher exact target blocks dispatch when a clean cached probe is followed by a problem-bearing post-flush inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-postflush-problem-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'openssh'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) exit 0 ;;`,
    '  list) printf "%s|Watching|false|true|1|0/0|1/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /sync flush failed|synchronization.*unhealthy|transition/i);
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
});

test('startup and explicit sync share the command dispatch barrier and preserve newer source bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-causal-flush-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const runtime = nativeFixtureRuntime(stackDir);
  const syncControlDir = `/tmp/happier-sync-control-${process.getuid()}${dirname(runtime.dataDir)}/hstack-control`;
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const sourceBytes = join(root, 'source-bytes');
  const mirrorBytes = join(root, 'mirror-bytes');
  const firstFlushStarted = join(root, 'first-flush-started');
  const releaseFirstFlush = join(root, 'release-first-flush');
  const flushLog = join(root, 'flush-log');
  const startupLock = join(syncControlDir, 'happier-linux.lock');
  const queuedLog = join(root, 'queued');
  const releaseLock = join(root, 'release-lock');
  const children = [];
  const outputs = [];
  t.after(async () => {
    await Promise.all([writeFile(releaseLock, ''), writeFile(releaseFirstFlush, '')]);
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
    await rm(`/tmp/happier-sync-control-${process.getuid()}${root}`, { recursive: true, force: true });
  });

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(syncControlDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(sourceBytes, 'X\n');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='happier-linux'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) cp "${sourceBytes}" "${mirrorBytes}"; tr -d '\\n' < "${mirrorBytes}" >> "${flushLog}"; printf '\\n' >> "${flushLog}"; if grep -qx X "${mirrorBytes}" && [ ! -e "${releaseFirstFlush}" ]; then : > "${firstFlushStarted}"; while [ ! -e "${releaseFirstFlush}" ]; do sleep 0.02; done; fi ;;`,
    '  list) if [ "$5" = "{{json .}}" ]; then printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":2,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'; else printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; fi ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) printf 'mirror:'; cat "${mirrorBytes}" ;;`,
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    DBUS_SESSION_BUS_ADDRESS: '',
  };
  // Observe the external flock boundary; all domain and admission logic is real.
  await executable(join(binDir, 'flock'), `#!/bin/sh\ncase "$*" in *--locked-sync-flush*) printf 'queued\\n' >> ${JSON.stringify(queuedLog)} ;; esac\nexec /usr/bin/flock "$@"\n`);
  const launch = (label) => {
    const child = spawn(
      '/bin/sh',
      [launcher, '--target=linux', '--', 'probe-command', label],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    return child;
  };
  const collect = (child) => new Promise((resolveResult) => {
    const output = { stdout: '', stderr: '' };
    outputs.push(output);
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.once('exit', (code, signal) => resolveResult({ code, signal, ...output }));
  });
  const waitForFile = async (path) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await access(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${path}: ${JSON.stringify(outputs)}`);
  };

  const first = launch('first');
  const firstResult = collect(first);
  await waitForFile(firstFlushStarted);
  await writeFile(sourceBytes, 'Y\n');
  const second = launch('second');
  const secondResult = collect(second);
  await writeFile(releaseFirstFlush, 'release\n');

  const [firstCompleted, secondCompleted] = await Promise.all([firstResult, secondResult]);
  assert.equal(firstCompleted.code, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.code, 0, secondCompleted.stderr);
  assert.equal(secondCompleted.stdout, 'mirror:Y\n');
  assert.deepEqual((await readFile(flushLog, 'utf8')).trim().split('\n'), ['X', 'Y']);

  const held = spawn('/usr/bin/flock', [startupLock, 'sh', '-c', `: > ${JSON.stringify(root)}/lock-held; while [ ! -e ${JSON.stringify(releaseLock)} ]; do sleep 0.02; done`], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(held);
  const heldResult = collect(held);
  await waitForFile(join(root, 'lock-held'));
  await writeFile(sourceBytes, 'Z\n');
  await writeFile(queuedLog, '');
  const startup = flushDevTargetSync({ target: { name: 'linux' }, env: { ...env, MUTAGEN_DATA_DIRECTORY: runtime.dataDir } });
  const explicit = syncDevTarget({ target: { name: 'linux' }, stackBaseDir: stackDir, env });
  const command = collect(launch('shared'));
  let prematureDispatch;
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      if ((await readFile(queuedLog, 'utf8')).trim().split('\n').filter(Boolean).length >= 3) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.equal((await readFile(queuedLog, 'utf8')).trim().split('\n').filter(Boolean).length, 3, 'all three callers reached lock admission before release');
    prematureDispatch = (await readFile(flushLog, 'utf8')).trim().split('\n');
  } finally {
    await writeFile(releaseLock, '');
  }
  const [, , completed] = await Promise.all([startup, explicit, command, heldResult]);
  assert.deepEqual(prematureDispatch, ['X', 'Y'], 'all paths must wait behind the same session barrier');
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.stdout, 'mirror:Z\n');
  assert.deepEqual((await readFile(flushLog, 'utf8')).trim().split('\n'), ['X', 'Y', 'Z'], 'all pre-start demands share one fresh flush');
});


test('native launcher flushes an automatically selected mirror and retries another target after a flush failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-moving-mirror-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flush-ran');
  const freshMarker = `${remoteMarker}.fresh`;
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(cacheDir, 'provenance.jsonl'), '');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeFile(join(cacheDir, 'mac2.cache'), `${cachedAt} 1 0.500000 4\n`);
  await writeFile(join(cacheDir, `mac2.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_sync_name='named-mac2-sync'",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'if [ "$2" = "list" ]; then',
    '  printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"',
    '  exit 0',
    'fi',
    `printf '%s\\n' "$3" >> "${flushMarker}"`,
    'case "$3" in named-linux-sync|happier-*-linux) exit 73 ;; esac',
    `: > "${freshMarker}"`,
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in *"&& command -v "*) exit 0 ;; esac',
    `if [ ! -e "${freshMarker}" ]; then printf '%s\\n' 'remote dispatch attempted before sync flush' >&2; exit 74; fi`,
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected linux /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:.*probe-command.*ok/);
  assert.deepEqual((await readFile(flushMarker, 'utf8')).trim().split('\n'), [
    'named-linux-sync',
    'named-mac2-sync',
  ]);
  await readFile(remoteMarker);
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });

  // The same public retry must retain an authoritative sibling source, not
  // restart against the executor checkout after the first target fails.
  const sibling = await mkdtemp(join(dirname(repoRoot), 'hstack-sibling-retry-'));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  await writeFile(join(sibling, 'package.json'), '{}');
  await writeFile(join(sibling, 'yarn.lock'), '');
  const configPath = join(stackDir, 'dev-targets.json');
  await writeFile(configPath, JSON.stringify({ version: 3,
    targets: ['linux', 'mac2'].map(name => ({ name, platform: 'posix', ssh: `${name}-host`, repoDir: '/remote/repo', cliHomeDir: '/remote/home' })),
    commandExecution: { mode: 'auto', targets: ['linux', 'mac2'], fallback: 'error' },
  }));
  const env = { ...executionNeutralEnv, HOME: root, XDG_RUNTIME_DIR: root, HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_EXEC_CONFIG_PATH: configPath, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root };
  const siblingConfig = join(stackDir, `commands-${sibling.split('/').at(-1)}`, 'dev-targets.json');
  await mkdir(dirname(siblingConfig), { recursive: true });
  await writeFile(siblingConfig, JSON.stringify({ commandExecution: { mode: 'auto', targets: ['linux', 'mac2'], fallback: 'error' } }));
  const prepared = await prepareCommandRepository({ configPath, repoRoot: sibling, executorRepoRoot: repoRoot, synchronize: false, env });
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: dirname(prepared.path), sourceDir: sibling, env });
  await mkdir(dirname(runtime.projectFile), { recursive: true });
  await writeFile(runtime.projectFile, renderMutagenProject({ sourceDir: sibling, targets: prepared.config.targets, config: prepared.config, ownerId: 'dev-target-sync-service' }));
  await writeFile(runtime.syncServiceStateFile, JSON.stringify({ version: 1, state: 'ready', targets: {
    linux: { state: 'ready' }, mac2: { state: 'ready' },
  } }));
  const siblingCache = join(dirname(prepared.path), 'dev-target-command-load-native');
  await mkdir(siblingCache);
  for (const [name, score] of [['linux', 0], ['mac2', 0.5]]) {
    await writeFile(join(siblingCache, `${name}.cache`), `${Math.floor(Date.now() / 1000)} 1 ${score} 4\n`);
    await writeFile(join(siblingCache, `${name}.command.2560848116.cache`), `${Math.floor(Date.now() / 1000)} 1\n`);
  }
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  await rm(flushMarker);
  const siblingResult = spawnSync('/bin/sh', [launcher, `--repo=${sibling}`, '--', 'probe-command', 'sibling'], {
    cwd: sibling, env, encoding: 'utf8',
  });
  assert.equal(siblingResult.status, 0, siblingResult.stderr);
  assert.match(siblingResult.stdout, /remote:.*probe-command.*sibling/);
  assert.deepEqual((await readFile(flushMarker, 'utf8')).trim().split('\n'),
    ['linux', 'mac2'].map(name => resolveMutagenSessionName(name, sibling)));
});

test('native launcher exact target flushes the selected Mutagen session before remote dispatch and fails closed after a flush failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-flush-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flushes');
  const flushWaitStarted = join(root, 'mutagen-flush-started');
  const flushWaitRelease = join(root, 'mutagen-flush-release');
  const flushWaitFinished = join(root, 'mutagen-flush-finished');
  const flushWaitTerminated = join(root, 'mutagen-flush-terminated');
  const { dataDir: mutagenDataDir, opensshDir: mutagenSshPath } = nativeFixtureRuntime(stackDir);
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(mutagenDataDir, { recursive: true });
  await mkdir(mutagenSshPath, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  // Cached load keeps placement separate from prerequisite inspection. Only
  // payload execution requires the source flush, not the SSH tool preflight.
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, `linux.command.${probeCommandCacheKey}.cache`), `${cachedAt} 1 ready \n`);
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) : > "${remoteMarker}.fresh"; printf '%s|%s|%s\\n' "$MUTAGEN_DATA_DIRECTORY" "$MUTAGEN_SSH_PATH" "$3" >> "${flushMarker}"; if [ "\${FLUSH_WAIT-}" = 1 ]; then trap ': > "$FLUSH_WAIT_TERMINATED"; exit 0' TERM; : > "$FLUSH_WAIT_STARTED"; while [ ! -e "$FLUSH_WAIT_RELEASE" ]; do sleep 0.02; done; : > "$FLUSH_WAIT_FINISHED"; fi; [ "\${FLUSH_FAIL-}" != 1 ] || exit 73 ;;`,
    '  list) printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|2|ok|0|0\\n" "$3"; exit 0 ;;',
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in *"&& command -v "*) exit 0 ;; esac',
    `if [ ! -e "${remoteMarker}.fresh" ]; then printf '%s\\n' 'remote dispatch attempted before sync flush' >&2; exit 74; fi`,
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    XDG_RUNTIME_DIR: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const successful = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(successful.status, 0, successful.stderr);
  assert.match(successful.stdout, /remote:.*probe-command.*ok/);
  assert.equal(
    await readFile(flushMarker, 'utf8'),
    `${mutagenDataDir}|${mutagenSshPath}|named-linux-sync\n`,
  );
  await readFile(remoteMarker);

  await rm(remoteMarker, { force: true });
  const exactFailure = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'exact'], {
    cwd: repoRoot,
    env: { ...env, FLUSH_FAIL: '1' },
    encoding: 'utf8',
  });
  assert.equal(exactFailure.status, 1, exactFailure.stderr);
  assert.match(exactFailure.stderr, /sync flush failed.*linux/);
  assert.equal(exactFailure.stdout, '');
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
  assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);

  const waitForFile = async (path, label) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForFlushExit = async () => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(flushWaitTerminated);
        return;
      } catch {
        try {
          await readFile(flushWaitFinished);
          return;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
    }
    throw new Error('timed out waiting for the fake sync flush to exit');
  };
  const flushing = spawn('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'cancelled-flush'], {
    cwd: repoRoot,
    env: {
      ...env,
      FLUSH_WAIT: '1',
      FLUSH_WAIT_STARTED: flushWaitStarted,
      FLUSH_WAIT_RELEASE: flushWaitRelease,
      FLUSH_WAIT_FINISHED: flushWaitFinished,
      FLUSH_WAIT_TERMINATED: flushWaitTerminated,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForFile(flushWaitStarted, 'the selected sync flush');
    flushing.kill('SIGTERM');
    const exit = await new Promise((resolveExit) => flushing.once('exit', (code, signal) => resolveExit({ code, signal })));
    assert.deepEqual(exit, { code: 130, signal: null });
    await waitForFile(flushWaitTerminated, 'the interrupted sync flush to terminate');
    await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
    assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);
  } finally {
    await writeFile(flushWaitRelease, '', 'utf8');
    await waitForFlushExit();
    if (flushing.exitCode == null && flushing.signalCode == null) flushing.kill('SIGTERM');
  }
});

test('native launcher admits heavyweight local and remote jobs, reclaims stale owners, and cancels waiters', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-admission-'));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const repoRoot = resolve(launcher, '../../../..');
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-native-owner-native');
  const machineHome = join(root, 'machine-home');
  const holdMarker = join(root, 'first-started');
  const releaseMarker = join(root, 'release-first');
  const cancelledMarker = join(root, 'cancelled-command-ran');
  const runningMarker = join(root, 'running-command-started');
  const terminatedMarker = join(root, 'running-command-terminated');
  const collisionMarker = join(root, 'remote-command-ran-before-admission');
  const scopeMarker = join(root, 'systemd-scope-invocations');
  const staleOwner = join(admissionRoot, 'owners', '99999999-stale');
  const staleWaiter = join(admissionRoot, 'waiters', '99999998-stale');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(staleOwner, { recursive: true });
  await writeFile(join(staleOwner, 'process'), '99999999 stale\n', 'utf8');
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeNativeProjectionFixture(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='300'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *service_memory.mjs*) printf "service 0\\n"; exit 0 ;;',
    // Preparation precedes payload admission; this process-boundary fixture
    // has no dependency install or compiler leaf of its own to admit.
    '  *remote_dependency_bootstrap.mjs*) exit 0 ;;',
    '  *node_modules/vitest/vitest.mjs*) exec vitest "$@" ;;',
    '  *generateBundledPluginEntries.ts*) exec vitest remote-bundled-plugin-generator ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'corepack'), '#!/bin/sh\n[ "${1-}" = yarn ] && shift\nexec vitest "$@"\n');
  for (const packageManager of ['yarn', 'npm', 'pnpm']) {
    await executable(join(binDir, packageManager), '#!/bin/sh\nexec vitest "$@"\n');
  }
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nexec vitest "$@"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) if [ -e "$HOLD_MARKER" ] && [ ! -e "$RELEASE_MARKER" ]; then printf "5\\n"; else printf "0\\n"; fi ;;',
    '  */proc/meminfo*) if [ -e "$HOLD_MARKER" ] && [ ! -e "$RELEASE_MARKER" ]; then available=9437184; else available=48000000; fi; case "$1" in *MemAvailable*) printf "%s 72000000\\n" "$available" ;; *) printf "72000000\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *LoadState*) printf "loaded\\n"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMD_SCOPE_MARKER"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --slice=*) export TEST_CURRENT_CGROUP=/user.slice/${1#--slice=}/fixture.scope ;; esac',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'sed'), '#!/bin/sh\ncase "$*" in *"/proc/self/cgroup") printf "%s\\n" "${TEST_CURRENT_CGROUP-/user.slice/unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac\n');
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *local-first*)',
    '    : > "$HOLD_MARKER"',
    '    while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '    printf "local-first\\n"',
    '    ;;',
    '  *local-cancel*)',
    '    : > "$CANCELLED_MARKER"',
    '    printf "local-cancel\\n"',
    '    ;;',
    '  *local-running-cancel*)',
    '    : > "$RUNNING_MARKER"',
    '    trap \': > "$TERMINATED_MARKER"; exit 0\' TERM',
    '    while :; do sleep 1; done',
    '    ;;',
    '  *remote-node-vitest*|*remote-third*|*remote-bootstrap*|*install*)',
    '    if [ ! -e "$RELEASE_MARKER" ]; then : > "$COLLISION_MARKER"; fi',
    '    printf "remote-heavy\\n"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'control_path=',
    'previous=',
    'for argument in "$@"; do',
    '  if [ "$previous" = -S ]; then control_path=$argument; fi',
    '  previous=$argument',
    'done',
    'case "$*" in',
    '  *getconf*) printf "4 0 0.8 22000000 20 0 48000000 72000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-O\\ check*) [ -f "$control_path" ] ;;',
    '  *-MNf*) mkdir -p "${control_path%/*}"; : > "$control_path" ;;',
    '  *-O\\ exit*) rm -f -- "$control_path" ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    cd -- "$REMOTE_LOGIN_CWD"',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_CLI_HOME_DIR: machineHome,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_EXEC_CONFIG_PATH: join(stackDir, 'dev-targets.json'),
    npm_node_execpath: '',
    npm_execpath: '',
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    HOLD_MARKER: holdMarker,
    RELEASE_MARKER: releaseMarker,
    CANCELLED_MARKER: cancelledMarker,
    RUNNING_MARKER: runningMarker,
    TERMINATED_MARKER: terminatedMarker,
    COLLISION_MARKER: collisionMarker,
    SYSTEMD_SCOPE_MARKER: scopeMarker,
    REMOTE_LOGIN_CWD: root,
  };
  const collect = (child) => {
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
  };
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(`timed out waiting for ${typeof label === 'function' ? label() : label}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  const remoteSchedulingWait = /waiting for (?:(?:pool )?heavyweight (?:admission|capacity)|dispatch reservation)/;
  const remoteAdmissionEvidence = /(?:admitted heavyweight command|waiting for (?:(?:pool )?heavyweight (?:admission|capacity)|dispatch reservation))/;

  const first = spawn('/bin/sh', [launcher, '--local', '--script=test:local-first'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstOutput = collect(first);
  let cancelled;
  let remote;
  let nodeVitest;
  let installs = [];
  let running;
  try {
    await waitFor(async () => {
      try {
        await readFile(holdMarker);
        return true;
      } catch {
        return false;
      }
    }, 'the first heavyweight job');
    await assert.rejects(readdir(staleOwner), { code: 'ENOENT' });
    await writeFile(staleWaiter, '99999998 stale\n', 'utf8');

    nodeVitest = spawn('/bin/sh', [launcher, '--target=linux', '--', 'node', 'node_modules/vitest/vitest.mjs', 'remote-node-vitest.test.ts'], {
      cwd: join(repoRoot, 'apps', 'stack'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nodeVitestOutput = collect(nodeVitest);
    await waitFor(
      () => /waiting for heavyweight admission/.test(nodeVitestOutput.stderr) || nodeVitest.exitCode != null,
      'a Node-launched Vitest admission wait behind the local job',
    );
    assert.match(nodeVitestOutput.stderr, /waiting for heavyweight admission/, `Node-launched Vitest output\nstdout: ${nodeVitestOutput.stdout}\nstderr: ${nodeVitestOutput.stderr}`);
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });

    cancelled = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'local-cancel.test.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cancelledOutput = collect(cancelled);
    await waitFor(() => /waiting for heavyweight admission/.test(cancelledOutput.stderr), 'a cancellable local admission wait');
    cancelled.kill('SIGTERM');
    assert.equal(await waitForExit(cancelled), 130, cancelledOutput.stderr);
    await assert.rejects(readFile(cancelledMarker), { code: 'ENOENT' });

    remote = spawn('/bin/sh', [launcher, '--', 'tsc', '--noEmit', 'remote-third.ts'], {
      cwd: join(repoRoot, 'apps', 'stack'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remoteOutput = collect(remote);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
    await waitFor(
      () => remoteSchedulingWait.test(remoteOutput.stderr) || remote.exitCode != null,
      () => `a remote scheduling wait behind the local job (stdout=${remoteOutput.stdout}; stderr=${remoteOutput.stderr})`,
    );
    assert.match(
      remoteOutput.stderr,
      remoteSchedulingWait,
      `Remote TypeScript output\nstdout: ${remoteOutput.stdout}\nstderr: ${remoteOutput.stderr}`,
    );
    for (const argumentsForInstall of [
      ['corepack', 'yarn', 'install', '--immutable'],
      ['yarn', 'install', '--immutable'],
      ['npm', 'install', '--ignore-scripts'],
      ['pnpm', 'install', '--frozen-lockfile'],
    ]) {
      const install = spawn('/bin/sh', [launcher, '--', ...argumentsForInstall], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = collect(install);
      await waitFor(
        () => remoteSchedulingWait.test(output.stderr),
        `a remote dependency-install admission wait (stdout=${output.stdout}; stderr=${output.stderr})`,
      );
      installs.push({ install, output });
    }
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
    await writeFile(releaseMarker, '', 'utf8');

    assert.equal(await waitForExit(first), 0, firstOutput.stderr);
    assert.equal(await waitForExit(remote), 0, remoteOutput.stderr);
    assert.equal(await waitForExit(nodeVitest), 0, nodeVitestOutput.stderr);
    await assert.rejects(readFile(staleWaiter), { code: 'ENOENT' });
    for (const { install, output } of installs) {
      assert.equal(await waitForExit(install), 0, output.stderr);
      assert.match(
        output.stderr,
        remoteAdmissionEvidence,
      );
      assert.match(output.stdout, /remote-heavy/);
    }
    assert.match(firstOutput.stdout, /local-first/);
    assert.match(remoteOutput.stdout, /remote-heavy/);
    assert.match(remoteOutput.stderr, remoteAdmissionEvidence);
    assert.match(nodeVitestOutput.stdout, /remote-heavy/);
    assert.match(nodeVitestOutput.stderr, remoteAdmissionEvidence);
    assert.match(
      await readFile(scopeMarker, 'utf8'),
      /--user --scope --quiet --slice=happier-jobs\.slice --nice=1[0-9] -- bash -c .*tsc.*remote-third/s,
    );
    assert.match(
      await readFile(scopeMarker, 'utf8'),
      /--user --scope --quiet --slice=happier-jobs\.slice --nice=1[0-9] -- bash -c .*'node' 'node_modules\/vitest\/vitest\.mjs' 'remote-node-vitest/s,
    );
    assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);

    running = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'local-running-cancel.test.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runningOutput = collect(running);
    await waitFor(async () => {
      try {
        await readFile(runningMarker);
        return true;
      } catch {
        return false;
      }
    }, 'a running heavyweight command');
    running.kill('SIGTERM');
    assert.equal(await waitForExit(running), 130, runningOutput.stderr);
    await waitFor(async () => {
      try {
        await readFile(terminatedMarker);
        return true;
      } catch {
        return false;
      }
    }, 'the running heavyweight child to terminate');
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    if (cancelled && cancelled.exitCode == null) cancelled.kill('SIGTERM');
    if (remote && remote.exitCode == null) remote.kill('SIGTERM');
    if (nodeVitest && nodeVitest.exitCode == null) nodeVitest.kill('SIGTERM');
    for (const { install } of installs) {
      if (install.exitCode == null) install.kill('SIGTERM');
    }
    if (running && running.exitCode == null) running.kill('SIGTERM');
    if (first.exitCode == null) first.kill('SIGTERM');
  }
});

test('native admission uses the measured memory envelope without arbitrary pressure denials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cpu-saturation-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${FIXTURE_PLATFORM:-Linux}"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\ncase "$*" in *hw.ncpu*) printf "4\\n" ;; *) printf "{ 99 99 99 }\\n" ;; esac\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "%s\\n" "${FIXTURE_RUN_QUEUE:-0}" ;;',
    '  */proc/meminfo*) printf "9437184 %s\\n" "${FIXTURE_TOTAL_MEMORY:-28311552}" ;;',
    '  */proc/pressure/cpu*) printf "%s\\n" "${FIXTURE_CPU_PSI:-0}" ;;',
    '  */proc/pressure/memory*) printf "%s\\n" "${FIXTURE_MEMORY_PSI:-0}" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  for (const telemetry of [
    { FIXTURE_RUN_QUEUE: '12', FIXTURE_CPU_PSI: '75' },
    { FIXTURE_MEMORY_PSI: '11' },
    { FIXTURE_TOTAL_MEMORY: '125829120' },
    { FIXTURE_PLATFORM: 'Darwin' },
  ]) {
    const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=validation', '--machine=dedicated-worker', '--no-wait', '--', '/usr/bin/printf', 'admitted'], {
      cwd: repoRoot, encoding: 'utf8',
      env: { ...executionNeutralEnv, HOME: root, PATH: `${binDir}:/usr/bin:/bin`, TMPDIR: root, ...telemetry },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'admitted');
  }
});

test('native launcher does not derive a fixed heavyweight job count from the worker profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-profile-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const firstMarker = join(root, 'first-admitted');
  const secondMarker = join(root, 'second-admitted');
  const thirdMarker = join(root, 'third-admitted');
  const releaseMarker = join(root, 'release');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
    // A VM configured with 24 GiB exposes less than 24 GiB as MemTotal after kernel overhead.
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "23068672 24557560\\n" ;; *) printf "24557560\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "1.4\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'hold'), [
    '#!/bin/sh',
    ': > "$1"',
    'while [ ! -e "$2" ]; do sleep 0.02; done',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waitForFile = async (path, label, diagnostic = () => '') => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}${diagnostic()}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  const run = (marker) => spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=worker-profile',
    '--',
    'hold',
    marker,
    releaseMarker,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const first = run(firstMarker);
  let second;
  let third;
  const outputFor = (child) => {
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
  };
  const firstOutput = outputFor(first);
  let thirdStderr = '';
  try {
    await waitForFile(firstMarker, 'the first worker-profile admission', () =>
      ` (first exit=${first.exitCode}; stderr=${firstOutput.stderr})`,
    );
    second = run(secondMarker);
    await waitForFile(secondMarker, 'the second worker-profile admission');
    third = run(thirdMarker);
    third.stderr.on('data', (chunk) => { thirdStderr += chunk; });
    await waitForFile(thirdMarker, 'the third worker-profile admission');
    assert.doesNotMatch(thirdStderr, /active=2\/2/);
    await writeFile(releaseMarker, '', 'utf8');
    assert.equal(await waitForExit(first), 0);
    assert.equal(await waitForExit(second), 0);
    assert.equal(await waitForExit(third), 0);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    for (const child of [first, second, third]) {
      if (child && child.exitCode == null) child.kill('SIGTERM');
    }
  }
});

test('native admission reaps dead waiters and owners on a check even when memory prevents admission', {
  skip: process.platform !== 'linux',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dead-admission-records-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await installNativeAdmissionFixture({ root });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await executable(join(bin, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "1048576 28311552\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  const processStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const token = processStat.slice(processStat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
  const deadWaiter = join(fixture.admissionRoot, 'waiters/99999998-1');
  const deadOwner = join(fixture.admissionRoot, 'owners/99999999-1');
  const liveWaiter = join(fixture.admissionRoot, `waiters/${process.pid}-${token}`);
  const reusedOwner = join(fixture.admissionRoot, `owners/${process.pid}-${Number(token) + 1}`);
  const reusedWaiter = join(fixture.admissionRoot, `waiters/${process.pid}-${Number(token) + 1}`);
  await mkdir(join(fixture.admissionRoot, 'waiters'), { recursive: true });
  await mkdir(deadOwner, { recursive: true });
  await mkdir(reusedOwner, { recursive: true });
  await writeFile(join(reusedOwner, 'process'), `${process.pid} ${Number(token) + 1}\n`);
  await writeFile(join(reusedOwner, 'class'), 'runtime-build\n');
  await writeFile(reusedWaiter, `${process.pid} ${Number(token) + 1} 1 runtime-build 0\n`);
  await writeFile(join(deadOwner, 'process'), '99999999 1\n');
  await writeFile(join(deadOwner, 'class'), 'runtime-build\n');
  await writeFile(deadWaiter, '99999998 1 1 runtime-build 0\n');
  await writeFile(liveWaiter, `${process.pid} ${token} 2 runtime-build 0\n`);
  const result = spawnSync('/bin/sh', [fixture.launcher, '--heavyweight-admission', '--class=validation',
    '--machine=fixture', '--no-wait', '--', '/usr/bin/printf', 'must not run'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, '');
  await assert.rejects(access(deadOwner), { code: 'ENOENT' });
  await assert.rejects(access(deadWaiter), { code: 'ENOENT' });
  await assert.rejects(access(reusedOwner), { code: 'ENOENT' });
  await assert.rejects(access(reusedWaiter), { code: 'ENOENT' });
  assert.equal(await readFile(liveWaiter, 'utf8'), `${process.pid} ${token} 2 runtime-build 0\n`, 'live queue age and backfill stay intact');
  await mkdir(deadOwner, { recursive: true });
  await writeFile(join(deadOwner, 'process'), '99999999 1\n');
  await writeFile(deadWaiter, '99999998 1 1 runtime-build 0\n');
  const checked = spawnSync('/bin/sh', [fixture.launcher, '--heavyweight-admission-check', '--class=validation', '--machine=fixture'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...executionNeutralEnv, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(checked.status, 1, checked.stderr);
  await assert.rejects(access(deadOwner), { code: 'ENOENT' });
  await assert.rejects(access(deadWaiter), { code: 'ENOENT' });
  assert.equal(await readFile(liveWaiter, 'utf8'), `${process.pid} ${token} 2 runtime-build 0\n`);
});

test('native launcher does not admit a newer heavyweight waiter ahead of an older fitting live waiter', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-fairness-'));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const marker = join(root, 'admitted');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "0\\n" ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(binDir, 'record'), '#!/bin/sh\n: > "$ADMITTED_MARKER"\n');

  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const processStartToken = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
  const olderWaiter = join(admissionRoot, 'waiters', `${process.pid}-${processStartToken}`);
  await writeFile(olderWaiter, `${process.pid} ${processStartToken} 1 validation 0\n`, 'utf8');

  const child = spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=fair-worker',
    '--',
    'record',
  ], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      ADMITTED_MARKER: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.equal(child.exitCode, null, stderr);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });

    await rm(olderWaiter);
    const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
    assert.equal(exitCode, 0, stderr);
    await readFile(marker);
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
});

test('native launcher reuses a validated parent heavyweight reservation only for the canonical host authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-reentrant-'));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const otherAdmissionRoot = join(root, 'other', '.happier', 'heavyweight-admission-v1');
  const outerScript = join(root, 'outer.sh');
  const inheritedMarker = join(root, 'inherited-token');
  const aliasMarker = join(root, 'alias-token');
  const nestedSliceMarker = join(root, 'nested-slice');
  const outerReady = join(root, 'outer-ready');
  const releaseMarker = join(root, 'release');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "0\\n" ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemctl'), '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *happier-jobs.slice*) printf "loaded\\n" ;; *) exit 1 ;; esac\n');
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --slice=*) export HSTACK_TEST_SLICE=${1#--slice=} ;; --) shift; break ;; esac',
    '  shift',
    'done',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), '#!/bin/sh\nprintf "%s\\n" "$HSTACK_TEST_SLICE" > "$NESTED_SLICE_MARKER"\n');
  await executable(join(binDir, 'sed'), [
    '#!/bin/sh',
    // The systemd adapter above owns the simulated kernel placement. Do not
    // borrow the enclosing runner's real jobs cgroup for this OS fixture.
    'case "$*" in *"/proc/self/cgroup") printf "/user.slice/%s/fixture.scope\\n" "${HSTACK_TEST_SLICE-unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac',
    '',
  ].join('\n'));
  await executable(outerScript, [
    '#!/bin/sh',
    'set -eu',
    'printf "%s|%s|%s\\n" "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" "$HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT" "$HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE" > "$INHERITED_MARKER"',
    `"${launcher}" --heavyweight-admission --admission-root="${otherAdmissionRoot}" --machine=another-label-for-this-worker -- /bin/sh -c 'printf "%s\\n" "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN"' > "$ALIAS_MARKER"`,
    `HSTACK_TEST_SLICE=happier-critical.slice HAPPIER_HSTACK_DISPATCH_CONTROL=1 HAPPIER_DEV_TARGET_EXECUTION=1 "${launcher}" -- vitest run nested-reentrant.test.ts`,
    ': > "$OUTER_READY"',
    'while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    INHERITED_MARKER: inheritedMarker,
    ALIAS_MARKER: aliasMarker,
    NESTED_SLICE_MARKER: nestedSliceMarker,
    OUTER_READY: outerReady,
    RELEASE_MARKER: releaseMarker,
  };
  const waitForFile = async (path, label) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  const runAdmission = ({ rootPath, machine, token, inheritedRoot = rootPath, inheritedMachine = machine }) => spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    `--admission-root=${rootPath}`,
    '--class=validation',
    `--machine=${machine}`,
    '--',
    '/bin/sh',
    '-c',
    'printf "%s\\n" "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN"',
  ], {
    cwd: repoRoot,
    env: {
      ...env,
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: token,
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: inheritedRoot,
      HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: inheritedMachine,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const outer = spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    `--admission-root=${admissionRoot}`,
    '--class=validation',
    '--machine=machine-a',
    '--',
    outerScript,
  ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stale;
  let crossMachine;
  let crossRoot;
  try {
    await waitForFile(outerReady, 'the outer admission after its nested invocation');
    assert.equal((await readFile(nestedSliceMarker, 'utf8')).trim(), 'happier-jobs.slice');
    const inherited = (await readFile(inheritedMarker, 'utf8')).trim().split('|');
    assert.match(inherited[0], /^[0-9]+:[0-9]+$/);
    assert.equal(inherited[1], admissionRoot);
    assert.ok(inherited[2]);
    const [ownerIdentity] = await readdir(join(admissionRoot, 'owners'));
    const [ownerPid, ownerToken] = (await readFile(join(admissionRoot, 'owners', ownerIdentity, 'process'), 'utf8')).trim().split(' ');
    assert.equal(inherited[0], `${ownerPid}:${ownerToken}`);

    assert.equal((await readFile(aliasMarker, 'utf8')).trim(), inherited[0], 'caller labels and private root arguments cannot split a validated descendant owner');

    stale = runAdmission({
      rootPath: admissionRoot,
      machine: 'machine-a',
      token: `${ownerPid}:0`,
      inheritedMachine: inherited[2],
    });
    let staleStdout = '';
    stale.stdout.on('data', (chunk) => { staleStdout += chunk; });
    assert.equal(await waitForExit(stale), 0);
    assert.notEqual(staleStdout.trim(), `${ownerPid}:${ownerToken}`);
    crossMachine = runAdmission({
      rootPath: admissionRoot,
      machine: 'machine-b',
      token: `${ownerPid}:${ownerToken}`,
      inheritedMachine: 'machine-b',
    });
    let crossMachineStdout = '';
    crossMachine.stdout.on('data', (chunk) => { crossMachineStdout += chunk; });
    assert.equal(await waitForExit(crossMachine), 0);
    assert.notEqual(crossMachineStdout.trim(), `${ownerPid}:${ownerToken}`);
    crossRoot = runAdmission({
      rootPath: otherAdmissionRoot,
      machine: 'machine-a',
      token: `${ownerPid}:${ownerToken}`,
      inheritedRoot: otherAdmissionRoot,
      inheritedMachine: inherited[2],
    });
    let crossRootStdout = '';
    crossRoot.stdout.on('data', (chunk) => { crossRootStdout += chunk; });
    assert.equal(await waitForExit(crossRoot), 0);
    assert.notEqual(crossRootStdout.trim(), `${ownerPid}:${ownerToken}`);
    assert.equal(outer.exitCode, null);
    assert.equal(await readdir(join(admissionRoot, 'owners')).then((entries) => entries.length), 1);

    await writeFile(releaseMarker, '', 'utf8');
    assert.equal(await waitForExit(outer), 0);
    assert.equal(await waitForExit(stale), 0);
    assert.equal(await waitForExit(crossMachine), 0);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    for (const child of [outer, stale, crossMachine, crossRoot]) {
      if (child && child.exitCode == null) child.kill('SIGTERM');
    }
  }
});

test('native launcher never removes a successor heavyweight admission lock while reclaiming stale state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-lock-successor-'));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const lockPath = join(admissionRoot, 'lock');
  const disappearanceMarker = join(root, 'successor-lock-disappeared');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(admissionRoot, 'owners'), { recursive: true });
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "0\\n" ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "1.4\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'rm'), [
    '#!/bin/sh',
    'case " $* " in',
    '  *" $HEAVYWEIGHT_LOCK_PATH "*)',
    '    if [ ! -e "$DISAPPEARANCE_MARKER" ]; then',
    '      /bin/rm -f -- "$HEAVYWEIGHT_LOCK_PATH"',
    '      printf "%s -\\n" "$SUCCESSOR_PID" > "$HEAVYWEIGHT_LOCK_PATH"',
    '      /bin/rm -f -- "$HEAVYWEIGHT_LOCK_PATH"',
    '      : > "$DISAPPEARANCE_MARKER"',
    '      exit 0',
    '    fi',
    '    ;;',
    'esac',
    'exec /bin/rm "$@"',
    '',
  ].join('\n'));
  await writeFile(lockPath, '999999 stale\n', 'utf8');
  const successor = spawn('/bin/sh', ['-c', 'sleep 10'], { stdio: 'ignore' });
  const result = spawnSync('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=successor-race',
    '--',
    '/usr/bin/true',
  ], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      HEAVYWEIGHT_LOCK_PATH: lockPath,
      DISAPPEARANCE_MARKER: disappearanceMarker,
      SUCCESSOR_PID: String(successor.pid),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(disappearanceMarker), { code: 'ENOENT' });
  } finally {
    if (successor.exitCode == null) successor.kill('SIGTERM');
  }
});

test('native launcher backs off heavyweight lock acquisition under contention', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-lock-backoff-'));
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root });
  const binDir = join(root, 'bin');
  const lockPath = join(admissionRoot, 'lock');
  const lockAttempts = join(root, 'lock-attempts');
  const holderReady = join(root, 'holder-ready');
  const sleepAttempts = join(root, 'sleep-attempts');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(admissionRoot, 'owners'), { recursive: true });
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    'printf "x\\n" >> "$FLOCK_ATTEMPTS"',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'sleep'), [
    '#!/bin/sh',
    'printf "%s\\n" "$1" >> "$SLEEP_ATTEMPTS"',
    'exec /bin/sleep "$@"',
    '',
  ].join('\n'));
  const holder = spawn('/bin/sh', [
    '-c',
    'exec 9>>"$1"; /usr/bin/flock -x 9; : > "$2"; sleep 10',
    'lock-holder',
    lockPath,
    holderReady,
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await readFile(holderReady);
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  await readFile(holderReady);
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    FLOCK_ATTEMPTS: lockAttempts,
    SLEEP_ATTEMPTS: sleepAttempts,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waiter = spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=lock-backoff',
    '--',
    '/usr/bin/true',
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  try {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(lockAttempts);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
    const attempts = (await readFile(lockAttempts, 'utf8')).trim().split('\n').filter(Boolean).length;
    const sleeps = (await readFile(sleepAttempts, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(holder.exitCode, null);
    await readFile(lockPath);
    assert.ok(attempts <= 2, `expected at most two flock attempts while a lock is held, received ${attempts} (sleeps=${sleeps.join(',')})`);
    assert.ok(sleeps.length > 0, 'expected the contended waiter to record a passive retry delay');
    assert.ok(sleeps.every((delay) => delay === String(2 + (waiter.pid % 2))), `expected a 2–3 second PID-jittered retry delay, received ${sleeps.join(',')}`);
    waiter.kill('SIGTERM');
    assert.equal(await waitForExit(waiter), 130);
  } finally {
    if (waiter.exitCode == null) waiter.kill('SIGTERM');
    if (holder.exitCode == null) holder.kill('SIGTERM');
  }
});

test('native launcher scopes admitted Linux work only when the systemd user slice is ready', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-scope-'));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const repoRoot = resolve(launcher, '../../../..');
  const readyBin = join(root, 'ready-bin');
  const fallbackBin = join(root, 'fallback-bin');
  const scopedMarker = join(root, 'scoped-command');
  const fallbackMarker = join(root, 'fallback-command');
  const scopedArguments = join(root, 'systemd-run-arguments');
  const scopeInvocations = join(root, 'scope-invocations');
  const scopeUnits = join(root, 'scope-units');
  const fallbackScopeAttempt = join(root, 'unexpected-systemd-run');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const binDir of [readyBin, fallbackBin]) {
    await mkdir(binDir, { recursive: true });
    await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
    await executable(join(binDir, 'awk'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
      '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
      '  */proc/pressure/memory*) printf "1.4\\n" ;;',
      '  *) exec /usr/bin/awk "$@" ;;',
      'esac',
      '',
    ].join('\n'));
    await executable(join(binDir, 'scoped-command'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$SCOPED_MARKER"\n');
  }
  await executable(join(readyBin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *LoadState*) printf "loaded\\n"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(readyBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" > "$SYSTEMD_RUN_ARGUMENTS"',
    'unit=; slice=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in --unit=*) unit=${1#--unit=} ;; --slice=*) slice=${1#--slice=} ;; --nice=*) if [ "${1#--nice=}" -lt "${TEST_INHERITED_NICE:-0}" ]; then printf "Failed to set nice level: Permission denied\\n" >&2; exit 1; fi ;; esac',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    // systemd 259 identifies a default scope by process identity and execs the
    // payload in that process. Procfs and systemd are genuine OS boundaries.
    'if [ -z "$unit" ]; then token=$(/usr/bin/awk \'{print $22}\' /proc/$$/stat); unit=run-p$$-i$token.scope; fi',
    'mkdir -p -- "$SCOPE_UNITS"',
    'if ! mkdir "$SCOPE_UNITS/$unit"; then printf "Failed to start transient scope unit: Unit %s was already loaded or has a fragment file.\\n" "$unit" >&2; exit 42; fi',
    'printf "%s|%s\\n" "$unit" "$slice" >> "$SCOPE_INVOCATIONS"',
    'export TEST_CURRENT_CGROUP=/user.slice/user-1000.slice/user@1000.service/happier.slice/$slice/$unit',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(readyBin, 'sed'), [
    '#!/bin/sh',
    'case "$*" in *"/proc/self/cgroup") printf "%s\\n" "${TEST_CURRENT_CGROUP-/user.slice/unscoped}" ;; *) exec /usr/bin/sed "$@" ;; esac',
    '',
  ].join('\n'));
  // OS boundary: systemd cannot raise an unprivileged child's inherited priority.
  await executable(join(readyBin, 'ps'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "-o ni= -p "*) printf "%s\\n" "${TEST_INHERITED_NICE:-0}" ;;',
    '  *) exec /usr/bin/ps "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(fallbackBin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(fallbackBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "unexpected\\n" > "$FALLBACK_SCOPE_ATTEMPT"',
    'exit 42',
    '',
  ].join('\n'));

  const run = (binDir, home, marker, { inheritedNice = 0, protectedLocal = false, command } = {}) => spawnSync('/bin/sh', [
    launcher,
    ...(protectedLocal ? ['--local'] : [
      '--heavyweight-admission',
      '--class=validation',
      '--machine=scope-profile',
    ]),
    '--',
    ...(command ?? ['scoped-command', marker === scopedMarker ? 'scoped' : 'fallback']),
  ], {
    cwd: join(root, 'native-owner'),
    env: {
      ...executionNeutralEnv,
      HOME: home,
      TEST_INHERITED_NICE: String(inheritedNice),
      ...(protectedLocal ? { HAPPIER_HSTACK_DISPATCH_CONTROL: '1' } : {}),
      SCOPED_MARKER: marker,
      SYSTEMD_RUN_ARGUMENTS: scopedArguments,
      SCOPE_UNITS: scopeUnits,
      SCOPE_INVOCATIONS: scopeInvocations,
      TEST_LAUNCHER: launcher,
      FALLBACK_SCOPE_ATTEMPT: fallbackScopeAttempt,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  const scoped = run(readyBin, join(root, 'ready-home'), scopedMarker);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
  assert.match(
    await readFile(scopedArguments, 'utf8'),
    /--user --scope --quiet --slice=happier-jobs\.slice --nice=10 -- scoped-command scoped/,
  );

  const fallback = run(fallbackBin, join(root, 'fallback-home'), fallbackMarker);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(await readFile(fallbackMarker, 'utf8'), 'fallback\n');
  await assert.rejects(readFile(fallbackScopeAttempt), { code: 'ENOENT' });

  for (const protectedLocal of [false, true]) {
    const inherited = run(readyBin, join(root, `inherited-home-${protectedLocal}`), scopedMarker, {
      inheritedNice: 19,
      protectedLocal,
    });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
    assert.match(await readFile(scopedArguments, 'utf8'), /--nice=19 -- scoped-command scoped/);
  }

  for (const throughCriticalScope of [false, true]) {
    await writeFile(scopeInvocations, '');
    const nestedCommand = '"$TEST_LAUNCHER" --heavyweight-admission --class=validation --machine=scope-profile -- scoped-command scoped';
    const command = throughCriticalScope
      ? `systemd-run --user --scope --quiet --slice=happier-critical.slice -- ${nestedCommand}; result=$?; exit "$result"`
      : `exec ${nestedCommand}`;
    const nested = run(readyBin, join(root, `nested-home-${throughCriticalScope}`), scopedMarker, {
      command: ['/bin/sh', '-c', command],
    });
    assert.equal(nested.status, 0, `critical transition: ${throughCriticalScope}\n${nested.stderr}`);
    assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
    const scopes = (await readFile(scopeInvocations, 'utf8')).trim().split('\n');
    assert.equal(scopes.length, throughCriticalScope ? 3 : 1);
    assert.equal(scopes.at(-1).split('|')[1], 'happier-jobs.slice');
  }
});

test('Windows launcher is explicitly local-only and does not start the Node router', async () => {
  const cmd = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.cmd'), 'utf8');
  const powershell = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.ps1'), 'utf8');
  assert.doesNotMatch(cmd, /\bnode\b/i);
  assert.match(cmd, /powershell/i);
  assert.doesNotMatch(powershell, /HAPPIER_PREFERRED_EXECUTION/);
  assert.match(powershell, /\$invocation\[0\] -eq '--local'/);
});
