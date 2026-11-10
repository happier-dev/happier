// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderNativeCommandPolicy, resolveRemoteCommandPolicy } from './remote_commands.mjs';

test('single-root noEmit checks reserve one graph through executable wrappers', () => {
  const leaf = ['scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '--strict',
    '--target', 'ES2022', '--moduleResolution', 'bundler',
    'packages/protocol/src/actions/executor/actionExecutor.ts'];
  for (const prefix of [['node'], ['nodejs'], ['pnpm', 'exec', 'node'], ['corepack', 'pnpm', 'exec', 'node'],
    ['pnpm', 'node'], ['env', 'CI=true', 'node'], ['hstack-exec', '--', 'node']]) {
    const policy = resolveRemoteCommandPolicy([...prefix, ...leaf]);
    assert.equal(policy.heavyClass, 'runtime-build', prefix.join(' '));
    assert.equal(policy.localCompile, '1');
  }
  for (const prefix of [['pnpm', '--dir', 'apps/cli', 'exec', 'node'],
    ['pnpm', '--cwd=apps/cli', 'exec', 'node'],
    ['hstack-exec', '--cwd=apps/cli', '--', 'node']]) {
    assert.equal(resolveRemoteCommandPolicy([...prefix, '../../scripts/workspaces/runTypeScriptCli.mjs',
      '--noEmit', '../../packages/protocol/src/actions/executor/actionExecutor.ts']).heavyClass, 'runtime-build');
  }
});

test('native launcher consumes the same single-root classification', () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const result = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@" || exit $?; printf '%s' "$policy_heavyClass"`,
    'policy', root, 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit',
    'packages/protocol/src/actions/executor/actionExecutor.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'runtime-build');
});

test('full package and ambiguous compiler requests retain their existing admission', () => {
  const runner = ['node', 'scripts/workspaces/runTypeScriptCli.mjs'];
  for (const args of [[], ['--noEmit'], ['--noEmit', '--project', 'tsconfig.json'],
    ['--noEmit', '--outFile', 'output.ts'],
    ['--noEmit', 'one.ts', 'two.ts'], ['--noEmit', '--build']]) {
    assert.equal(resolveRemoteCommandPolicy([...runner, ...args]).heavyClass, 'compilation', args.join(' '));
  }
});
