import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { buildRemoteExecCommand } from './utils/dev_targets/remote_commands.mjs';
import { withDependencyRefreshLock } from './utils/proc/dependency_refresh.mjs';

test('admission reclaims dead and incomplete owners even while capacity is unavailable', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-incomplete-owner-' });
  const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root });
  const token = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];
  for (const [identity, processRecord] of [
    ['99999999-1', '99999999 1\n'], ['99999999-2', null], ['99999999-3', ''],
    [`${process.pid}-${token}`, `${process.pid} ${token}\n`],
  ]) {
    const owner = join(admissionRoot, 'owners', identity);
    await mkdir(owner, { recursive: true });
    await writeFile(join(owner, 'class'), 'compilation\n');
    await writeFile(join(owner, 'disk'), 'retired field\n');
    if (processRecord !== null) await writeFile(join(owner, 'process'), processRecord);
  }
  writeFakeBin({ root: fixture.root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "5242880 33554432\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  const result = spawnSync('/bin/sh', [launcher, '--heavyweight-admission-check', '--class=validation', '--machine=worker'], {
    env: { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin` }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /memory-available/);
  assert.deepEqual(await readdir(join(admissionRoot, 'owners')), [`${process.pid}-${token}`]);
});

for (const entry of ['native', 'explicit', 'local']) {
  test(entry === 'local' ? 'local compilation waits for an active dependency writer before admission and admits its ready tree after release'
    : `${entry} compilation bootstraps dependencies before admission so their lock holder can finish`, { skip: process.platform !== 'linux', timeout: 30_000 }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-preparation-admission-' });
    const { launcher, admissionRoot } = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
    await chmod(launcher, 0o755);
    const checkout = fixture.path('native-owner');
    const component = join(checkout, 'apps/ui');
    const home = fixture.path('cli-home');
    const preparing = fixture.path('preparing');
    const compiled = fixture.path('compiled');
    await mkdir(component, { recursive: true });
    // Observe the preparation process entering its real readiness/lock owner;
    // only the eventual compiler executable is replaced.
    writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  *remote_dependency_bootstrap.mjs*) printf preparing > "$PREPARING"; exec '${process.execPath}' "$@" ;;
  *runTypeScriptCli.mjs*)
    [ -n "$HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN" ] || exit 99
    printf compiled > "$COMPILED"; exit 0 ;;
  *) exec '${process.execPath}' "$@" ;;
esac
` });
    writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '33554432 33554432\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
    writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
    const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
      HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_PREFERRED_EXECUTION: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
      HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
      HAPPIER_HSTACK_DISPATCH_CONTROL: '', HAPPIER_HSTACK_EXECUTION: '',
      PREPARING: preparing, COMPILED: compiled,
    };
    const target = { name: 'worker', platform: 'posix', repoDir: checkout, cliHomeDir: home, remotePath: [fixture.path('bin'), '/usr/bin', '/bin'] };
    let args;
    if (entry === 'local') {
      args = [launcher, '--local', '--allow-local-compilation', '--', 'node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'];
    } else if (entry === 'explicit') {
      args = ['-c', buildRemoteExecCommand(target, { executionId: 'preparation-regression', cwd: 'apps/ui',
        commandArgs: ['node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], admissionClass: 'compilation-ui',
        preparation: { bootstrap: true, componentRelativeDir: 'apps/ui', validationKind: 'typecheck' },
        environment: { HAPPIER_DEV_TARGET_EXECUTION: '1' },
      })];
    } else {
      const stack = fixture.path('stack');
      await mkdir(join(stack, 'mutagen/data'), { recursive: true });
      const config = join(stack, 'dev-targets.json');
      await writeFile(config, '{"version":1,"targets":[]}\n');
      await writeFile(join(stack, 'dev-target-exec-v1.sh'), [
        "HSTACK_EXEC_PROJECTION_VERSION='2'", `projection_repo_root='${checkout}'`, `projection_config_path='${config}'`,
        `projection_mutagen_data_dir='${stack}/mutagen/data'`,
        `projection_mutagen_ssh_path='${stack}/mutagen/ssh'`,
        "command_mode='auto'", "include_local='0'", "fallback_mode='error'",
        "load_ttl_seconds='15'", "unavailable_ttl_seconds='120'", "target_count='1'",
        "target_1_name='worker'", "target_1_ssh='fixture-host'", "target_1_ssh_config=''",
        `target_1_repo_dir='${checkout}'`, `target_1_cli_home='${home}'`,
        `target_1_remote_path='${env.PATH}'`, '',
      ].join('\n'));
      env.HAPPIER_EXEC_CONFIG_PATH = config;
      env.HAPPIER_STACK_STORAGE_DIR = fixture.path('stacks');
      writeFakeBin({ root: fixture.root, name: 'mutagen', content: '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n' });
      writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/bin/sh
case "$*" in
  *getconf*) printf '8 0.1 1 22000000 20 0 33554432 33554432 0 0 0 0 0 0 0 linux\n' ;;
  *"&& command -v "*|*-MNf*|*-O\\ check*) exit 0 ;;
  *) for argument in "$@"; do remote=$argument; done; exec /bin/sh -c "$remote" ;;
esac
` });
      args = [launcher, '--target=worker', '--', 'node', '../../scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'];
    }
    let child;
    let completed;
    let stderr = '';
    try {
      await withDependencyRefreshLock({ installDir: checkout, env }, async () => {
        child = spawn(entry === 'explicit' ? '/bin/bash' : '/bin/sh', args, { cwd: component, env, signal: t.signal });
        child.stderr.on('data', chunk => { stderr += chunk; });
        completed = new Promise((resolveExit, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolveExit({ code, signal }));
        });
        for (let attempt = 0; ; attempt++) {
          try { await access(preparing); break; } catch (error) {
            if (error.code !== 'ENOENT' || attempt === 250 || child.exitCode !== null) {
              assert.fail(`preparation did not reach the held dependency lock: ${stderr}`);
            }
            await new Promise(resolveWait => setTimeout(resolveWait, 20));
          }
        }
        const installer = spawnSync('/bin/sh', [launcher, '--heavyweight-admission', '--class=dependency-install', '--machine=worker', '--no-wait', '--', '/usr/bin/true'], {
          env: { ...env, HAPPIER_DEV_TARGET_EXECUTION: '1' }, encoding: 'utf8',
        });
        assert.equal(installer.status, 0, `dependency lock holder must finish while compilation prepares: ${installer.stderr}`);
        await assert.rejects(access(compiled), { code: 'ENOENT' });
        assert.equal(child.exitCode, null, 'compilation must wait until the active dependency writer releases');
      });
    } finally {
      // Releasing the real dependency lock lets even the defective compile
      // drain, so RED never leaves a blocked fixture process behind.
      if (completed) {
        const result = await completed;
        assert.equal(result.code, 0, `${result.signal ?? ''} ${stderr}`);
      }
    }
    assert.equal(await readFile(compiled, 'utf8'), 'compiled');
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
  });

}

async function createPublisherPlacementFixture(t, capacityKiB = 19922944) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publisher-environment-' });
  const { launcher } = await installNativeAdmissionFixture({ root: fixture.root });
  const checkout = fixture.path('native-owner');
  const stack = fixture.path('stack');
  const dispatched = fixture.path('dispatched');
  await Promise.all([mkdir(join(stack, 'mutagen/data'), { recursive: true }),
    mkdir(join(checkout, 'packages/protocol'), { recursive: true })]);
  const config = join(stack, 'dev-targets.json');
  await writeFile(config, '{"version":1,"targets":[]}\n');
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`,
    HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_EXECUTION: '', HAPPIER_HSTACK_DISPATCH_CONTROL: '',
    HAPPIER_PREFERRED_EXECUTION: '', HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '',
    HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '', DISPATCHED: dispatched };
  await writeFile(join(stack, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'", `projection_repo_root='${checkout}'`, `projection_config_path='${config}'`,
    `projection_mutagen_data_dir='${stack}/mutagen/data'`, `projection_mutagen_ssh_path='${stack}/mutagen/ssh'`,
    "command_mode='auto'", "include_local='0'", "fallback_mode='error'",
    "load_ttl_seconds='15'", "unavailable_ttl_seconds='120'", "target_count='1'",
    "target_1_name='worker'", "target_1_ssh='fixture-host'", "target_1_ssh_config=''",
    `target_1_repo_dir='${checkout}'`, `target_1_cli_home='${fixture.path('cli-home')}'`,
    `target_1_remote_path='${env.PATH}'`, '',
  ].join('\n'));
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root: fixture.root, name: 'mutagen', content: '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\nexit 0\n' });
  // SSH, host measurements and the eventual compiler are OS boundaries. The
  // real canonical emit/publisher policy decides the envelope and placement.
  writeFakeBin({ root: fixture.root, name: 'ssh', content: `#!/bin/sh
case "$*" in
  *getconf*) printf '8 0.1 1 ${capacityKiB} 20 0 ${capacityKiB} ${capacityKiB} 0 0 0 0 0 0 0 linux\\n' ;;
  *"&& command -v "*|*-MNf*|*-O\\ check*) exit 0 ;;
  *) for argument in "$@"; do remote=$argument; done; exec /bin/sh -c "$remote" ;;
esac
` });
  writeFakeBin({ root: fixture.root, name: 'node', content: `#!/bin/sh
case "$1" in
  *buildTypeScriptPackageDist.mjs) printf dispatched > "$DISPATCHED" ;;
  *) exec '${process.execPath}' "$@" ;;
esac
` });
  return { checkout, env, dispatched, launcher };
}

test('native publisher placement uses explicit payload environment before selecting its compiler envelope', { skip: process.platform !== 'linux' }, async t => {
  const { launcher, checkout, env, dispatched } = await createPublisherPlacementFixture(t);
  const result = spawnSync('/bin/sh', [launcher, '--target=worker', '--env=HAPPIER_WORKSPACE_BUILD_MODE=strict', '--',
    'node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json', '--noCheck'],
  { cwd: checkout, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /insufficient memory capacity.*compilation.*requires=20971520 KiB/, result.stderr);
  await assert.rejects(access(dispatched), { code: 'ENOENT' });
});

test('native publisher placement resolves its exact entry and compiler class from explicit payload cwd', { skip: process.platform !== 'linux' }, async t => {
  const { launcher, checkout, env, dispatched } = await createPublisherPlacementFixture(t, 17825792);
  const result = spawnSync('/bin/sh', [launcher, '--target=worker', '--cwd=packages/protocol', '--',
    'node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json', '--noCheck'],
  { cwd: checkout, env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'strict' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /insufficient memory capacity.*requires=18874368 KiB/, result.stderr);
  await assert.rejects(access(dispatched), { code: 'ENOENT' });
});
