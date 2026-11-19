import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { withDependencyRefresh } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { ensureWorkspacePackagesBuiltByName, isWorkspacePackageOutputCurrent } from './ensureWorkspacePackagesBuilt.mjs';
import { prepareWorkspaceTypecheckDeclarations } from './prepareReferencedTypecheckDeclarations.mjs';

const buildScript = `node ${JSON.stringify(fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url)))} -p tsconfig.json`;

// Real workspace packages form dependency cycles (plugin-sdk -> triage-protocol
// -> channels-protocol -> plugin-sdk). Consumers enter such a cycle at different
// members, so a declaration key that chains only the dependencies visited
// earlier differs by entry point: every consumer of one typecheck then re-emits
// the whole cycle (observed 12-16 emissions of the same packages per CLI run).
for (const dependent of ['alpha', 'beta']) test(`consumers entering a declaration dependency cycle at different members reuse one emission (${dependent})`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-cycle-' });
  const root = fixture.root;
  mkdirSync(fixture.path('node_modules'), { recursive: true });
  writeFileSync(fixture.path('package.json'), '{"private":true}');
  writeFileSync(fixture.path('pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  const entries = { cli: '@happier-dev/alpha', server: '@happier-dev/beta', ui: null };
  for (const [name, dependency] of Object.entries(entries)) {
    mkdirSync(fixture.path('apps', name), { recursive: true });
    writeFileSync(fixture.path('apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      ...(dependency ? { dependencies: { [dependency]: 'workspace:*' } } : {}) }));
  }
  const packages = { alpha: 'beta', beta: 'alpha' };
  mkdirSync(fixture.path('node_modules/@happier-dev'));
  for (const [name, peer] of Object.entries(packages)) {
    const dir = fixture.path('packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, types: './dist/index.d.ts', scripts: { build: buildScript },
      dependencies: { [`@happier-dev/${peer}`]: 'workspace:*' } }));
    symlinkSync(dir, fixture.path('node_modules/@happier-dev', name), 'junction');
    writeFileSync(join(dir, 'src/index.ts'), name === dependent
      ? `import { ${peer} } from '@happier-dev/${peer}'; export const ${name} = ${peer};\n`
      : `export const ${name} = ${JSON.stringify(name)};\n`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { declaration: true, rootDir: 'src',
      outDir: 'dist', module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src/**/*.ts'] }));
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '', HAPPIER_STACK_HOME_DIR: root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  await withDependencyRefresh({ installDir: root, env }, async () => {});
  const prepare = async component => await prepareWorkspaceTypecheckDeclarations(fixture.path('apps', component),
    { env, withinTypecheckAdmission: true, signal: t.signal });

  const independent = packages[dependent];
  const declaration = () => readFileSync(fixture.path(`packages/${dependent}/dist/index.d.ts`), 'utf8');
  const cold = await prepare(dependent === 'alpha' ? 'cli' : 'server');
  assert.equal(cold.ok, true);
  assert.deepEqual([...cold.declarations].sort(), ['@happier-dev/alpha', '@happier-dev/beta']);
  assert.match(declaration(), new RegExp(`${dependent} = "${independent}"`));
  const otherConsumer = dependent === 'alpha' ? 'server' : 'cli';
  assert.deepEqual((await prepare(otherConsumer)).declarations, [], 'a consumer entering the cycle at another member emits nothing');
  const runtime = await ensureWorkspacePackagesBuiltByName(root, [`@happier-dev/${independent}`],
    { env, buildMode: 'source-dev', signal: t.signal });
  assert.deepEqual(runtime.built, [], 'a runtime request entering the warm cycle at its other member reuses both receipts');

  writeFileSync(fixture.path(`packages/${independent}/src/index.ts`), `export const ${independent} = "changed";\n`);
  assert.deepEqual([...(await prepare(dependent === 'alpha' ? 'cli' : 'server')).declarations].sort(), ['@happier-dev/alpha', '@happier-dev/beta'],
    'an edit inside the cycle invalidates its consumer');
  assert.match(declaration(), new RegExp(`${dependent} = "changed"`));
  assert.deepEqual((await prepare('server')).declarations, []);
});


test('typechecks and runtime preparation share the canonical mapped declaration publication', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-reuse-' });
  const write = (path, value) => {
    mkdirSync(join(fixture.path(path), '..'), { recursive: true });
    writeFileSync(fixture.path(path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const name = '@happier-dev/example';
  write('package.json', { private: true });
  write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters: {}\n");
  for (const app of ['cli', 'server', 'ui']) {
    write(`apps/${app}/package.json`, { name: `@fixture/${app}`, dependencies: { [name]: 'workspace:*' } });
  }
  write('packages/example/package.json', { name, type: 'module', types: './dist/index.d.ts', main: './dist/index.js',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './*': { types: './dist/*.d.ts', default: './dist/*.js' } },
    scripts: { build: buildScript } });
  write('packages/example/tsconfig.json', { compilerOptions: { rootDir: 'src', outDir: 'dist',
    declaration: true, declarationMap: true, module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src/**/*.ts'] });
  write('packages/example/src/index.ts', 'export const value = "original";\n');
  write('packages/example/src/retired.ts', 'export const retired = true;\n');
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '', HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  mkdirSync(fixture.path('node_modules'));
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const packageDir = fixture.path('packages/example');
  const declaration = () => readFileSync(join(packageDir, 'dist/index.d.ts'), 'utf8');
  const runtime = () => ensureWorkspacePackagesBuiltByName(fixture.root, [name], { env, buildMode: 'source-dev', signal: t.signal });
  const typecheck = () => prepareWorkspaceTypecheckDeclarations(fixture.path('apps/cli'),
    { env, withinTypecheckAdmission: true, signal: t.signal });

  assert.deepEqual((await runtime()).built, [name]);
  assert.match(declaration(), /sourceMappingURL=index\.d\.ts\.map/);
  const original = declaration();
  assert.equal((await typecheck()).ok, true);
  assert.equal(declaration(), original, 'typecheck preserves the existing mapped declaration');
  assert.ok(isWorkspacePackageOutputCurrent(packageDir, { env }));
  assert.deepEqual((await runtime()).built, [], 'unchanged typechecks do not force another package emission');

  assert.ok(existsSync(join(packageDir, 'dist/retired.d.ts')));
  unlinkSync(join(packageDir, 'src/retired.ts'));
  write('packages/example/src/index.ts', 'export const value = "changed";\n');
  assert.equal((await typecheck()).ok, true);
  assert.match(declaration(), /"changed"/);
  assert.equal(existsSync(join(packageDir, 'dist/retired.d.ts')), false, 'retired wildcard imports must stop typechecking');
  assert.ok(existsSync(join(packageDir, 'dist/retired.js')), 'running consumers can still load their prior runtime graph');
  assert.match(declaration(), /sourceMappingURL=index\.d\.ts\.map/);
  assert.deepEqual((await runtime()).built, [], 'typecheck publishes the current package through the same owner');
});
