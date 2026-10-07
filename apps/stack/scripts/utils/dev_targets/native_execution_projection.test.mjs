import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { prepareCommandRepository, renderNativeExecutionProjection } from './native_execution_projection.mjs';
import { DEV_TARGET_MUTAGEN_IGNORE_PATHS, renderMutagenProject } from './mutagen_project.mjs';
import { renderNativeCommandPolicy, resolveRemoteCommandPolicy } from './remote_commands.mjs';
import { classifyCleanMutagenReadiness, renderNativeSyncReadinessPolicy } from './mutagen_runtime.mjs';

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
  await writeFile(prepared.path, JSON.stringify({ ...prepared.config, commandExecution: { mode: 'auto', targets: ['other'], fallback: 'error' } }));
  const next = await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot, synchronize: false });
  assert.deepEqual(next.config.commandExecution.targets, ['other']);
  assert.equal(next.config.commandExecution.fallback, 'error');
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
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=compilation', '--class=dependency-install', '--', 'node', '-e', 'console.log("install")'], expectedHeavyClass: 'dependency-install' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--', 'node', '-e', 'console.log("validation")', '--class=compilation'], expectedHeavyClass: 'validation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=targeted-validation', '--', 'node', '-e', 'console.log("focused")'], expectedHeavyClass: 'validation' },
    { args: ['apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=unclassified-build', '--', 'node', '-e', 'console.log("build")'], expectedHeavyClass: 'compilation' },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'] },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode=write'] },
    { args: ['node', '--experimental-strip-types', 'other/generateBundledPluginEntries.ts', '--mode=check'] },
    { args: ['tsc', '-p', 'apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation' },
    { args: ['tsc', '-p', 'apps\\cli\\tsconfig.json'] },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--project=apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], expectedHeavyClass: 'compilation', expectedPreparationBuildMode: 'strict' },
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
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', 'tsconfig.json'], cwd: 'packages/protocol', expectedHeavyClass: 'package-dist' },
    { args: ['corepack', 'yarn', '--cwd', 'packages/unknown', '-s', 'build'], expectedHeavyClass: 'compilation' },
    { args: ['corepack', 'yarn', '--cwd', 'packages/cli-common', '-s', 'build:unmeasured'], expectedHeavyClass: 'compilation' },
    { args: ['node', '../../scripts/workspaces/buildTypeScriptPackageDist.mjs', '-p', '../../apps/ui/tsconfig.json'], cwd: 'packages/protocol', expectedHeavyClass: 'compilation' },
    { args: ['node', 'custom/build.mjs'], cwd: 'packages/cli-common', expectedHeavyClass: 'compilation' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck', '--incremental'], cwd: '.', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck=true'], cwd: 'apps/ui', expectedHeavyClass: 'package-dist' },
    { args: ['node', 'scripts/workspaces/buildTypeScriptPackageDist.mjs', '--noCheck=false'], cwd: '.', expectedHeavyClass: 'compilation' },
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
  for (const { args, cwd = '.', expectedHeavyClass, expectedPlacement, expectedPreparationBuildMode } of cases) {
    const policy = resolveRemoteCommandPolicy(args, { cwd });
    if (expectedHeavyClass !== undefined) assert.equal(policy.heavyClass, expectedHeavyClass, args.join(' '));
    if (expectedPlacement) assert.equal(policy.placement, expectedPlacement, args.join(' '));
    if (expectedPreparationBuildMode) assert.equal(policy.preparationBuildMode, expectedPreparationBuildMode, args.join(' '));
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
