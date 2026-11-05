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
    'apps/cli/package.json', 'apps/ui/package.json', 'apps/server/package.json',
    'apps/cli/vitest.config.ts', 'apps/cli/vitest.inMemory.config.ts',
    'apps/cli/vitest.integration.config.ts',
    'apps/cli/scripts/vitestWorkspacePackageResolution.ts',
    'apps/cli/src/test-setup.unit.ts', 'apps/cli/src/test-setup.integration.ts',
    'apps/ui/vitest.integration.config.ts', 'apps/server/vitest.config.ts',
  ]) {
    await mkdir(dirname(fixture.path(file)), { recursive: true });
    await copyFile(join(repoRoot, file), fixture.path(file));
  }
  return fixture;
}

function probe(root, component, config) {
  const result = spawnSync(process.execPath, [policyOwner, '--vitest-policy', root,
    join(root, component), 'vitest', 'run', '--config', config, 'src/plain.test.ts'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_CLI_TEST_SKIP_BUILD: '' },
  });
  assert.equal(result.status, 0, 'the real policy command must complete');
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
    ['...base, plugins: []', 'runtime'],
    ['...base, test: { ...base.test, globalSetup: chooseSetup() }', 'runtime'],
  ]) {
    await writeFile(fixture.path('apps/cli/vitest.future.config.ts'),
      `import base from './vitest.config'; export default { ${body} };`);
    const policy = probe(fixture.root, 'apps/cli', 'vitest.future.config.ts');
    assert.equal(policy.kind, expected, body);
    assert.equal(policy.workspaceLock, expected === 'source-test' ? '' : '.project/tmp/cli-dist-build.lock', body);
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
