import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { resolveHeavyweightMemoryFloorKiB, resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';

test('server handoff persists an inherited target registry only after the real directory transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-inherited-server-move-'));
  try {
    const stackName = 'qa-retained';
    const sourceDir = join(root, stackName, 'server-light');
    await mkdir(sourceDir, { recursive: true });
    const database = new DatabaseSync(join(sourceDir, 'happier-server-light.sqlite'));
    database.exec('CREATE TABLE Account(id TEXT); INSERT INTO Account VALUES (\'retained\')');
    database.close();
    await writeFile(join(sourceDir, 'handy-master-secret.txt'), 'fixture-signing-secret', { mode: 0o600 });
    await run(['add', 'linux', '--stack=producer', '--platform=posix', '--ssh=fixture-worker', `--repo-dir=${resolve(import.meta.dirname, '../../..')}`, `--cli-home-dir=${join(root, 'remote-state')}`], root);
    const producerPath = join(root, 'producer', 'dev-targets.json');
    const producerBefore = await readFile(producerPath);
    const producer = JSON.parse(producerBefore);
    const paths = resolveRemoteStackStatePaths(producer.targets[0], { stackName, runtimeMode: 'controlled' });
    await writeFile(join(root, stackName, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [], runtimePlacement: { expo: { mode: 'local' } }, commandExecution: { mode: 'local' } }));
    const { binDir } = writeFakeBin({ root, name: 'mutagen', content: '#!/bin/sh\nif [ "$1 $2" = "sync list" ]; then case "$*" in *json*) printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":4,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\' ;; *) printf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|4|ok|0|0\\n" ;; esac; fi\n' });
    writeFakeBin({ root, name: 'ssh', content: '#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process"); const result=spawnSync("/bin/sh",["-c",process.argv.at(-1)],{stdio:"inherit",env:process.env}); process.exit(result.status ?? 1);\n' });
    writeFakeBin({ root, name: 'scp', content: '#!/usr/bin/env node\nconst {copyFileSync,readFileSync,writeFileSync}=require("node:fs"); const args=process.argv.slice(-2); const destination=args[1].slice(args[1].indexOf(":")+1).replace(/^\'|\'$/g, ""); copyFileSync(args[0],destination); const path=process.env.RETARGET_DURING_UPLOAD_CONFIG; if(path){const config=JSON.parse(readFileSync(path)); config.targets[0].cliHomeDir += "-changed"; writeFileSync(path,JSON.stringify(config));}\n' });
    const result = await run(['move-server', 'linux', `--stack=${stackName}`], root, { PATH: `${binDir}:${process.env.PATH}`, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' });
    assert.equal(result.moved, true);
    const persisted = JSON.parse(await readFile(join(root, stackName, 'dev-targets.json')));
    assert.equal(persisted.targets[0].name, 'linux');
    assert.equal(persisted.runtimePlacement.server.target, 'linux');
    assert.equal(persisted.runtimePlacement.daemon.target, 'linux');
    assert.deepEqual(persisted.runtimePlacement.qa.targets, ['linux']);
    assert.equal(persisted.runtimePlacement.expo.mode, 'local');
    assert.deepEqual(persisted.commandExecution, { mode: 'local' });
    assert.equal(await readFile(join(paths.serverLightDataDir, 'handy-master-secret.txt'), 'utf8'), 'fixture-signing-secret');
    assert.equal(await readFile(join(sourceDir, 'handy-master-secret.txt'), 'utf8'), 'fixture-signing-secret');
    assert.deepEqual(await readFile(producerPath), producerBefore);
    const consumerConfigPath = join(root, stackName, 'dev-targets.json');
    await writeFile(consumerConfigPath, JSON.stringify({ version: 3, targets: producer.targets, runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' } }, commandExecution: { mode: 'local' } }));
    const changedTarget = await runRaw(['move-server', 'linux', `--stack=${stackName}`, '--json'], root, {
      PATH: `${binDir}:${process.env.PATH}`, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', RETARGET_DURING_UPLOAD_CONFIG: consumerConfigPath,
    });
    assert.equal(changedTarget.code, 1);
    assert.match(changedTarget.stderr, /target.*changed during handoff/);
    assert.equal(JSON.parse(await readFile(consumerConfigPath)).runtimePlacement.server.mode, 'local');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const execFileAsync = promisify(execFile);
const script = join(import.meta.dirname, 'dev_targets.mjs');

test('QA browser refuses an unconfigured browser pool before launching a browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-browser-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent-qa-browser'), { recursive: true });
  await writeFile(join(root, 'agent-qa-browser', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [], runtimePlacement: { daemon: { mode: 'local' } }, commandExecution: { mode: 'local' } }));
  const result = await runRaw(['browser', 'start', 'lane', '--stack=agent-qa-browser'], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no QA browser host.*controller-local browser fallback is disabled/);
});

test('QA browser keeps worker failure diagnostics on stderr without polluting readiness stdout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-browser-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  const executorPath = join(repoDir, 'apps', 'stack', 'bin', 'hstack-exec');
  await mkdir(join(repoDir, 'apps', 'stack', 'bin'), { recursive: true });
  // Native host observation is an external process boundary. Keep the browser
  // pool selection and worker command/error projection real beneath it.
  await writeFile(executorPath, '#!/bin/sh\nprintf \'HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true,"unreservedMemoryKiB":16777216}\\n\'\n');
  await chmod(executorPath, 0o755);
  await mkdir(join(root, 'agent-qa-browser'), { recursive: true });
  await writeFile(join(root, 'agent-qa-browser', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'linux', platform: 'posix', ssh: 'fixture-worker', repoDir: '/fixture/repo', cliHomeDir: '/fixture/home' }],
    runtimePlacement: { daemon: { mode: 'prefer-target', target: 'linux' } }, commandExecution: { mode: 'local' } }));
  await writeFile(join(root, 'agent-qa-browser', 'env'), 'HAPPIER_STACK_QA_DAEMON_TARGETS=linux\n');
  const { binDir } = writeFakeBin({ root, name: 'mutagen', content:
    '#!/bin/sh\nif [ "$1 $2" = "sync list" ]; then case "$*" in *json*) printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":1,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\' ;; *) printf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0\\n" ;; esac; fi\n' });
  // SSH is the external process boundary; retain the real command, executor,
  // source-sync barrier, readiness parser, and error projection beneath it.
  writeFakeBin({ root, name: 'ssh', content:
    '#!/bin/sh\ncase "$*" in *qa_browser.mjs*) echo "No usable sandbox!" >&2; echo "browser launch diagnostic"; exit 1;; esac\nexit 0\n' });
  const result = await runRaw(['browser', 'start', 'lane', '--stack=agent-qa-browser', '--url=http://localhost:19364'], root,
    { PATH: `${binDir}:${process.env.PATH}`, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_QA_DAEMON_TARGETS: 'launcher-pool' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No usable sandbox!/);
  assert.match(result.stderr, /browser launch diagnostic/);

  // An unavailable SSH host must fail closed even from the package cwd.
  writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\nexit 255\n' });
  writeFakeBin({ root, name: 'agent-browser', content:
    '#!/bin/sh\ncase "$*" in *about:blank*) echo "fixture Chromium launch refused" >&2; exit 1;; esac\nexit 0\n' });
  const local = await runRaw(['browser', 'start', 'lane', '--stack=agent-qa-browser', '--url=http://localhost:19364'], root,
    { PATH: `${binDir}:${process.env.PATH}`, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_QA_DAEMON_TARGETS: 'launcher-pool' }, join(import.meta.dirname, '..'));
  assert.equal(local.code, 1);
  assert.equal(local.stdout, '');
  assert.match(local.stderr, /QA browser host linux is unavailable/);
  assert.doesNotMatch(local.stderr, /MODULE_NOT_FOUND/);
});

test('QA setup validates its configured target before attempting installation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-setup-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runRaw(['qa', 'setup', 'absent', '--stack=agent-qa-setup'], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /target not found: absent/);
});

test('QA setup reports independently completed dependencies and OS prerequisites as one JSON result on partial failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackName = 'agent-qa-partial';
  await mkdir(join(root, stackName), { recursive: true });
  await writeFile(join(root, stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'linux', platform: 'posix', ssh: 'fixture-worker', repoDir: '/fixture/repo', cliHomeDir: '/fixture/home' }],
    runtimePlacement: { daemon: { mode: 'prefer-target', target: 'linux' } }, commandExecution: { mode: 'local' } }));
  const dependencies = { ok: false, jsRuntimeReady: true, agents: { claude: true, codex: false }, browserReady: true,
    workspaceDir: '/fixture/home/workspace', failures: [{ component: 'codex', error: 'archive rejected' }] };
  const disk = { admitted: true, commandClass: 'dependency-install', reclaimedBytes: 0,
    reclamation: [{ kind: 'scratch', retainedRoots: 1, reclaimedRoots: 0 }] };
  const { binDir } = writeFakeBin({ root, name: 'mutagen', content:
    '#!/bin/sh\nif [ "$1 $2" = "sync list" ]; then case "$*" in *json*) printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":1,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\' ;; *) printf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0\\n" ;; esac; elif [ "$1 $2" = "sync flush" ]; then echo "fixture synchronization flush progress"; echo "fixture synchronization flush diagnostic" >&2; fi\n' });
  writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\ncase "$*" in *remote_dependency_bootstrap.mjs*) echo "fixture dependency bootstrap progress"; exit 0;; *systemctl*) echo "sudo: OS authorization required" >&2; exit 1;; *worker_disk_budget.mjs*) echo "$QA_DISK_RESULT"; exit 0;; esac\necho "$QA_SETUP_RESULT"\nexit 1\n' });
  const result = await runRaw(['qa', 'setup', 'linux', `--stack=${stackName}`, '--json'], root,
    { PATH: `${binDir}:${process.env.PATH}`, QA_SETUP_RESULT: `HSTACK_QA_SETUP=${JSON.stringify(dependencies)}`,
      QA_DISK_RESULT: JSON.stringify(disk) });
  assert.equal(result.code, 1);
  assert.ok(result.stdout, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(result.stderr, /\[sync:linux\] fixture synchronization flush progress/);
  assert.match(result.stderr, /\[sync:linux\] fixture synchronization flush diagnostic/);
  assert.match(result.stderr, /fixture dependency bootstrap progress/);
  assert.equal(report.dependenciesReady, false);
  assert.deepEqual(report.dependencies, dependencies);
  assert.deepEqual(report.disk, disk);
  assert.equal(report.diskReady, true);
  assert.equal(report.powerReady, false);
  assert.match(report.power[0].detail, /OS authorization required/);
  const missingResult = await runRaw(['qa', 'setup', 'linux', `--stack=${stackName}`, '--json'], root,
    { PATH: `${binDir}:${process.env.PATH}`, QA_SETUP_RESULT: '', QA_DISK_RESULT: JSON.stringify(disk) });
  assert.equal(missingResult.code, 1);
  assert.ok(missingResult.stdout, missingResult.stderr);
  const missingReport = JSON.parse(missingResult.stdout);
  assert.equal(missingReport.dependenciesReady, false);
  assert.match(missingReport.dependencies.error, /without a result/);
  assert.deepEqual(missingReport.disk, disk);
  assert.equal(missingReport.powerReady, false);
});

test('dev-targets status exposes read-only admission holder progress and observation failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-admission-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'repo-test'), { recursive: true });
  await writeFile(join(root, 'repo-test', 'dev-targets.json'), JSON.stringify({ version: 1,
    targets: [{ name: 'linux', platform: 'posix', ssh: 'linux', repoDir: '/repo', cliHomeDir: '/state' }] }));
  const { binDir } = writeFakeBin({ root, name: 'mutagen', content: '#!/bin/sh\nprintf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":1,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'\n' });
  writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\ncase "$*" in *__HAPPIER_WORKER_POWER__*) printf \'__HAPPIER_WORKER_POWER__={"ok":true,"detail":"masked"}\\n\'; exit 0;; esac\n[ "${OBSERVATION_FAIL-}" != 1 ] || exit 255\nprintf \'{"state":"observed","sampledAtMs":9000,"owners":[{"pid":42,"token":"11","className":"validation","ageSeconds":14400,"cpuSeconds":3,"recentCpuPercent":0}]}\\n\'\n' });
  const env = { PATH: `${binDir}:${process.env.PATH}` };
  const status = await run(['status', 'linux', '--stack=repo-test'], root, env);
  assert.equal(status.admission?.state, 'observed');
  assert.equal(status.admission.owners[0].ageSeconds, 14400);
  assert.equal(status.admission.owners[0].recentCpuPercent, 0);
  const text = await runRaw(['status', 'linux', '--stack=repo-test'], root, env);
  assert.match(text.stdout, /validation owner pid 42.*14400s.*~0.0%/);
  const failed = await run(['status', 'linux', '--stack=repo-test'], root, { ...env, OBSERVATION_FAIL: '1' });
  assert.equal(failed.admission.state, 'unavailable');
  assert.equal(failed.status.state, 'ready', 'failed observation does not fabricate empty holders or alter sync health');
});

test('status and doctor report an idle no-watch first cycle as needs-flush without seeding it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-no-watch-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { name: 'linux', platform: 'posix', ssh: 'linux', repoDir: '/repo', cliHomeDir: '/state' };
  await mkdir(join(root, 'repo-test'), { recursive: true });
  await writeFile(join(root, 'repo-test', 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  const { binDir } = writeFakeBin({ root, name: 'mutagen', content: [
    '#!/bin/sh',
    'if [ "${STATE_UNSAFE-}" = 1 ]; then printf \'[{"name":"happier-linux","paused":true,"status":"watching"}]\\n\'; exit 0; fi',
    'case "$2" in',
    '  list) printf \'[{"name":"happier-linux","paused":false,"status":"watching","alpha":{"connected":true,"scanned":false,"watch":{"mode":"no-watch"}},"beta":{"connected":true,"scanned":false,"watch":{"mode":"no-watch"}}}]\\n\' ;;',
    '  flush) echo unexpected-flush >&2; exit 9 ;;',
    'esac',
  ].join('\n') });
  writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\ncase "$*" in *__HAPPIER_WORKER_POWER__*) printf \'__HAPPIER_WORKER_POWER__={"ok":true,"detail":"masked"}\\n\';; esac\nexit 0\n' });
  const env = { PATH: `${binDir}:${process.env.PATH}` };
  assert.equal((await run(['status', 'linux', '--stack=repo-test'], root, env)).status.state, 'needs-flush');
  const doctor = await run(['doctor', 'linux', '--stack=repo-test'], root, env);
  assert.equal(doctor.targets[0].synchronization.state, 'needs-flush');
  assert.equal(doctor.targets[0].ok, true);
  const paused = await runRaw(['doctor', 'linux', '--stack=repo-test', '--json'], root, { ...env, STATE_UNSAFE: '1' });
  assert.equal(paused.code, 1);
  const rejected = JSON.parse(paused.stdout);
  assert.equal(rejected.targets[0].synchronization.state, 'paused');
  assert.equal(rejected.targets[0].ok, false);
});

test('QA placement setter keeps build placement independent and supports auto, ordered, and local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-placement-'));
  try {
    for (const name of ['builder', 'qa1', 'qa2']) await run(['add', name, '--stack=qa-settings', '--platform=posix', `--ssh=${name}`, `--repo-dir=/repo/${name}`, `--cli-home-dir=/state/${name}`], root);
    await run(['placement', 'set', 'build', 'ordered', '--targets=builder', '--stack=qa-settings'], root);
    await run(['placement', 'set', 'qa', 'auto', '--targets=qa2,qa1', '--fallback=local', '--stack=qa-settings'], root);
    const automatic = JSON.parse(await readFile(join(root, 'qa-settings', 'dev-targets.json'), 'utf8'));
    assert.deepEqual(automatic.runtimePlacement.build.targets, ['builder']);
    assert.deepEqual(automatic.runtimePlacement.qa.targets, ['qa2', 'qa1']);
    assert.equal(automatic.runtimePlacement.qa.mode, 'auto');
    await run(['placement', 'set', 'qa', 'ordered', '--targets=qa1,qa2', '--stack=qa-settings'], root);
    const ordered = JSON.parse(await readFile(join(root, 'qa-settings', 'dev-targets.json'), 'utf8'));
    assert.deepEqual(ordered.runtimePlacement.qa.targets, ['qa1', 'qa2']);
    await run(['placement', 'set', 'qa', 'local', '--stack=qa-settings'], root);
    const local = JSON.parse(await readFile(join(root, 'qa-settings', 'dev-targets.json'), 'utf8'));
    assert.deepEqual(local.runtimePlacement.qa, { mode: 'local' });
    assert.deepEqual(local.runtimePlacement.build.targets, ['builder']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command placement preserves target preparation completed during the power preflight', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-placement-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run(['add', 'worker', '--stack=prepare-test', '--platform=posix', '--ssh=worker', '--repo-dir=/root/repo', '--cli-home-dir=/root/cli'], root);
  const path = join(root, 'prepare-test/dev-targets.json');
  const { binDir } = writeFakeBin({ root, name: 'ssh', content: `#!/usr/bin/env node
const fs=require('node:fs'); const path=process.env.PREPARATION_CONFIG;
const config=JSON.parse(fs.readFileSync(path)); config.targets[0].repoDir='/home/worker/repo'; config.targets[0].cliHomeDir='/home/worker/cli';
fs.writeFileSync(path,JSON.stringify(config)); process.stdout.write('__HAPPIER_WORKER_POWER__={"ok":true}\\n');
` });
  await run(['placement', 'set', 'commands', 'auto', '--targets=worker', '--stack=prepare-test'], root,
    { PATH: `${binDir}:${process.env.PATH}`, PREPARATION_CONFIG: path });
  const current = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(current.targets[0].repoDir, '/home/worker/repo');
  assert.equal(current.targets[0].cliHomeDir, '/home/worker/cli');
  assert.deepEqual(current.commandExecution.targets, ['worker']);
});

test('explicit server handoff leaves an already remote stack on its authoritative target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-retained-move-'));
  try {
    await run(['add', 'linux', '--stack=qa-retained', '--platform=posix', '--ssh=linux', '--repo-dir=/repo', '--cli-home-dir=/home/worker'], root);
    await run(['placement', 'set', 'server', 'linux', '--stack=qa-retained'], root);
    const before = await readFile(join(root, 'qa-retained', 'dev-targets.json'));
    const result = await run(['move-server', 'linux', '--stack=qa-retained'], root);
    assert.equal(result.moved, false);
    assert.equal(result.reason, 'already_remote');
    assert.deepEqual(await readFile(join(root, 'qa-retained', 'dev-targets.json')), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function run(args, storageDir, extraEnv = {}) {
  const result = await execFileAsync(process.execPath, [script, ...args, '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      ...extraEnv,
    },
  });
  return JSON.parse(result.stdout.trim());
}

async function runRaw(args, storageDir, extraEnv = {}, cwd = process.cwd()) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd,
      env: {
        ...process.env,
        HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number(error?.code),
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

test('dev-targets command adds, shows, diagnoses, lists, and removes stack-scoped targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-cmd-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    for (const executable of ['mutagen', 'ssh']) {
      const path = join(binDir, executable);
      await writeFile(path, executable === 'mutagen'
        ? '#!/bin/sh\nif [ "$1 $2" = "sync list" ]; then printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":1,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'; fi\nexit 0\n'
        : '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o700);
    }

    const added = await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--ssh-config-file=/tmp/lima-happier-stack-linux.conf',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
      ],
      root,
    );
    assert.equal(added.target.name, 'linux');
    assert.equal(added.target.sshConfigFile, '/tmp/lima-happier-stack-linux.conf');
    assert.equal(added.target.managedRuntime, undefined);

    const shown = await run(['show', 'linux', '--stack=repo-test'], root);
    assert.equal(shown.target.repoDir, '/home/dev/happier');

    const diagnosed = await run(['doctor', 'linux', '--stack=repo-test'], root, {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    assert.equal(diagnosed.ok, true);
    assert.equal(diagnosed.mutagen.ok, true);
    assert.deepEqual(
      diagnosed.targets.map((target) => ({ name: target.name, ok: target.ok })),
      [{ name: 'linux', ok: true }],
    );

    const listed = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(listed.targets.map((target) => target.name), ['linux']);

    const removed = await run(['remove', 'linux', '--stack=repo-test'], root);
    assert.equal(removed.removed, true);
    const empty = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(empty.targets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets placement upgrades v1 safely, preserves policy while editing targets, and can downgrade explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-placement-'));
  try {
    await run([
      'add',
      'mac',
      '--stack=repo-test',
      '--platform=posix',
      '--ssh=mac',
      '--repo-dir=/repo',
      '--cli-home-dir=/home',
    ], root);

    const placed = await run(
      ['placement', 'set', 'expo', 'mac', '--stack=repo-test'],
      root,
    );
    assert.equal(placed.config.version, 3);
    assert.deepEqual(placed.config.runtimePlacement.expo, {
      mode: 'prefer-target',
      target: 'mac',
      fallback: 'local',
    });
    assert.deepEqual(placed.config.runtimePlacement.server, { mode: 'local' });

    const serverPlaced = await run(
      ['placement', 'set', 'server', 'mac', '--stack=repo-test'],
      root,
    );
    assert.deepEqual(serverPlaced.config.runtimePlacement.server, {
      mode: 'prefer-target',
      target: 'mac',
      fallback: 'error',
    });
    await run(['placement', 'set', 'server', 'local', '--stack=repo-test'], root);

    const commands = await run(
      ['placement', 'set', 'commands', 'mac', '--stack=repo-test'],
      root,
    );
    assert.equal(commands.config.commandExecution.target, 'mac');
    assert.equal(commands.config.runtimePlacement.expo.target, 'mac');

    const automatic = await run(
      [
        'placement', 'set', 'commands', 'auto', '--stack=repo-test',
        '--include-local', '--fallback=error', '--load-probe-ttl-ms=20000',
        '--unavailable-probe-ttl-ms=180000',
      ],
      root,
    );
    assert.deepEqual(automatic.config.commandExecution, {
      mode: 'auto',
      targets: ['mac'],
      includeLocal: true,
      fallback: 'error',
      loadProbeTtlMs: 20000,
      unavailableProbeTtlMs: 180000,
    });

    await run([
      'add',
      'linux',
      '--stack=repo-test',
      '--platform=posix',
      '--ssh=linux',
      '--repo-dir=/repo-linux',
      '--cli-home-dir=/home-linux',
    ], root);
    const shown = await run(['placement', 'show', '--stack=repo-test'], root);
    assert.equal(shown.config.version, 3, 'adding a target must not downgrade placement config');
    assert.equal(shown.config.runtimePlacement.expo.target, 'mac');
    assert.equal(shown.config.targets.length, 2);
    assert.deepEqual(
      shown.config.commandExecution.targets,
      ['mac', 'linux'],
      'an automatic all-target pool should follow configured target additions',
    );

    const localAndTargetDaemons = await run(
      [
        'placement', 'set', 'daemon', 'local-and-targets', '--stack=repo-test',
        '--targets=mac,linux',
      ],
      root,
    );
    assert.deepEqual(localAndTargetDaemons.config.runtimePlacement.daemon, {
      mode: 'local-and-targets',
      targets: ['mac', 'linux'],
    });

    const orderedBuild = await run([
      'placement', 'set', 'build', 'ordered', '--stack=repo-test',
      '--targets=linux,mac', '--fallback=local',
    ], root);
    assert.deepEqual(orderedBuild.config.runtimePlacement.build, {
      mode: 'prefer-target', targets: ['linux', 'mac'], fallback: 'local',
    });
    assert.deepEqual(orderedBuild.config.runtimePlacement.expo, shown.config.runtimePlacement.expo);
    await run(['placement', 'set', 'build', 'local', '--stack=repo-test'], root);

    const blockedRemoval = await runRaw(['remove', 'mac', '--stack=repo-test'], root);
    assert.equal(blockedRemoval.code, 1);
    assert.match(blockedRemoval.stderr, /referenced by placement/i);

    const localExpo = await run(
      ['placement', 'set', 'expo', 'local', '--stack=repo-test'],
      root,
    );
    assert.deepEqual(localExpo.config.runtimePlacement.expo, { mode: 'local' });
    await run(['placement', 'set', 'daemon', 'local', '--stack=repo-test'], root);
    const removed = await run(['remove', 'mac', '--stack=repo-test'], root);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.config.commandExecution.targets, ['linux']);

    const downgraded = await run(
      ['placement', 'clear', '--downgrade-v1', '--stack=repo-test'],
      root,
    );
    assert.equal(downgraded.config.version, 1);
    assert.equal(downgraded.config.targets.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets status, sync, and exec share the moving mirror with a pre-launch flush and no command queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-exec-'));
  // Transport behavior needs an admitted fake worker, independent of current compiler envelopes.
  const compilerMemory = resolveHeavyweightMemoryFloorKiB('compilation');
  try {
    const binDir = join(root, 'bin');
    const logPath = join(root, 'commands.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'mutagen'),
      [
        '#!/bin/sh',
        'printf "mutagen|%s|%s\\n" "$MUTAGEN_DATA_DIRECTORY" "$*" >> "$DEV_TARGET_COMMAND_LOG"',
        'if [ "$1 $2" = "sync flush" ] && [ -n "${DEV_TARGET_FLUSH_WAIT-}" ]; then : > "$DEV_TARGET_FLUSH_WAIT"; trap \'exit 0\' TERM; while [ ! -f "$DEV_TARGET_FLUSH_WAIT.release" ]; do sleep 0.02; done; fi',
        'if [ "$1 $2" = "sync list" ]; then',
        '  case "$*" in *json*) printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":4,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\' ;; *) printf "happier-linux|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|4|ok|0|0\\n" ;; esac',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(binDir, 'ssh'),
      [
        '#!/bin/sh',
        'printf "ssh|%s\\n" "$*" >> "$DEV_TARGET_COMMAND_LOG"',
        'case "$*" in',
        '  *__HAPPIER_WORKER_POWER__*) printf \'__HAPPIER_WORKER_POWER__={"ok":true,"detail":"masked"}\\n\'; exit 0 ;;',
        `  *getconf*) printf "8 1 0.066667 ${compilerMemory} 20 0 ${compilerMemory} ${compilerMemory} 0 0 0 0 0 0 0 darwin\\n"; exit 0 ;;`,
        '  *command\\ -v*|*-MNf*|*-O\\ exit*) exit 0 ;;',
        'esac',
        'exit "${DEV_TARGET_SSH_EXIT:-0}"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'mutagen'), 0o700);
    await chmod(join(binDir, 'ssh'), 0o700);

    await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
      ],
      root,
    );
    const commandEnv = {
      PATH: `${binDir}:${process.env.PATH}`,
      // This fixture starts a fresh caller, even when its test runner is remote.
      HAPPIER_DEV_TARGET_EXECUTION: '',
      DEV_TARGET_COMMAND_LOG: logPath,
    };

    const status = await run(['status', 'linux', '--stack=repo-test'], root, commandEnv);
    assert.equal(status.status.state, 'ready');
    assert.equal(status.status.sessionName, 'happier-linux');

    const synced = await run(['sync', 'linux', '--stack=repo-test'], root, commandEnv);
    assert.equal(synced.sync.flushed, true);

    await writeFile(logPath, '');
    const executed = await runRaw(
      [
        'exec',
        'linux',
        '--stack=repo-test',
        '--cwd=apps/cli',
        '--env=CI=1',
        '--',
        'rg',
        '--json',
        'needle',
      ],
      root,
      commandEnv,
    );
    assert.equal(executed.code, 0);
    const executionLog = await readFile(logPath, 'utf8');
    assert.match(executionLog, /mutagen\|.*\/mutagen\/data\|sync list happier-linux/);
    assert.match(executionLog, /sync flush happier-linux/);
    assert.equal(executionLog.match(/sync flush happier-linux/g)?.length, 1);
    assert.ok(executionLog.indexOf('sync flush happier-linux') < executionLog.lastIndexOf('ssh|'));
    assert.match(executionLog, /ssh\|.*happier-stack-linux.*apps\/cli.*CI.*rg.*--json.*needle/);
    assert.match(executionLog, /nice -n 10.*rg/);
    assert.doesNotMatch(executionLog, /remote_dependency_bootstrap\.mjs/);

    await writeFile(logPath, '');
    const typechecked = await runRaw(
      [
        'exec',
        'linux',
        '--stack=repo-test',
        '--cwd=packages/scm-forge-adapter',
        '--',
        'corepack',
        'yarn',
        '-s',
        'typecheck',
      ],
      root,
      commandEnv,
    );
    assert.equal(typechecked.code, 0, typechecked.stderr);
    const typecheckLog = await readFile(logPath, 'utf8');
    const bootstrapIndex = typecheckLog.indexOf('remote_dependency_bootstrap.mjs');
    const typecheckIndex = typecheckLog.lastIndexOf('typecheck');
    assert.ok(bootstrapIndex >= 0, typecheckLog);
    assert.ok(typecheckIndex > bootstrapIndex, typecheckLog);
    assert.match(typecheckLog, /ssh\|.*\/home\/dev\/happier.*remote_dependency_bootstrap\.mjs/);
    assert.match(typecheckLog, /ssh\|.*packages\/scm-forge-adapter.*corepack.*yarn.*typecheck/);

    await writeFile(logPath, '');
    const yarnStyleExecution = await runRaw(
      ['exec', 'linux', '--stack=repo-test', 'rg', '--json', 'needle'],
      root,
      commandEnv,
    );
    assert.equal(yarnStyleExecution.code, 0, 'the repo-local Yarn 1 shortcut may consume the -- separator');
    assert.match(await readFile(logPath, 'utf8'), /ssh\|.*rg.*--json.*needle/);

    await writeFile(logPath, '');
    const shell = await runRaw(['ssh', 'linux', '--stack=repo-test'], root, commandEnv);
    assert.equal(shell.code, 0, shell.stderr);
    const shellLog = await readFile(logPath, 'utf8');
    assert.match(shellLog, /sync flush happier-linux/);
    assert.match(shellLog, /ssh\|.*-tt.*happier-stack-linux.*bash.*-l/);
    assert.equal(shellLog.match(/sync flush happier-linux/g)?.length, 1);

    const invalidEnvironment = await runRaw(
      ['exec', 'linux', '--stack=repo-test', '--env', 'BROKEN', '--', 'pwd'],
      root,
      commandEnv,
    );
    assert.equal(invalidEnvironment.code, 1);
    assert.match(invalidEnvironment.stderr, /--env requires KEY=VALUE/);

    await writeFile(logPath, '');
    const primaryOnly = await runRaw(
      ['exec', 'linux', '--stack=repo-test', '--', 'git', 'status'],
      root,
      commandEnv,
    );
    assert.equal(primaryOnly.code, 1, 'explicit target execution must not move Git to the mirror');
    assert.equal(await readFile(logPath, 'utf8'), '', 'reject Git before synchronization or transport');

    const failed = await runRaw(
      ['exec', 'linux', '--stack=repo-test', '--', 'false'],
      root,
      { ...commandEnv, DEV_TARGET_SSH_EXIT: '7' },
    );
    assert.equal(failed.code, 7, 'remote command exit status must be preserved');

    const flushWait = join(root, 'flush-wait');
    const cancelling = spawn(process.execPath, [script, 'exec', 'linux', '--stack=repo-test', '--', 'rg', 'cancel-probe'], {
      env: {
        ...process.env,
        ...commandEnv,
        HAPPIER_STACK_HOME_DIR: join(root, 'home'),
        HAPPIER_STACK_STORAGE_DIR: root,
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
        DEV_TARGET_FLUSH_WAIT: flushWait,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cancelling.stdout.resume();
    cancelling.stderr.resume();
    const cancellationResult = new Promise((resolveExit) => cancelling.once('exit', (code, signal) => resolveExit({ code, signal })));
    const cancellationClosed = new Promise((resolveClose) => cancelling.once('close', resolveClose));
    try {
      let reachedFlush = false;
      for (let attempt = 0; attempt < 750; attempt += 1) {
        try { await readFile(flushWait); reachedFlush = true; break; } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      assert.equal(reachedFlush, true, 'the real named CLI must reach its pre-launch barrier');
      cancelling.kill('SIGTERM');
      assert.deepEqual(await cancellationResult, { code: 130, signal: null });
    } finally {
      await writeFile(`${flushWait}.release`, 'release');
      if (cancelling.exitCode == null && cancelling.signalCode == null) cancelling.kill('SIGTERM');
      await cancellationResult;
      await cancellationClosed;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets status reports managed Lima lifecycle health alongside mirror readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-managed-status-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'mutagen'),
      [
        '#!/bin/sh',
        'if [ "$1 $2" = "sync list" ]; then',
        '  printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":4,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    await writeFile(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\nprintf \'__HAPPIER_WORKER_POWER__={"ok":true,"detail":"masked"}\\n\'\n' });
    await writeFile(
      join(binDir, 'limactl'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  printf "limactl version 2.0.0\\n"',
        '  exit 0',
        'fi',
        'printf \'[{"name":"happier-worker-linux","status":"Running","vmType":"vz","arch":"aarch64","cpus":8,"memory":25769803776,"disk":171798691840,"config":{"mounts":[],"containerd":{"user":false,"system":false},"ssh":{"forwardAgent":false},"vmOpts":{"vz":{"diskImageFormat":"raw","rosetta":{"enabled":false,"binfmt":false}}},"portForwards":[{"guestIP":"0.0.0.0","guestIPMustBeZero":false,"proto":"any","ignore":true}]}}]\\n\'',
        '',
      ].join('\n'),
    );
    await Promise.all(['mutagen', 'uname', 'limactl'].map((name) => chmod(join(binDir, name), 0o700)));

    await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
        '--lima-instance=happier-worker-linux',
        [`--lima-home=${join(root, 'lima')}`],
        '--lima-profile=worker-balanced',
      ],
      root,
    );
    const status = await run(['status', 'linux', '--stack=repo-test'], root, {
      PATH: `${binDir}:${process.env.PATH}`,
    });

    assert.equal(status.status.state, 'ready');
    assert.equal(status.managedRuntime.ok, true);
    assert.equal(status.managedRuntime.status, 'Running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets capacity stores per-target presets locally without restarting when selected resources already match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-capacity-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await writeFile(join(binDir, 'limactl'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "limactl version 2.0.0\\n"; exit 0; fi',
      'printf \'[{"name":"worker","status":"Stopped","vmType":"vz","arch":"aarch64","cpus":8,"memory":25769803776,"disk":171798691840,"config":{"mounts":[],"containerd":{"user":false,"system":false},"ssh":{"forwardAgent":false},"vmOpts":{"vz":{"diskImageFormat":"raw","rosetta":{"enabled":false,"binfmt":false}}},"portForwards":[{"guestIP":"0.0.0.0","guestIPMustBeZero":false,"proto":"any","ignore":true}]}}]\\n\'',
      '',
    ].join('\n'));
    await Promise.all(['uname', 'limactl'].map((name) => chmod(join(binDir, name), 0o700)));
    await run([
      'add', 'linux', '--stack=repo-test', '--platform=posix', '--ssh=linux',
      '--repo-dir=/repo', '--cli-home-dir=/home', '--lima-instance=worker',
      `--lima-home=${join(root, 'lima')}`, '--lima-profile=worker-balanced',
    ], root);

    const changed = await run([
      'capacity', 'set', 'linux', 'shared', '--stack=repo-test',
      '--shared-cpus=8', '--shared-memory-gib=24',
      '--dedicated-cpus=12', '--dedicated-memory-gib=32',
    ], root, { PATH: `${binDir}:${process.env.PATH}` });

    assert.equal(changed.target.managedRuntime.capacity.mode, 'shared');
    assert.deepEqual(changed.target.managedRuntime.capacity.dedicated, {
      cpus: 12,
      memoryGiB: 32,
    });
    const shown = await run(['capacity', 'show', 'linux', '--stack=repo-test'], root);
    assert.deepEqual(shown.capacity, changed.target.managedRuntime.capacity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets capacity rejects incomplete initial presets before changing config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-capacity-invalid-'));
  try {
    await run([
      'add', 'linux', '--stack=repo-test', '--platform=posix', '--ssh=linux',
      '--repo-dir=/repo', '--cli-home-dir=/home', '--lima-instance=worker',
      `--lima-home=${join(root, 'lima')}`, '--lima-profile=worker-balanced',
    ], root);
    const result = await runRaw([
      'capacity', 'set', 'linux', 'dedicated', '--stack=repo-test',
      '--dedicated-cpus=12', '--dedicated-memory-gib=32',
    ], root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /shared-cpus.*shared-memory-gib/i);
    const shown = await run(['show', 'linux', '--stack=repo-test'], root);
    assert.equal(shown.target.managedRuntime.capacity, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets sync-service detached owns continuous synchronization independently of Stack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-sync-service-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const mutagen = join(binDir, 'mutagen');
    await writeFile(mutagen, [
      '#!/bin/sh',
      'if [ "$1 $2" = "sync list" ]; then',
      '  printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":2,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(mutagen, 0o700);
    const ssh = join(binDir, 'ssh');
    await writeFile(ssh, '#!/bin/sh\nexit 0\n');
    await chmod(ssh, 0o700);
    await run([
      'add',
      'linux',
      '--stack=repo-test',
      '--platform=windows',
      '--ssh=linux',
      '--repo-dir=C:/repo',
      '--cli-home-dir=C:/home',
    ], root);
    const commandEnv = { PATH: `${binDir}:${process.env.PATH}` };

    const started = await run(
      ['sync-service', 'start', '--detached', '--stack=repo-test'],
      root,
      commandEnv,
    );
    assert.equal(started.detached, true);
    assert.equal(started.statuses[0].status.state, 'ready');

    const status = await run(['sync-service', 'status', '--stack=repo-test'], root, commandEnv);
    assert.equal(status.independent, true);
    assert.equal(status.preparation.state, 'ready');
    assert.equal(status.preparation.targets.linux.state, 'ready');
    assert.equal(status.statuses[0].status.state, 'ready');

    const preparationFile = resolveDevTargetMutagenRuntime({
      stackBaseDir: join(root, 'repo-test'), env: { HAPPIER_STACK_STORAGE_DIR: root },
    }).syncServiceStateFile;
    await writeFile(preparationFile, JSON.stringify({
      version: 1, state: 'failed',
      targets: { linux: { state: 'failed', error: 'transient beta transition' } },
    }));
    const recovered = await run(['sync-service', 'status', '--stack=repo-test'], root, commandEnv);
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.preparation.state, 'failed', 'startup failure remains historical information');

    const renderedStatus = await runRaw(
      ['sync-service', 'status', '--stack=repo-test'],
      root,
      commandEnv,
    );
    assert.equal(renderedStatus.code, 0, renderedStatus.stderr);
    assert.match(renderedStatus.stdout, /synchronization readiness\tready/);
    assert.match(renderedStatus.stdout, /startup preparation history\tfailed/);
    assert.doesNotMatch(renderedStatus.stdout, /dependenc(?:y|ies)/i);

    const stopped = await run(['sync-service', 'stop', '--stack=repo-test'], root, commandEnv);
    assert.equal(stopped.released, true);
    const afterStop = await runRaw(['sync-service', 'status', '--stack=repo-test'], root, commandEnv);
    assert.equal(afterStop.code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets exec auto takes the fast local fallback when no target is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-auto-local-'));
  try {
    const result = await runRaw([
      'exec', 'auto', '--stack=repo-test', '--',
      process.execPath, '-e', 'process.stdout.write("auto-local")',
    ], root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'auto-local');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets add provisions a dedicated POSIX SSH connection and discovers remote defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-provision-'));
  try {
    const binDir = join(root, 'bin');
    const authorizedPath = join(root, 'authorized');
    const powerPath = join(root, 'power-mutated');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'ssh-keygen'),
      [
        '#!/bin/sh',
        'key_path=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-f" ]; then shift; key_path=$1; fi',
        '  shift',
        'done',
        'printf private > "$key_path"',
        'printf "ssh-ed25519 AAAATEST happier-dev-target\\n" > "$key_path.pub"',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(binDir, 'ssh-copy-id'),
      '#!/bin/sh\nprintf "installing dedicated key\\n"\ntouch "$DEV_TARGET_AUTHORIZED_PATH"\n',
    );
    await writeFile(
      join(binDir, 'ssh'),
      [
        '#!/bin/sh',
        'last=',
        'for value in "$@"; do last=$value; done',
        'case "$last" in *systemctl*|*__HAPPIER_WORKER_POWER__*) touch "$TEST_POWER_PATH"; exit 0;; esac',
        'if [ "$last" = "true" ]; then',
        '  [ -f "$DEV_TARGET_AUTHORIZED_PATH" ] && exit 0',
        '  exit 255',
        'fi',
        'if [ -n "${TEST_CONFIG_PATH:-}" ]; then',
        '  "$TEST_NODE_EXEC" -e \'const fs=require("node:fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p));const t=c.targets.find(t=>t.name==="concurrent");t.repoDir="/home/concurrent/repo";t.cliHomeDir="/home/concurrent/cli";fs.writeFileSync(p,JSON.stringify(c));\' "$TEST_CONFIG_PATH"',
        'fi',
        'printf "%s\\n" "__HAPPIER_UNAME__=Darwin"',
        'printf "%s\\n" "__HAPPIER_HOME__=/Users/leeroy"',
        'printf "%s\\n" "__HAPPIER_PATH__=/Users/leeroy/.nvm/node/bin:/opt/homebrew/bin:/usr/bin:/bin"',
        'if [ "${TEST_FRESH_HOST:-0}" != 1 ]; then',
        'printf "%s\\n" "__HAPPIER_NODE__=/Users/leeroy/.nvm/node/bin/node"',
        'printf "%s\\n" "__HAPPIER_COREPACK__=/Users/leeroy/.nvm/node/bin/corepack"',
        'fi',
        '',
      ].join('\n'),
    );
    for (const executable of ['ssh-keygen', 'ssh-copy-id', 'ssh']) {
      await chmod(join(binDir, executable), 0o700);
    }

    await run(['add', 'concurrent', '--stack=repo-test', '--platform=posix', '--ssh=concurrent',
      '--repo-dir=/root/repo', '--cli-home-dir=/root/cli'], root);
    const added = await run(
      [
        'add',
        'mac',
        '--stack=repo-test',
        '--host=100.98.30.76',
        '--user=leeroy',
      ],
      root,
      {
        PATH: `${binDir}:${process.env.PATH}`,
        DEV_TARGET_AUTHORIZED_PATH: authorizedPath,
        TEST_POWER_PATH: powerPath,
        TEST_CONFIG_PATH: join(root, 'repo-test/dev-targets.json'),
        TEST_NODE_EXEC: process.execPath,
      },
    );

    assert.equal(added.target.name, 'mac');
    assert.equal(added.target.platform, 'posix');
    assert.equal(added.target.ssh, 'happier-dev-target-mac');
    assert.equal(added.target.repoDir, '/Users/leeroy/happier-dev');
    assert.equal(added.target.cliHomeDir, '/Users/leeroy/.happier/dev-targets/mac');
    assert.deepEqual(added.target.remotePath.slice(0, 2), [
      '/Users/leeroy/.nvm/node/bin',
      '/opt/homebrew/bin',
    ]);
    assert.equal(await readFile(authorizedPath, 'utf8').catch(() => null), '');
    assert.equal(await readFile(powerPath, 'utf8').catch(() => null), null, 'ordinary enrollment must not configure host services');
    const concurrent = JSON.parse(await readFile(join(root, 'repo-test/dev-targets.json'), 'utf8')).targets.find(target => target.name === 'concurrent');
    assert.equal(concurrent.repoDir, '/home/concurrent/repo', 'enrollment must preserve another target prepared during SSH discovery');
    assert.equal(concurrent.cliHomeDir, '/home/concurrent/cli');
    const fresh = await runRaw(['add', 'fresh', '--stack=repo-test', '--host=100.98.30.77', '--user=leeroy', '--json'], root,
      { PATH: `${binDir}:${process.env.PATH}`, DEV_TARGET_AUTHORIZED_PATH: authorizedPath, TEST_POWER_PATH: powerPath, TEST_FRESH_HOST: '1' });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).target.name, 'fresh');
    assert.match(fresh.stderr, /host prepare fresh --toolchain --stack=repo-test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host preparation rejects missing account/home values without invoking SSH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-host-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run(['add', 'worker', '--stack=prepare-test', '--platform=posix', '--ssh=worker', '--repo-dir=/repo', '--cli-home-dir=/cli'], root);
  const { binDir } = writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\necho unexpected-ssh >&2\nexit 90\n' });
  for (const flag of ['--create-user', '--home']) {
    const result = await runRaw(['host', 'prepare', 'worker', flag, '--inotify', '--stack=prepare-test'], root, { PATH: `${binDir}:${process.env.PATH}` });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires.*value/);
    assert.doesNotMatch(result.stderr, /unexpected-ssh/);
  }
});

test('host preparation is opt-in, uses the selected worker TTY, and preserves root layout on repeat', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-host-prepare.+-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'ssh.log');
  const growth = join(root, 'growth.log');
  const extents = join(root, 'extents');
  await writeFile(extents, '  95744  \n');
  const { binDir } = writeFakeBin({ root, name: 'ssh', content: `#!/usr/bin/env node
const {appendFileSync}=require('node:fs'); const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2); appendFileSync(process.env.TEST_SSH_LOG, JSON.stringify(args)+'\\n');
if (args.at(-1) === 'true') process.exit(0);
const result=spawnSync('/bin/bash',['-c',args.at(-1)],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);
` });
  const commands = {
    uname: 'printf "%s\\n" "${TEST_OS:-Linux}"',
    id: 'case "$1" in -un) echo happier;; -u) echo "${TEST_ROOT:-1000}";; esac',
    sudo: 'printf "invocation\\n" >> "$TEST_SUDO_LOG"; [ "${TEST_DENY_SUDO:-0}" = 0 ] || exit 23; export TEST_ROOT=0; export PATH="${TEST_PRIVILEGED_BIN:+$TEST_PRIVILEGED_BIN:}$PATH"; exec "$@"',
    findmnt: 'echo "${TEST_ROOT_LV:-/dev/mapper/worker--vg-root}"',
    lvs: 'printf "lvs:%s\\n" "${TEST_ROOT:-1000}" >> "$TEST_LVM_LOG"; [ "${TEST_ROOT:-1000}" = 0 ] || exit 5; [ "${@: -1}" = /dev/mapper/worker--vg-root ] || exit 5; echo "  worker-vg  "',
    vgs: 'printf "vgs:%s\\n" "${TEST_ROOT:-1000}" >> "$TEST_LVM_LOG"; [ "${TEST_ROOT:-1000}" = 0 ] || exit 5; cat "$TEST_EXTENTS"',
    lvextend: 'printf "%s\\n" "$*" >> "$TEST_GROWTH_LOG"; [ "${TEST_FAIL_GROWTH:-0}" = 0 ] || exit 23; echo 0 > "$TEST_EXTENTS"',
    systemctl: 'case "$1" in is-enabled) cat "$TEST_POWER_STATE" 2>/dev/null || echo enabled;; mask) printf "%s\\n" "$*" >> "$TEST_POWER_LOG"; echo masked > "$TEST_POWER_STATE";; esac',
    visudo: '[ "$1" = -cf ] || exit 9; [ "${TEST_INVALID_POLICY:-0}" = 0 ] || exit 10; if [ -x /usr/sbin/visudo ]; then /usr/sbin/visudo "$@"; fi',
    install: '[ "$*" = "-m 0440 ${@: -2:1} /etc/sudoers.d/happier-worker" ] || exit 9; cp "${@: -2:1}" "$TEST_SUDOERS"',
    corepack: 'exit 0',
    'apt-get': 'exit 0',
  };
  for (const [name, body] of Object.entries(commands)) writeFakeBin({ root, name, content: '#!/usr/bin/env bash\nset -eu\n' + body + '\n' });
  const env = { PATH: `${binDir}:${process.env.PATH}`, TEST_SSH_LOG: log, TEST_SUDO_LOG: join(root, 'sudo.log'),
    TEST_EXTENTS: extents, TEST_LVM_LOG: join(root, 'lvm.log'), TEST_GROWTH_LOG: growth, TEST_POWER_LOG: join(root, 'power.log'), TEST_POWER_STATE: join(root, 'power.state'), TEST_SUDOERS: join(root, 'sudoers') };
  for (const name of ['worker', 'manual']) await run(['add', name, '--stack=prepare-test', '--platform=posix', '--ssh=' + name,
    '--repo-dir=/home/dev/repo', '--cli-home-dir=/home/dev/cli'], root, env);
  const unspecified = await runRaw(['host', 'prepare', 'worker', '--stack=prepare-test'], root, env);
  assert.equal(unspecified.code, 1);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  const prepare = extra => runRaw(['host', 'prepare', 'worker', '--grow-root', '--no-sleep', '--stack=prepare-test'], root, { ...env, ...extra });
  const first = await prepare();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await readFile(growth, 'utf8'), '-r -l +100%FREE /dev/mapper/worker--vg-root\n');
  assert.match(await readFile(env.TEST_POWER_LOG, 'utf8'), /^mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target$/m);
  const connections = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(connections.every(args => args.includes('worker') && !args.includes('manual') && args.includes('-tt')));
  assert.equal((await readFile(env.TEST_SUDO_LOG, 'utf8')).trim().split('\n').length, 1, 'one authenticated root invocation per host');
  assert.deepEqual((await readFile(env.TEST_LVM_LOG, 'utf8')).trim().split('\n'), ['lvs:0', 'vgs:0'],
    'LVM inspection and growth must share the authenticated invocation without unprivileged inspection');
  const beforeRepeat = await readFile(env.TEST_SUDO_LOG, 'utf8');
  const repeated = await prepare();
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(await readFile(env.TEST_SUDO_LOG, 'utf8'), beforeRepeat + 'invocation\n',
    'explicit root growth inspects zero VG extents in one authenticated invocation');
  assert.equal(await readFile(growth, 'utf8'), '-r -l +100%FREE /dev/mapper/worker--vg-root\n');
  await writeFile(extents, '64\n');
  assert.equal((await prepare({ TEST_ROOT_LV: '/dev/nvme0n1p2' })).code, 0);
  assert.equal(await readFile(growth, 'utf8'), '-r -l +100%FREE /dev/mapper/worker--vg-root\n');
  const denied = await prepare({ TEST_FAIL_GROWTH: '1' });
  assert.equal(denied.code, 1);
  const sudoersArgs = ['host', 'prepare', 'worker', '--passwordless-sudo', '--stack=prepare-test'];
  const policy = await runRaw(sudoersArgs, root, env);
  assert.equal(policy.code, 0, policy.stderr);
  const narrowPolicy = await readFile(env.TEST_SUDOERS, 'utf8');
  assert.match(narrowPolicy, /happier ALL=\(root\) NOPASSWD:/);
  assert.match(narrowPolicy, /systemctl mask sleep.target/);
  assert.match(narrowPolicy, /lvextend -r -l \+100%FREE \/dev\/mapper\/worker--vg-root/);
  assert.doesNotMatch(narrowPolicy, /apt-get|corepack|NOPASSWD: ALL/);
  const invalid = await runRaw(sudoersArgs, root, { ...env, TEST_INVALID_POLICY: '1' });
  assert.equal(invalid.code, 1);
  assert.equal(await readFile(env.TEST_SUDOERS, 'utf8'), narrowPolicy, 'validation failure must preserve the installed policy');
  const provisioning = await runRaw([...sudoersArgs, '--passwordless-provisioning'], root, env);
  assert.equal(provisioning.code, 0, provisioning.stderr);
  const provisionPolicy = await readFile(env.TEST_SUDOERS, 'utf8');
  assert.match(provisionPolicy, /apt-get/);
  assert.match(provisionPolicy, /corepack/);
  assert.doesNotMatch(provisionPolicy, /NOPASSWD: ALL|\/bash \*|\/sh \*/);
  const withoutPermission = await runRaw(['host', 'prepare', 'worker', '--passwordless-provisioning', '--stack=prepare-test'], root, env);
  assert.equal(withoutPermission.code, 1);
  const beforeSkip = await readFile(env.TEST_SUDO_LOG, 'utf8');
  const skipMac = await runRaw(['host', 'prepare', '--all-linux', '--grow-root', '--stack=prepare-test'], root, { ...env, TEST_OS: 'Darwin' });
  assert.equal(skipMac.code, 0, skipMac.stderr);
  assert.equal(await readFile(env.TEST_SUDO_LOG, 'utf8'), beforeSkip, 'all-linux must skip macOS before asking for sudo');
  await writeFile(log, '');
  const several = await runRaw(['host', 'prepare', 'worker', 'manual', 'WORKER', '--no-sleep', '--stack=prepare-test'], root, env);
  assert.equal(several.code, 0, several.stderr);
  const selected = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(selected.length, 2);
  assert.ok(selected[0].includes('worker'));
  assert.ok(selected[1].includes('manual'));
  const privilegedBin = join(root, 'privileged-bin');
  await mkdir(privilegedBin);
  for (const command of ['lvs', 'vgs', 'lvextend']) await rename(join(binDir, command), join(privilegedBin, command));
  await writeFile(extents, '64\n');
  const priorGrowth = await readFile(growth, 'utf8');
  const restrictedPath = env.PATH.split(':').filter(path => !path.endsWith('/sbin')).join(':');
  const privilegedDiscovery = await runRaw(['host', 'prepare', 'worker', '--grow-root', '--stack=prepare-test'], root,
    { ...env, PATH: restrictedPath, TEST_PRIVILEGED_BIN: privilegedBin });
  assert.equal(privilegedDiscovery.code, 0, privilegedDiscovery.stderr);
  assert.equal(await readFile(growth, 'utf8'), priorGrowth + '-r -l +100%FREE /dev/mapper/worker--vg-root\n',
    'missing unprivileged metadata tools must not silently skip root discovery and growth');
  for (const command of ['lvs', 'vgs']) await rename(join(privilegedBin, command), join(binDir, command));
  await rename(join(privilegedBin, 'lvextend'), join(privilegedBin, 'disabled-lvextend'));
  await writeFile(extents, '64\n');
  const missingGrowth = await runRaw(['host', 'prepare', 'worker', '--grow-root', '--stack=prepare-test'], root,
    { ...env, PATH: restrictedPath, TEST_PRIVILEGED_BIN: privilegedBin });
  assert.equal(missingGrowth.code, 1, 'positive extents without lvextend must fail visibly');
  await writeFile(extents, '0\n');
  const beforeZero = await readFile(env.TEST_SUDO_LOG, 'utf8');
  const zeroWithoutGrowthTool = await runRaw(['host', 'prepare', 'worker', '--grow-root', '--stack=prepare-test'], root,
    { ...env, PATH: restrictedPath });
  assert.equal(zeroWithoutGrowthTool.code, 0, zeroWithoutGrowthTool.stderr);
  assert.equal(await readFile(env.TEST_SUDO_LOG, 'utf8'), beforeZero + 'invocation\n',
    'zero extents require authenticated inspection but no lvextend');
});

test('host preparation explicitly opts into fleet SSH, disk-backed tmp and inotify with fresh security verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-fleet-tmp-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const etc = join(root, 'etc');
  await mkdir(etc);
  const { binDir } = writeFakeBin({ root, name: 'ssh', content: `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2); if (args.at(-1) === 'true') process.exit(0);
// Only remap the OS filesystem boundary; execute the actual preparation script.
const script=args.at(-1).replaceAll('/etc/',process.env.TEST_ETC+'/').replaceAll('/var/lib/',process.env.TEST_ETC+'/state/');
const result=spawnSync('/bin/bash',['-c',script],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);
` });
  for (const [name, body] of Object.entries({
    uname: 'echo Linux',
    id: 'case "$1" in -un) echo worker;; -u) echo "${TEST_ROOT:-1000}";; esac',
    sudo: 'echo invocation >> "$TEST_SUDO_LOG"; export TEST_ROOT=0; exec "$@"',
    sshd: 'case "$1" in -V) echo "OpenSSH_9.8p1, OpenSSL 3.0.13" >&2;; -T) printf "maxsessions 64\\nmaxstartups 100:30:200\\npersourcepenaltyexemptlist 100.64.0.0/10\\n";; -t) exit 0;; *) exit 9;; esac',
    systemctl: 'case "$1" in show) echo 0;; stop) :;; *) case "$*" in "reload ssh"|"mask tmp.mount") printf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG";; *) exit 9;; esac;; esac',
    'systemd-run': 'exit 0',
    umount: 'echo "must not unmount live tmp" >&2; exit 9',
    sysctl: 'case "$*" in "-n fs.inotify.max_user_instances") cat "$TEST_INSTANCES";; "-p "*) [ "$(cat "$2")" = "fs.inotify.max_user_instances=1024" ] || exit 9; echo 1024 > "$TEST_INSTANCES"; echo instances >> "$TEST_SYSCTL_LOG";; *) exit 9;; esac',
  })) writeFakeBin({ root, name, content: '#!/bin/sh\nset -eu\n' + body + '\n' });
  const env = { PATH: `${binDir}:${process.env.PATH}`, TEST_ETC: etc,
    TEST_SUDO_LOG: join(root, 'sudo.log'), TEST_SYSTEMCTL_LOG: join(root, 'systemctl.log'),
    TEST_INSTANCES: join(root, 'instances'), TEST_SYSCTL_LOG: join(root, 'sysctl.log') };
  await writeFile(env.TEST_INSTANCES, '128\n');
  await run(['add', 'worker', '--stack=prepare-test', '--platform=posix', '--ssh=worker',
    '--repo-dir=/home/dev/repo', '--cli-home-dir=/home/dev/cli'], root, env);
  const args = ['host', 'prepare', 'worker', '--fleet-ssh', '--disk-tmp', '--inotify', '--stack=prepare-test'];
  const first = await runRaw(args, root, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await readFile(join(etc, 'ssh/sshd_config.d/50-happier-fleet.conf'), 'utf8'),
    'MaxSessions 64\nMaxStartups 100:30:200\nPerSourcePenaltyExemptList 100.64.0.0/10\n');
  assert.equal(await readFile(join(etc, 'tmpfiles.d/tmp.conf'), 'utf8'), 'q /tmp 1777 root root 3d\n');
  assert.equal(await readFile(join(etc, 'sysctl.d/60-happier-inotify.conf'), 'utf8'), 'fs.inotify.max_user_instances=1024\n');
  assert.equal(await readFile(env.TEST_INSTANCES, 'utf8'), '1024\n');
  assert.match(first.stderr + first.stdout, /next reboot/i);
  assert.equal(await readFile(env.TEST_SUDO_LOG, 'utf8'), 'invocation\ninvocation\ninvocation\n');
  const second = await runRaw(args, root, env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(env.TEST_SUDO_LOG, 'utf8'), 'invocation\n'.repeat(6));
  assert.equal((await readFile(env.TEST_SYSTEMCTL_LOG, 'utf8')).match(/reload ssh/g).length, 1);
  assert.equal(await readFile(join(etc, 'tmpfiles.d/tmp.conf'), 'utf8'), 'q /tmp 1777 root root 3d\n');
  assert.equal(await readFile(env.TEST_SYSCTL_LOG, 'utf8'), 'instances\n');
  const diskOnly = await runRaw(['host', 'prepare', 'worker', '--disk-tmp', '--stack=prepare-test'], root, env);
  assert.equal(diskOnly.code, 0, diskOnly.stderr);
  await writeFile(env.TEST_INSTANCES, '128\n');
  const inotifyOnly = await runRaw(['host', 'prepare', 'worker', '--inotify', '--stack=prepare-test'], root, env);
  assert.equal(inotifyOnly.code, 0, inotifyOnly.stderr);
  assert.equal(await readFile(env.TEST_INSTANCES, 'utf8'), '1024\n');
});

test('automatic worker power setup excludes manual targets and exposes OS permission failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-worker-power-cli-'));
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const log = join(root, 'connections');
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$POWER_CONNECTIONS"\nexit 0\n');
    await chmod(join(bin, 'ssh'), 0o755);
    const env = { PATH: bin + ':' + process.env.PATH, POWER_CONNECTIONS: log };
    for (const name of ['worker', 'manual']) await run(['add', name, '--stack=power-test', '--platform=posix', '--ssh=' + name, '--repo-dir=/home/dev/repo', '--cli-home-dir=/home/dev/cli'], root, env);
    await run(['placement', 'set', 'commands', 'auto', '--targets=worker', '--stack=power-test'], root, env);
    const configured = await run(['power', 'no-sleep', 'auto', '--stack=power-test'], root, env);
    assert.deepEqual(configured.results.map((entry) => entry.name), ['worker']);
    const connections = await readFile(log, 'utf8');
    assert.equal(connections.includes('manual'), false, 'manual computers are outside automatic worker setup');
    await writeFile(join(bin, 'ssh'), '#!/bin/sh\necho "sudo: authentication required" >&2\nexit 1\n');
    const denied = await runRaw(['power', 'no-sleep', 'auto', '--stack=power-test', '--json'], root, env);
    assert.equal(denied.code, 1);
    assert.equal(JSON.parse(denied.stdout).results[0].results[0].ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dev-targets status exposes failed power policy health independently of healthy sync', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-power-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'repo-test'), { recursive: true });
  await writeFile(join(root, 'repo-test', 'dev-targets.json'), JSON.stringify({ version: 1,
    targets: [{ name: 'linux', platform: 'posix', ssh: 'linux', repoDir: '/repo', cliHomeDir: '/state' }] }));
  const { binDir } = writeFakeBin({ root, name: 'mutagen', content: '#!/bin/sh\nprintf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":1,"alpha":{"connected":true,"scanned":true},"beta":{"connected":true,"scanned":true}}]\\n\'\n' });
  writeFakeBin({ root, name: 'ssh', content: '#!/bin/sh\nprintf \'__HAPPIER_WORKER_POWER__={"ok":false,"detail":"sleep.target is not masked"}\\n\'\n' });
  const result = await runRaw(['status', 'linux', '--stack=repo-test', '--json'], root, { PATH: `${binDir}:${process.env.PATH}` });
  const status = JSON.parse(result.stdout);
  assert.equal(status.status.state, 'ready');
  assert.equal(status.powerPolicy?.ok, false);
  assert.equal(status.powerPolicy?.results[0].detail, 'sleep.target is not masked');
  assert.equal(result.code, 1);
});
