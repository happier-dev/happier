// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const policyOwner = fileURLToPath(new URL('./remote_commands.mjs', import.meta.url));

async function siblingFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'vitest-sibling-policy-' });
  for (const file of [
    'package.json', 'pnpm-workspace.yaml',
    'apps/cli/package.json', 'apps/ui/package.json', 'apps/server/package.json',
    'apps/cli/vitest.config.ts', 'apps/cli/vitest.inMemory.config.ts',
    'apps/cli/vitest.integration.config.ts',
    'apps/cli/scripts/vitestWorkspacePackageResolution.ts',
    'apps/cli/src/test-setup.unit.ts', 'apps/cli/src/test-setup.integration.ts',
    'apps/ui/vitest.integration.config.ts', 'apps/ui/vitest.config.ts',
    'apps/server/vitest.config.ts', 'apps/server/vitestWorkspacePackageResolution.ts',
  ]) {
    await mkdir(dirname(fixture.path(file)), { recursive: true });
    await copyFile(join(repoRoot, file), fixture.path(file));
  }
  return fixture;
}

function probe(root, component, config, { skipBuild = '' } = {}) {
  const result = spawnSync(process.execPath, [policyOwner, '--vitest-policy', root,
    join(root, component), 'vitest', 'run', '--config', config, 'src/plain.test.ts'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_CLI_TEST_SKIP_BUILD: skipBuild },
  });
  assert.equal(result.status, 0, `the real policy command must complete: ${result.stderr}`);
  return Object.fromEntries([...result.stdout.matchAll(/^policy_(\w+)='([^']*)'$/gmu)]
    .map(([, key, value]) => [key, value]));
}

test('selected sibling CLI configs receive the same source preparation as the primary checkout', async t => {
  const fixture = await siblingFixture(t);
  for (const config of ['vitest.config.ts', 'vitest.inMemory.config.ts']) {
    const primary = probe(repoRoot, 'apps/cli', config);
    assert.equal(primary.kind, 'source-test', config);
    assert.equal(primary.workspaceLock, '', config);
    assert.deepEqual(probe(fixture.root, 'apps/cli', config), primary, config);
  }
});

test('sibling inherited configs retain source preparation only with the complete resolver and known setup', async t => {
  const fixture = await siblingFixture(t);
  for (const [body, expected] of [
    ['...base, test: { ...base.test, globalSetup: [] }', 'source-test'],
    ['...base, plugins: [...(base.plugins ?? []), { name: "extra" }]', 'source-test'],
    // QA-RUNS-A 2026-11-17: forwarding the base resolver after another plugin list keeps it.
    ['...base, plugins: [...(extraHooks().plugins ?? []), ...(base.plugins ?? [])]', 'source-test'],
    ['...base, plugins: []', 'runtime'],
    ['...base, test: { ...base.test, globalSetup: chooseSetup() }', 'runtime'],
  ]) {
    await writeFile(fixture.path('apps/cli/vitest.future.config.ts'),
      `import base from './vitest.config'; export default { ${body} };`);
    const policy = probe(fixture.root, 'apps/cli', 'vitest.future.config.ts');
    assert.equal(policy.kind, expected, body);
    assert.equal(policy.workspaceLock, expected === 'source-test' ? '' : '.project/tmp/cli-dist-build.lock', body);
  }
  // The source integration shape: packaged integration options with the unit
  // resolver forwarded behind another plugin list and the source-only setup.
  await writeFile(fixture.path('apps/cli/vitest.composed.config.ts'),
    `import integration from './vitest.integration.config'; import source from './vitest.config';
     export default { ...integration, plugins: [...(extraHooks().plugins ?? []), ...(source.plugins ?? [])],
       test: { ...integration.test, globalSetup: ['./src/test-setup.unit.ts'] } };`);
  for (const skipBuild of ['', '1']) {
    const composed = probe(fixture.root, 'apps/cli', 'vitest.composed.config.ts', { skipBuild });
    assert.equal(composed.kind, 'source-test', `composed source integration (skip=${skipBuild || 'unset'})`);
    assert.equal(composed.workspaceLock, '');
  }
  // A plugin with the right name at another path is not the canonical resolver.
  await writeFile(fixture.path('apps/cli/vitest.replaced.config.ts'),
    `import { workspacePackageSourcesPlugin } from './otherResolver';
     export default { plugins: [workspacePackageSourcesPlugin] };`);
  for (const config of ['vitest.replaced.config.ts', 'vitest.unknown.config.ts', 'vitest.integration.config.ts']) {
    const policy = probe(fixture.root, 'apps/cli', config);
    assert.equal(policy.kind, 'runtime', config);
    assert.equal(policy.workspaceLock, '.project/tmp/cli-dist-build.lock', config);
  }
});

test('UI and server focused policies agree between primary and sibling checkouts', async t => {
  const fixture = await siblingFixture(t);
  for (const [component, config] of [
    ['apps/ui', 'vitest.integration.config.ts'], ['apps/server', 'vitest.config.ts'],
  ]) {
    const primary = probe(repoRoot, component, config);
    assert.equal(primary.kind, 'source-test', component);
    assert.equal(primary.workspaceLock, '', component);
    assert.deepEqual(probe(fixture.root, component, config), primary, component);
    assert.equal(probe(fixture.root, component, 'vitest.unknown.config.ts').kind, 'runtime', component);
  }
});

// The 0.2 predecessor retains shared-only setup; targeted debugging can skip it.
test('shared-only sibling setup honors the existing explicit skip-build contract', async t => {
  const fixture = await siblingFixture(t);
  await writeFile(fixture.path('apps/cli/src/test-setup.unit.ts'),
    `import { setup } from './test-setup'; export default () => setup({ buildMode: 'shared-only' });`);
  assert.equal(probe(fixture.root, 'apps/cli', 'vitest.config.ts').kind, 'runtime');
  const skipped = probe(fixture.root, 'apps/cli', 'vitest.config.ts', { skipBuild: '1' });
  assert.equal(skipped.kind, 'source-test');
  assert.equal(skipped.workspaceLock, '');
});

// SOURCE-TEST-CLASS-1112: selection must follow the installed resolver, not a package list.
test('shared source resolver configs skip package-dist preparation in both dispatchers', async t => {
  const { resolveRemoteCommandPolicy, renderNativeCommandPolicy } = await import('./remote_commands.mjs');
  const fixture = await createTempFixture(t, { prefix: 'shared-source-policy-' });
  await writeFile(fixture.path('policy.sh'), renderNativeCommandPolicy());
  for (const [component, config] of [
    ['packages/plugins/channel-telegram', 'vitest.config.ts'],
    ['packages/triage-sources', 'vitest.config.ts'],
    ['packages/plugin-sdk', 'vitest.source.config.ts'],
  ]) {
    const args = ['pnpm', '--dir', component, 'exec', 'vitest', 'run', '--config', config, 'src/plain.test.ts'];
    assert.equal(resolveRemoteCommandPolicy(args, { repoRoot, cwd: repoRoot }).kind, 'source-test', component);
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', fixture.path('policy.sh'), repoRoot, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'source-test', component);
  }
});

test('composed core configs skip package publication only in source mode', async () => {
  const { resolvePackageCommandPolicy } = await import('./remote_commands.mjs');
  const cliSource = 'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT=1';
  const skipServerBuild = 'HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD=yes';
  const cwd = join(repoRoot, 'packages/tests');
  for (const [config, selection] of [
    ['vitest.core.fast.config.ts', 'src/testkit/process/extendedDbDocker.plan.spec.ts'],
    ['vitest.core.slow.config.ts', 'suites/core-e2e/triage.savedViews.journey.slow.e2e.test.ts'],
  ]) {
    const args = ['vitest', 'run', '--config', config, selection];
    const policy = async (...assignments) => resolvePackageCommandPolicy(
      assignments.length ? ['env', ...assignments, ...args] : args, { repoRoot, cwd, env: {} });
    const source = await policy(cliSource, skipServerBuild);
    assert.equal(source.kind, 'source-test', config);
    assert.equal(source.heavyClass, 'focused-validation', config);
    assert.equal(source.workspaceLock, '', config);
    assert.equal((await policy()).kind, 'runtime', config);
    assert.equal((await policy(cliSource)).kind, 'runtime', config);
    assert.equal((await policy(skipServerBuild)).kind, 'runtime', config);
    assert.equal((await policy(cliSource, 'HAPPY_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD=1',
      'HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD=0')).kind, 'runtime', config);
  }
});
