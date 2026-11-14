import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { withDependencyRefresh } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { prepareWorkspaceTypecheckDeclarations } from './prepareReferencedTypecheckDeclarations.mjs';

// Real workspace packages form dependency cycles (plugin-sdk -> triage-protocol
// -> channels-protocol -> plugin-sdk). Consumers enter such a cycle at different
// members, so a declaration key that chains only the dependencies visited
// earlier differs by entry point: every consumer of one typecheck then re-emits
// the whole cycle (observed 12-16 emissions of the same packages per CLI run).
test('consumers entering a declaration dependency cycle at different members reuse one emission', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-cycle-' });
  const root = fixture.root;
  mkdirSync(fixture.path('node_modules'), { recursive: true });
  writeFileSync(fixture.path('package.json'), '{"private":true}');
  writeFileSync(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  writeFileSync(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const entries = { cli: '@happier-dev/alpha', server: '@happier-dev/beta', ui: null };
  for (const [name, dependency] of Object.entries(entries)) {
    mkdirSync(fixture.path('apps', name), { recursive: true });
    writeFileSync(fixture.path('apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      ...(dependency ? { dependencies: { [dependency]: 'workspace:*' } } : {}) }));
  }
  const packages = { alpha: 'beta', beta: 'alpha' };
  for (const [name, peer] of Object.entries(packages)) {
    const dir = fixture.path('packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, types: './dist/index.d.ts',
      dependencies: { [`@happier-dev/${peer}`]: 'workspace:*' } }));
    writeFileSync(join(dir, 'src/index.ts'), `export const ${name} = ${JSON.stringify(name)};\n`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { declaration: true, rootDir: 'src',
      outDir: 'dist', module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src/**/*.ts'] }));
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '', HAPPIER_STACK_HOME_DIR: root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  await withDependencyRefresh({ installDir: root, env }, async () => {});
  const prepare = async component => await prepareWorkspaceTypecheckDeclarations(fixture.path('apps', component),
    { env, withinTypecheckAdmission: true, signal: t.signal });

  const cold = await prepare('cli');
  assert.equal(cold.ok, true);
  assert.deepEqual([...cold.declarations].sort(), ['@happier-dev/alpha', '@happier-dev/beta']);
  assert.deepEqual((await prepare('server')).declarations, [], 'a consumer entering the cycle at another member emits nothing');
  assert.deepEqual((await prepare('cli')).declarations, [], 'the first consumer stays current afterwards');

  writeFileSync(fixture.path('packages/beta/src/index.ts'), 'export const beta = "changed";\n');
  assert.deepEqual([...(await prepare('cli')).declarations].sort(), ['@happier-dev/alpha', '@happier-dev/beta'],
    'an edit inside the cycle invalidates every member');
  assert.deepEqual((await prepare('server')).declarations, []);
});
