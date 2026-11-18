// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderNativeCommandPolicy, resolvePackageCommandPolicy, resolveRemoteCommandPolicy } from './remote_commands.mjs';

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

// The controller refuses explicit local test runs (owner 2026-11-18): one
// policy fact names a test-runner payload for every launcher spelling.
test('test-runner payloads are named by one policy fact in both classifiers', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const runners = [
    ['vitest', 'run', 'a.test.ts'], ['npx', 'vitest', 'run', 'a.test.ts'],
    ['pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', 'sources/a.test.tsx'],
    ['pnpm', 'run', 'test:unit:local', 'a.test.ts'], ['--script=vitest:local', '--', 'run', 'a.test.ts'],
    ['node', '--test', 'apps/stack/scripts/utils/dev_targets/remote_commands.focused.test.mjs'],
    ['pnpm', '--dir', 'packages/tests', 'exec', 'node', 'scripts/run-vitest-with-heartbeat.mjs', 'x.test.ts'],
    ['node', 'apps/ui/scripts/run-playwright-with-heartbeat.mjs', 'e2e/a.spec.ts'],
    ['npx', 'playwright', 'test', 'e2e/a.spec.ts'], ['jest', 'a.test.ts'],
    ['bash', '-c', 'pnpm --dir apps/ui exec vitest run a.test.tsx'],
    ['bash', '-c', 'cd apps/ui && npx vitest run sources/a.test.tsx'],
  ];
  const others = [['printf', 'ok'], ['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    ['pnpm', 'run', 'build'], ['npx', 'playwright', 'install', 'chromium'], ['rg', 'vitest'], ['git', 'status'],
    ['bash', '-c', 'echo vitest']];
  for (const args of runners) {
    assert.equal((await resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root })).testRunner, '1', args.join(' '));
  }
  for (const args of others) {
    assert.equal((await resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root })).testRunner, '0', args.join(' '));
  }
  for (const [args, expected] of [[['jest', 'a.test.ts'], '1'], [['npx', 'playwright', 'test'], '1'],
    [['npx', 'playwright', 'install'], '0'], [['printf', 'ok'], '0']]) {
    const result = spawnSync('/bin/sh', ['-c', `${renderNativeCommandPolicy()}\nrepo_root=$1; invoked_cwd=$1; shift; resolve_native_command_policy "$@" || exit $?; printf '%s' "$policy_testRunner"`,
      'policy', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, args.join(' '));
  }
});

test('test runs that regenerate tracked files are named for the authoritative checkout', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  for (const [args, expected] of [
    [['pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', '-u', 'a.test.tsx'], '1'],
    [['vitest', 'run', '--update', 'a.test.ts'], '1'],
    [['env', 'UPDATE_AUTOMATION_VERB_MATRIX=1', 'node', 'node_modules/vitest/vitest.mjs', 'run', 'a.test.ts'], '1'],
    [['pnpm', '--dir', 'apps/ui', 'exec', 'vitest', 'run', 'a.test.tsx'], '0'],
    [['env', 'CI=1', 'vitest', 'run', 'a.test.ts'], '0'],
  ]) {
    const policy = await resolvePackageCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.testRunner, '1', args.join(' '));
    assert.equal(policy.sourceUpdate, expected, args.join(' '));
  }
});
