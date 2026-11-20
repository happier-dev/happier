import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from '../../../apps/stack/scripts/testkit/core/env_scope.mjs';
import { installWorkspaceAdmissionProcessFixture } from '../../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { preparePerfSourceDependencies } from './validate-perf.mjs';

test('already-installed performance sources derive the selected embedded policy before building driver dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-dependencies-' });
  const root = fixture.root;
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  .: {}
  apps/ui: {}
  apps/cli: {}
  apps/server: {}
  packages/protocol: {}
  packages/tests:
    dependencies:
      '@happier-dev/protocol':
        specifier: workspace:*
        version: link:../protocol
`);
  for (const app of ['ui', 'cli', 'server']) {
    const directory = join(root, 'apps', app);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@fixture/${app}`, private: true }));
  }
  const protocol = join(root, 'packages/protocol');
  const driver = join(root, 'packages/tests');
  await Promise.all([mkdir(join(protocol, 'src'), { recursive: true }), mkdir(driver, { recursive: true }),
    mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true })]);
  await writeFile(join(protocol, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module',
    main: './dist/index.js', exports: { '.': './dist/index.js' }, scripts: { build: 'node build.mjs' } }));
  await mkdir(join(protocol, 'scripts'));
  await copyFile(new URL('../../../packages/protocol/scripts/generate-embedded-feature-policies.mjs', import.meta.url),
    join(protocol, 'scripts/generate-embedded-feature-policies.mjs'));
  const policyDir = join(root, '.github/feature-policy');
  await mkdir(policyDir, { recursive: true });
  for (const environment of ['preview', 'production']) {
    await writeFile(join(policyDir, environment + '.json'), JSON.stringify({ buildPolicy: { allow: ['fixture.' + environment] } }));
  }
  await writeFile(join(protocol, 'build.mjs'), `import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR;
if (!output) throw new Error('Canonical workspace publisher must own the build output');
await mkdir(output, { recursive: true });
const policy = await readFile(new URL('./src/features/embeddedFeaturePolicies.generated.ts', import.meta.url), 'utf8');
await writeFile(join(output, 'index.js'), 'export const ready = ' + policy.includes('fixture.preview') + ';');
`);
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: '@fixture/perf-driver', type: 'module', private: true,
    dependencies: { '@happier-dev/protocol': 'workspace:*' } }));
  await writeFile(join(driver, 'driver.mjs'), 'export { ready } from "@happier-dev/protocol";\n');
  await symlink(protocol, join(root, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');

  // Redirect only process launch/OS admission. Dependency traversal, the real
  // package build, output validation and staged publication remain canonical.
  const native = await installWorkspaceAdmissionProcessFixture(t, root);
  withPatchedProcessEnv(t, { ...native.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: null });
  assert.equal(existsSync(join(protocol, 'dist/index.js')), false);
  await preparePerfSourceDependencies('candidate', root, t.signal, true);
  assert.equal((await import(pathToFileURL(join(driver, 'driver.mjs')).href)).ready, true);
});
