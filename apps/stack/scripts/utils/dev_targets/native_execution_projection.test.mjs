import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderNativeExecutionProjection } from './native_execution_projection.mjs';
import { renderNativeCommandPolicy, resolveRemoteCommandPolicy } from './remote_commands.mjs';

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
    { args: ['node', '--test', 'apps/stack/scripts/config.test.mjs'] },
    { args: ['nodejs', '--test', 'owner.test.mjs'], cwd: 'apps/stack2' },
    { args: ['node', '-e', 'console.log("control")'] },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode', 'check'] },
    { args: ['node', '--experimental-strip-types', 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', '--mode=write'] },
    { args: ['node', '--experimental-strip-types', 'other/generateBundledPluginEntries.ts', '--mode=check'] },
    { args: ['tsc', '-p', 'apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation' },
    { args: ['tsc', '-p', 'apps\\cli\\tsconfig.json'] },
    { args: ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--project=apps/cli/tsconfig.json'], expectedHeavyClass: 'compilation' },
    { args: ['corepack', 'yarn', '--cwd', 'apps/ui', '-s', 'typecheck'], expectedHeavyClass: 'compilation' },
    { args: ['--script=build:local'], expectedHeavyClass: 'compilation' },
    { args: ['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request.json'], expectedHeavyClass: 'runtime-build' },
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
  for (const { args, cwd = '.', expectedHeavyClass } of cases) {
    const policy = resolveRemoteCommandPolicy(args, { cwd });
    if (expectedHeavyClass) assert.equal(policy.heavyClass, expectedHeavyClass, args.join(' '));
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
