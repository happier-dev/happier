import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveRepoStackIdentity } from '../stack/repo_stack_identity.mjs';

import { prepareCommandRepository, renderNativeExecutionProjection, resolveCommandRepositoryConfig } from './native_execution_projection.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS, renderMutagenProject } from './mutagen_project.mjs';
import { renderNativeCommandPolicy, resolveRemoteCommandPolicy, resolveHeavyweightMemoryFloorKiB } from './remote_commands.mjs';
import { classifyCleanMutagenReadiness, renderNativeSyncReadinessPolicy } from './mutagen_runtime.mjs';

test('sibling routing does not recreate withdrawn mac-host command mirrors', () => {
  const config = { version: 3, targets: ['mac-host', 'mac2-linux'].map(name => ({ name,
    platform: 'posix', ssh: name, repoDir: '/mirror/0.3', cliHomeDir: '/home/worker' })),
    commandExecution: { mode: 'auto', targets: ['mac-host', 'mac2-linux'], fallback: 'local' } };
  const sibling = resolveCommandRepositoryConfig(config, { repoRoot: '/source/0.2', executorRepoRoot: '/source/0.3',
    commandExecution: config.commandExecution });
  assert.deepEqual(sibling.targets.map(target => target.name), ['mac2-linux']);
  assert.deepEqual(sibling.commandExecution.targets, ['mac2-linux']);
});

test('public typechecks retain warm placement without an input-equality dispatcher', () => {
  const launcher = readFileSync(new URL('../../../bin/hstack-exec', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /typecheck_dispatch\.mjs/);
  assert.match(launcher, /typecheck_affinity_key/);
  assert.match(launcher, /heavyweight_admission_prefix/);
});

test('dependency-backed commands without another class still enter dependency-install admission', () => {
  const policy = resolveRemoteCommandPolicy(['corepack', 'yarn', '-s', 'custom-command']);
  assert.equal(policy.bootstrap, '1');
  assert.equal(policy.heavyClass, 'dependency-install');
});

test('CLI unit script dispatch and reentry prepare source tests in the validation class', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const args of [
    ['--script=test:unit:local', 'src/api/artifacts/accountArtifactStore.test.ts'],
    ['corepack', 'yarn', '-s', 'test:unit:vitest:local', 'src/api/artifacts/accountArtifactStore.test.ts'],
    ['corepack', 'yarn', '-s', 'test:local'],
    ['node', 'scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'],
  ]) {
    const policy = resolveRemoteCommandPolicy(args, { cwd: 'apps/cli' });
    assert.equal(policy.heavyClass, 'validation');
    assert.equal(policy.kind, 'source-test');
    const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1/apps/cli; shift; resolve_native_command_policy "$@"; printf '%s,%s' "$policy_kind" "$policy_heavyClass"`, 'policy', root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test,validation');
  }
  assert.equal(resolveRemoteCommandPolicy(['--script=test:unit:local'], { cwd: 'apps/server' }).kind, 'runtime');
  assert.equal(resolveRemoteCommandPolicy(['--script=test:integration:local'], { cwd: 'apps/cli' }).kind, 'runtime');
});

test('root Yarn workspace CLI unit requests retain the selected component and validation preparation', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const args = ['yarn', 'workspace', '@happier-dev/cli', 'test:unit', 'src/api/artifacts/accountArtifactStore.test.ts'];
  const policy = resolveRemoteCommandPolicy(args);
  assert.equal(policy.component, 'apps/cli');
  assert.equal(policy.kind, 'source-test');
  assert.equal(policy.heavyClass, 'validation');
  const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@"; printf '%s,%s,%s' "$policy_component" "$policy_kind" "$policy_heavyClass"`, 'policy', root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'apps/cli,source-test,validation');
});

test('native runtime worker admits installed source tools without emitting workspace prerequisites', () => {
  for (const args of [
    ['node', '--conditions=happier-source', '--import', 'tsx', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'],
    ['node', '--conditions', 'happier-source', '--import=tsx', 'scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'],
  ]) {
    const cwd = args.includes('scripts/build/remote_runtime_build.mjs') ? 'apps/stack' : '.';
    const policy = resolveRemoteCommandPolicy(args, { cwd });
    assert.equal(policy.bootstrap, '1');
    assert.equal(policy.kind, 'source-test');
    assert.equal(policy.component, 'apps/stack');
    assert.equal(policy.heavyClass, 'runtime-build', 'source loading does not lower native compiler admission');
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1/$2; shift 2; resolve_native_command_policy "$@"; printf '%s,%s,%s,%s' "$policy_bootstrap" "$policy_kind" "$policy_component" "$policy_heavyClass"`, 'policy', root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, '1,source-test,apps/stack,runtime-build');
  }
});

test('source-conditioned generator checks skip emitted dependencies without changing ordinary publication preparation', () => {
  const entry = 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts';
  for (const prefix of [[], ['--conditions=happier-source'], ['--conditions', 'happier-source']]) {
    const args = ['node', ...prefix, '--experimental-strip-types', entry, '--mode', 'check', '--scope', 'projections'];
    const kind = prefix.length ? 'source-test' : 'runtime';
    assert.equal(resolveRemoteCommandPolicy(args).kind, kind);
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@"; printf '%s,%s' "$policy_kind" "$policy_generatorCheck"`, 'policy', root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, kind + ',1');
  }
});

test('package typecheck envelopes apply Round 3 measured tree peaks and existing headroom', () => {
  for (const [component, className, peakKiB, gib] of [
    ['ui', 'compilation-ui', 18909772, 20],
    ['cli', 'compilation-cli', 13688852, 15],
    ['server', 'compilation-server', 14179616, 16],
  ]) {
    const floor = Math.ceil((peakKiB + 1608848) / (1024 * 1024)) * 1024 * 1024;
    assert.equal(floor, gib * 1024 * 1024);
    const policy = resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', `apps/${component}/tsconfig.json`]);
    assert.equal(policy.heavyClass, className);
    assert.equal(resolveHeavyweightMemoryFloorKiB(className), floor);
    const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nheavyweight_memory_floor_kib "$1"`, 'floor', className], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(Number(native.stdout), floor);
    const batch = resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', `apps/${component}/tsconfig.source.json`, '-p', `apps/${component}/tsconfig.test.json`]);
    assert.equal(batch.heavyClass, className, 'serial projects in one package retain that package envelope');
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    assert.equal(resolveRemoteCommandPolicy(['corepack', 'yarn', '--cwd', `${root}apps/${component}`, '-s', 'typecheck']).heavyClass, className);
  }
  assert.equal(resolveHeavyweightMemoryFloorKiB('compilation'), resolveHeavyweightMemoryFloorKiB('compilation-ui'));
  assert.equal(resolveHeavyweightMemoryFloorKiB('package-dist', { machine: 'local' }), 8 * 1024 * 1024);
});

test('measured small-package typechecks use existing fitting envelopes in both dispatchers', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
  for (const [component, className, peakKiB] of [
    ['packages/protocol', 'runtime-build', 10420624],
    ['packages/cli-common', 'package-dist', 2777992],
    ['packages/plugin-sdk', 'package-dist', 4428896],
    ['apps/docs', 'package-dist', 439544],
  ]) {
    assert.ok(resolveHeavyweightMemoryFloorKiB(className) >= peakKiB + 1608848);
    for (const [args, cwd] of [
      [['corepack', 'yarn', '--cwd', component, '-s', component === 'apps/docs' ? 'types:check' : 'typecheck'], '.'],
      [['corepack', 'yarn', '-s', component === 'apps/docs' ? 'types:check' : 'typecheck:local'], component],
      [['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', `${component}/tsconfig.json`], '.'],
      [['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', `${root}/${component}/tsconfig.json`], '.'],
    ]) {
      assert.equal(resolveRemoteCommandPolicy(args, { cwd }).heavyClass, className);
      const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1/$2; shift 2; resolve_native_command_policy "$@"; printf '%s' "$policy_heavyClass"`, 'policy', root, cwd, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, className);
    }
  }
  assert.equal(resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'packages/protocol/tsconfig.json', '-p', 'apps/ui/tsconfig.json']).heavyClass, 'compilation');
  assert.equal(resolveRemoteCommandPolicy(['corepack', 'yarn', '--cwd', 'packages/unknown', '-s', 'typecheck']).heavyClass, 'compilation');
});

test('source bundle envelope covers measured tree RSS and headroom independently of validation', () => {
  // 2026-10-10 nl1 Linux x64 whole daemon source tree, with dependency-first
  // public author emission and the shared single-checker compiler owner.
  const measuredPeakKiB = 8660328;
  const measuredHeadroomKiB = 1608848;
  const sourceBundleKiB = Math.ceil((measuredPeakKiB + measuredHeadroomKiB) / (1024 * 1024)) * 1024 * 1024;
  assert.equal(resolveHeavyweightMemoryFloorKiB('source-bundle'), sourceBundleKiB);
  assert.equal(resolveHeavyweightMemoryFloorKiB('validation'), 6 * 1024 * 1024);
  assert.equal(resolveHeavyweightMemoryFloorKiB('source-bundle', { machine: 'local' }), sourceBundleKiB);
  for (const machine of ['worker', 'local']) {
    const native = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nheavyweight_memory_floor_kib "$1" "$2"`,
      'floor', 'source-bundle', machine], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(Number(native.stdout), resolveHeavyweightMemoryFloorKiB('source-bundle', { machine }));
  }
});

test('native sync readiness artifact executes the same canonical first-cycle and recovery policy', {
  skip: process.platform === 'win32',
}, () => {
  const artifact = new URL('./native_sync_readiness.sh', import.meta.url);
  assert.equal(readFileSync(artifact, 'utf8'), renderNativeSyncReadinessPolicy());
  const clean = { watching: true, noWatch: true, scanned: false, cyclesValid: true, completed: false, scanProblems: false };
  const cases = [
    clean,
    { ...clean, noWatch: false },
    { ...clean, watching: false },
    { ...clean, cyclesValid: false },
    { ...clean, scanProblems: true },
    { ...clean, scanned: true, completed: true, scanProblems: true },
    { ...clean, scanned: true, completed: true },
    { ...clean, scanned: true, completed: true, watching: false },
  ];
  for (const facts of cases) {
    const result = spawnSync('/bin/sh', ['-c', [
      ...Object.entries(facts).map(([fact, value]) => `sync_fact_${fact}=${value ? 1 : 0}`),
      renderNativeSyncReadinessPolicy(),
      'classify_clean_mutagen_readiness',
      'printf "%s" "$sync_readiness"',
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, classifyCleanMutagenReadiness(facts), JSON.stringify(facts));
  }
});

test('sibling checkout projection isolates mirror roots and defaults to the small command pool', () => {
  const config = {
    version: 3,
    targets: ['mac2-linux', 'windows2-linux', 'other'].map(name => ({
      name, platform: 'posix', ssh: name, repoDir: '/workspace-mirror/0.3', cliHomeDir: '/home/worker',
    })),
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['mac2-linux', 'windows2-linux', 'other'], fallback: 'local' },
  };
  const before = JSON.stringify(config);
  const output = renderNativeExecutionProjection(config, { repoRoot: '/workspace/0.2', executorRepoRoot: '/workspace/0.3' });
  assert.match(output, /^target_1_repo_dir='\/workspace-mirror\/0.2'$/m);
  assert.match(output, /^target_1_executor_repo_dir='\/workspace-mirror\/0.3'$/m);
  assert.match(output, /^target_1_automatic='1'$/m);
  assert.match(output, /^target_2_automatic='1'$/m);
  assert.match(output, /^target_3_automatic='0'$/m);
  assert.equal(JSON.stringify(config), before);
});

test('sibling command configuration preserves placement overrides and excludes service watches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-command-repository-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, '0.2');
  const executorRepoRoot = join(root, '0.3');
  const configPath = join(root, 'stack/dev-targets.json');
  await mkdir(repoRoot);
  await mkdir(join(root, 'stack'));
  await writeFile(join(repoRoot, 'package.json'), '{}');
  await writeFile(join(repoRoot, 'yarn.lock'), '# sibling lock');
  const config = {
    version: 3,
    targets: ['mac2-linux', 'windows2-linux', 'other'].map(name => ({
      name, platform: 'posix', ssh: name, repoDir: '/mirror/0.3', cliHomeDir: '/home/worker',
    })),
    runtimePlacement: { server: { mode: 'prefer-target', target: 'mac2-linux' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['other'], fallback: 'error' },
  };
  await writeFile(configPath, JSON.stringify(config));
  const prepared = await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot, synchronize: false });
  assert.deepEqual(prepared.config.commandExecution.targets, ['mac2-linux', 'windows2-linux']);
  const targets = prepared.config.targets.filter(target => prepared.config.commandExecution.targets.includes(target.name));
  const project = renderMutagenProject({ sourceDir: repoRoot, targets, config: prepared.config });
  assert.doesNotMatch(project, /portable|pollingInterval|happier-other/);
  assert.equal((project.match(/mode: "no-watch"/g) ?? []).length, 4);
  for (const ignore of DEV_TARGET_MUTAGEN_IGNORE_PATHS) assert.ok(project.includes(JSON.stringify(ignore)));
  // Repeated sibling dispatch must not need a write to existing stack storage.
  const previousTime = new Date('2000-01-01T00:00:00Z');
  await utimes(prepared.outputPath, previousTime, previousTime);
  const before = await stat(prepared.outputPath);
  await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot, synchronize: false });
  assert.equal((await stat(prepared.outputPath)).mtimeMs, before.mtimeMs);
  await writeFile(prepared.path, JSON.stringify({ ...prepared.config, commandExecution: { mode: 'auto', targets: ['other'], fallback: 'error' } }));
  const next = await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot, synchronize: false });
  assert.deepEqual(next.config.commandExecution.targets, ['other']);
  assert.equal(next.config.commandExecution.fallback, 'error');
  assert.match(await readFile(next.outputPath, 'utf8'), /^target_3_automatic='1'$/m);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
  await assert.rejects(prepareCommandRepository({ configPath, executorRepoRoot, repoRoot: join(repoRoot, 'nested'), synchronize: false }));
});

test('native execution projection contains all POSIX targets and marks automatic command eligibility', () => {
  const output = renderNativeExecutionProjection({
    version: 2,
    targets: [
      {
        name: 'mac', platform: 'posix', ssh: 'mac-host', sshConfigFile: "/tmp/it's.conf",
        repoDir: '/repo path', cliHomeDir: '/home', remotePath: ['/opt/bin', '/usr/bin'],
      },
      {
        name: 'windows', platform: 'windows', ssh: 'win-host',
        repoDir: 'C:/repo', cliHomeDir: 'C:/home', remotePath: [],
      },
    ],
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: {
      mode: 'auto', targets: ['mac', 'windows'], includeLocal: false, fallback: 'local',
      loadProbeTtlMs: 15000, unavailableProbeTtlMs: 120000,
    },
  });

  assert.match(output, /^HSTACK_EXEC_PROJECTION_VERSION='2'$/m);
  assert.match(output, /^command_mode='auto'$/m);
  assert.doesNotMatch(output, /package_manager_commands|primary_only_direct_commands|source_search_direct_commands|validation_direct_commands|validation_script_families|source_test_components/);
  assert.match(output, /^execution_provenance_schema_version='1'$/m);
  assert.match(output, /^execution_provenance_filename='provenance\.jsonl'$/m);
  assert.match(output, /^target_count='1'$/m);
  assert.match(output, /^target_1_name='mac'$/m);
  assert.match(output, /^target_1_automatic='1'$/m);
  assert.match(output, /^target_1_ssh_config='\/tmp\/it'"'"'s\.conf'$/m);
  assert.match(output, /^target_1_repo_dir='\/repo path'$/m);
  assert.doesNotMatch(output, /win-host|C:\/repo/);
});

test('native command decision artifact is current and executes the canonical classifier policy', () => {
  const artifact = new URL('./native_command_policy.sh', import.meta.url);
  assert.equal(readFileSync(artifact, 'utf8'), renderNativeCommandPolicy());
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
  const cases = [
    { args: ['corepack', 'yarn', '-s', 'custom-command'], expectedHeavyClass: 'dependency-install' },
    { args: ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs'] },
    { args: ['node', '--test', 'scripts/generateActionTypeMap.test.mjs'], cwd: 'packages/plugin-sdk' },
    { args: ['node', '--test', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs'] },
    { args: ['node', '--test', 'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs', 'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs'] },
    { args: ['node', '--test', 'apps/stack/scripts/config.test.mjs'], expectedPreparationBuildMode: 'qa-runtime' },
    { args: ['nodejs', '--test', 'owner.test.mjs'], cwd: 'apps/stack2' },
    { args: ['node', '-e', 'console.log("control")'] },
    { args: ['yarn', '--cwd', 'apps/cli', '-s', 'vitest:local', 'run', '--config=vitest.source.integration.config.ts'] },
    { args: ['yarn', '--cwd', 'apps/ui', '-s', 'vitest:local', 'run', '--config=vitest.source.integration.config.ts'] },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=compilation', '--', 'node', '-e', 'console.log("native-build")'], expectedHeavyClass: 'compilation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=runtime-build', '--', 'node', '-e', 'console.log("runtime-build")'], expectedHeavyClass: 'runtime-build' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=source-bundle', '--', 'node', '-e', 'console.log("source-bundle")'], expectedHeavyClass: 'source-bundle' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=compilation', '--class=dependency-install', '--', 'node', '-e', 'console.log("install")'], expectedHeavyClass: 'dependency-install' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--', 'node', '-e', 'console.log("validation")', '--class=compilation'], expectedHeavyClass: 'validation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=targeted-validation', '--', 'node', '-e', 'console.log("focused")'], expectedHeavyClass: 'validation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=unclassified-build', '--', 'node', '-e', 'console.log("build")'], expectedHeavyClass: 'compilation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=targeted-validation', '--no-wait', '--', 'corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'vitest'], expectedComponent: 'apps/ui', expectedBootstrap: '1', expectedHeavyClass: 'validation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=compilation', '--', 'corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'typecheck'], expectedComponent: 'apps/cli', expectedBootstrap: '1', expectedHeavyClass: 'compilation' },
    { args: ['hstack-exec', '--heavyweight-admission', '--unsupported-option', '--class=targeted-validation', '--', 'corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'vitest'], expectedComponent: '.', expectedBootstrap: '0', expectedHeavyClass: 'validation' },
    { args: ['hstack-exec', '--heavyweight-admission', '--class=targeted-validation', '--', 'bash', '-c', 'corepack yarn --cwd apps/ui vitest'], expectedComponent: '.', expectedBootstrap: '0', expectedHeavyClass: 'validation' },
    { args: ['hstack-exec', '--heavyweight-admission', '--class=targeted-validation', '--', 'corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'test:unit'], expectedComponent: 'apps/ui', expectedBootstrap: '1', expectedKind: 'source-test' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'test:unit:vitest'], expectedKind: 'source-test' },
    { args: ['node', 'apps/ui/scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], expectedComponent: 'apps/ui', expectedKind: 'source-test' },
    { args: ['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], cwd: 'apps/cli', expectedKind: 'source-test' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts'], expectedKind: 'source-test' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'test:unit'], expectedKind: 'runtime' },
    { args: ['node', 'scripts/runVitestShards.mjs', '--config', 'vitest.integration.config.ts'], cwd: 'apps/ui', expectedKind: 'runtime' },
    { args: ['node', 'custom/runVitestShards.mjs'], cwd: 'apps/ui', expectedKind: 'runtime' },
    { args: ['node', 'scripts/runVitestShards.mjs'], cwd: 'apps/stack', expectedKind: 'runtime' },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'] },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode=write'] },
    { args: ['node', '--experimental-strip-types', 'other/generateBundledPluginEntries.ts', '--mode=check'] },
    { args: ['tsc', '-p', 'apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation-cli' },
    { args: ['tsc', '-p', 'apps\\cli\\tsconfig.json'] },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--project=apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation-cli' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], expectedHeavyClass: 'compilation-ui', expectedPreparationBuildMode: 'strict' },
    { args: ['corepack', 'yarn', '--cwd', `${root}/apps/ui`, '-s', 'typecheck'], expectedHeavyClass: 'compilation-ui' },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', `${root}/apps/ui/tsconfig.json`], expectedHeavyClass: 'compilation-ui' },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-papps/ui/tsconfig.json'], expectedHeavyClass: 'compilation-ui' },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/ui/tsconfig.json', '-p', 'apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '-p', 'apps/cli/tsconfig.source.json', '-p', './apps/cli/tsconfig.test.json'], expectedHeavyClass: 'compilation-cli' },
    { args: ['--script=build:local'], expectedHeavyClass: 'compilation', expectedPreparationBuildMode: 'strict' },
    { args: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], expectedHeavyClass: 'runtime-build' },
    { args: ['node', '--import=data:text/javascript;base64,ZXhwb3J0IHt9Ow==', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], expectedHeavyClass: 'runtime-build' },
    { args: ['nodejs', '--import', '/tmp/runtime-sampler.mjs', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=stdin'], expectedHeavyClass: 'runtime-build' },
    { args: ['node', '--import=/tmp/runtime-sampler.mjs', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode=write'], expectedPlacement: 'primary-only' },
    { args: ['node', '--import=/tmp/runtime-sampler.mjs', '-e', 'console.log("apps/stack/scripts/build/remote_runtime_build.mjs")', '--worker-request=stdin'], expectedHeavyClass: '' },
    { args: ['nodejs', `${root}/apps/stack/scripts/build/remote_runtime_build.mjs`, '--worker-request=/request.json'], expectedHeavyClass: 'runtime-build' },
    { args: ['node', 'scripts\\build\\remote_runtime_build.mjs', '--worker-request=/request.json'], cwd: 'apps/stack', expectedHeavyClass: 'runtime-build' },
    { args: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--build-captured=/request.json'], expectedHeavyClass: 'compilation' },
    { args: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request='], expectedHeavyClass: 'compilation' },
    { args: ['node', 'custom/remote_runtime_build.mjs', '--worker-request=/request.json'], expectedHeavyClass: 'compilation' },
    { args: ['node', '--test', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], expectedHeavyClass: 'validation' },
    { args: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build'], expectedHeavyClass: 'package-dist' },
    { args: ['node', 'packages/cli-common/scripts/build.mjs'], expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/build.mjs'], cwd: 'packages/cli-common', expectedHeavyClass: 'package-dist' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: 'packages/protocol', expectedHeavyClass: 'runtime-build' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', './tsconfig.json'], cwd: 'packages/plugin-sdk', expectedHeavyClass: 'package-dist' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: 'packages/agents', expectedHeavyClass: 'package-dist' },
    { args: ['node', '../../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: 'packages/plugins/claude', expectedHeavyClass: 'package-dist' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: 'packages/sdk', expectedHeavyClass: 'runtime-build' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['corepack', 'yarn', '--cwd', 'packages/unknown', '-s', 'build'], expectedHeavyClass: 'compilation' },
    { args: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build:unmeasured'], expectedHeavyClass: 'compilation' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', '../../apps/ui/tsconfig.json'], cwd: 'packages/protocol', expectedHeavyClass: 'compilation' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', '../../apps/ui/tsconfig.json', '-p', 'tsconfig.json'], cwd: 'packages/plugin-sdk', expectedHeavyClass: 'compilation' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json', '--noCheck'], cwd: 'packages/protocol', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'custom/build.mjs'], cwd: 'packages/cli-common', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', '--incremental'], cwd: '.', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck=true'], cwd: 'apps/ui', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck=false'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', 'false'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', '--noCheck', 'false'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck=true', '--noCheck=false'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', 'false', '--noCheck', 'true'], cwd: '.', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', 'false', '--noCheck', '--incremental'], cwd: '.', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noCheck'], cwd: '.', expectedHeavyClass: 'compilation' },
    { args: ['yarn', '-s', 'lint'] },
    { args: ['--script=lint:local'] },
    { args: ['git', 'status'] },
    { args: ['rg', 'needle'] },
    { args: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'vitest:local', 'run'] },
    { args: ['corepack', 'yarn', '--cwd', './apps/ui/', '-s', 'vitest:local', 'run'] },
    { args: ['vitest', 'run', '--config=./vitest.config.ts'], cwd: 'apps/cli' },
    { args: ['node', '../../../node_modules/vitest/vitest.mjs', 'run', '--config=vitest.config.ts'], cwd: 'packages/plugins/triage' },
    { args: ['vitest', 'run', '--config=vitest.integration.config.ts'], cwd: 'packages/plugins/triage' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'vitest', 'run', 'src/plugins/authoring/bundleDaemonRuntime.test.ts'] },
    { args: ['corepack', 'yarn', '--cwd', 'apps/cli', '-s', 'vitest', 'run', '--config=vitest.integration.config.ts', 'src/plugins/authoring/bundleDaemonRuntime.integration.test.ts'] },
    { args: ['vitest', 'run', '--config=vitest.artifact-cache.config.ts'], cwd: 'apps/ui' },
    { args: ['vitest', 'run', '--config=unknown.config.ts'], cwd: 'apps/cli' },
    { args: ['vitest', 'run', '--project=artifact'], cwd: 'apps/cli' },
    { args: ['yarn', '--cwd=apps/ui', 'node', '../../scripts/testing/run-vitest-with-heartbeat.mjs', 'run'] },
    { args: ['yarn', 'custom:script'], cwd: 'packages/plugin-sdk' },
    { args: ['yarn', 'install'] },
    { args: ['nodejs', 'node_modules\\vitest\\vitest.mjs', 'run'], cwd: 'apps/cli' },
  ];
  for (const { args, cwd = '.', expectedHeavyClass, expectedPlacement, expectedPreparationBuildMode, expectedComponent, expectedBootstrap, expectedKind } of cases) {
    const policy = resolveRemoteCommandPolicy(args, { cwd });
    if (expectedHeavyClass !== undefined) assert.equal(policy.heavyClass, expectedHeavyClass, args.join(' '));
    if (expectedPlacement) assert.equal(policy.placement, expectedPlacement, args.join(' '));
    if (expectedPreparationBuildMode) assert.equal(policy.preparationBuildMode, expectedPreparationBuildMode, args.join(' '));
    if (expectedComponent) assert.equal(policy.component, expectedComponent, args.join(' '));
    if (expectedBootstrap) assert.equal(policy.bootstrap, expectedBootstrap, args.join(' '));
    if (expectedKind) assert.equal(policy.kind, expectedKind, args.join(' '));
    const keys = Object.keys(policy);
    const artifactWord = "'" + fileURLToPath(artifact).replaceAll("'", "'\"'\"'") + "'";
    const body = 'repo_root=$1; invoked_cwd="$1/$2"; shift 2; . ' + artifactWord
      + '; resolve_native_command_policy "$@"; printf "%s\\n" '
      + keys.map(key => '"$policy_' + key + '"').join(' ');
    const result = spawnSync('/bin/sh', ['-c', body, 'policy-parity', root, cwd, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), keys.map(key => policy[key]), args.join(' ') + ' @ ' + cwd);
  }
});

test('native execution projection retains an exact-only POSIX target under local command placement', () => {
  const output = renderNativeExecutionProjection({
    version: 3,
    targets: [{
      name: 'mac-host', platform: 'posix', ssh: 'mac-host',
      repoDir: '/repo', cliHomeDir: '/home', remotePath: ['/usr/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  });

  assert.match(output, /^command_mode='local'$/m);
  assert.match(output, /^target_count='1'$/m);
  assert.match(output, /^target_1_name='mac-host'$/m);
  assert.match(output, /^target_1_sync_name='happier-mac--host'$/m);
  assert.match(output, /^target_1_automatic='0'$/m);
});

test('sibling service mirrors retain explicit placement without enrolling mac-host in AUTO', () => {
  const target = { name: 'mac-host', platform: 'posix', ssh: 'mac-ssh',
    repoDir: '/mirror/0.2', cliHomeDir: '/home/mac' };
  const parent = { version: 3, targets: [
    { ...target, repoDir: '/mirror/0.3' },
    { ...target, name: 'mac2-linux', ssh: 'worker-ssh', repoDir: '/worker/0.3' },
  ] };
  const runtimeConfig = { version: 3, targets: [target], runtimePlacement: {
    server: { mode: 'prefer-target', target: 'mac-host', fallback: 'error' },
    expo: { mode: 'prefer-target', target: 'mac-host', fallback: 'local' },
    daemon: { mode: 'local-and-targets', targets: ['mac-host'] },
  } };
  const config = resolveCommandRepositoryConfig(parent, {
    repoRoot: '/source/0.2', executorRepoRoot: '/source/0.3', runtimeConfig,
  });
  assert.deepEqual(config.commandExecution.targets, ['mac2-linux']);
  assert.equal(config.targets.find(t => t.name === 'mac-host')?.repoDir, '/mirror/0.2');
  assert.deepEqual(config.runtimePlacement, runtimeConfig.runtimePlacement);
  const projection = renderNativeExecutionProjection(config, { repoRoot: '/source/0.2' });
  const macIndex = config.targets.findIndex(t => t.name === 'mac-host') + 1;
  assert.match(projection, new RegExp(`^target_${macIndex}_automatic='0'$`, 'm'));
  const project = renderMutagenProject({ sourceDir: '/source/0.2', targets: config.targets, config });
  assert.match(project, /beta: "mac-ssh:\/mirror\/0\.2"/);
  assert.match(project, /mode: "portable"/);
});

test('sibling preparation reads its own persisted service placement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-sibling-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, '0.2');
  const executorRepoRoot = join(root, '0.3');
  const configPath = join(root, 'producer/dev-targets.json');
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks') };
  await mkdir(repoRoot);
  await mkdir(join(root, 'producer'));
  await writeFile(join(repoRoot, 'package.json'), '{}');
  await writeFile(join(repoRoot, 'yarn.lock'), '# fixture');
  const target = { name: 'mac-host', platform: 'posix', ssh: 'mac-ssh',
    repoDir: '/mirror/0.2', cliHomeDir: '/home/mac' };
  await writeFile(configPath, JSON.stringify({ version: 3, targets: [
    { ...target, repoDir: '/mirror/0.3' },
    { ...target, name: 'mac2-linux', ssh: 'worker', repoDir: '/worker/0.3' },
  ] }));
  const identity = resolveRepoStackIdentity({ repoRoot, stacksStorageRoot: env.HAPPIER_STACK_STORAGE_DIR, createIfMissing: false });
  await mkdir(identity.stackBaseDir, { recursive: true });
  await writeFile(join(identity.stackBaseDir, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [target], runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac-host', fallback: 'error' },
      expo: { mode: 'local' }, daemon: { mode: 'local' },
    },
  }));
  const prepared = await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot, synchronize: false, env });
  assert.equal(prepared.config.targets.find(t => t.name === 'mac-host')?.repoDir, '/mirror/0.2');
  assert.equal(prepared.config.runtimePlacement.server.target, 'mac-host');
  assert.deepEqual(prepared.config.commandExecution.targets, ['mac2-linux']);
  assert.equal(JSON.parse(await readFile(prepared.path, 'utf8')).runtimePlacement.server.target, 'mac-host');
});
