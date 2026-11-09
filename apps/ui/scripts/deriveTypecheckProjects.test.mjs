import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import { deriveUiTypecheckProjects, prepareUiTypecheckProjects } from './deriveTypecheckProjects.mjs';
import { installUiTypecheckFixtureDependencies } from '../../../scripts/testing/lib/typecheckProjectFixture.mjs';
import { readTypecheckProject } from '../../../scripts/workspaces/deriveTypecheckProjects.mjs';

const uiDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(uiDir, 'package.json'));
const { requireContext } = require('expo-router/internal/testing');
const { EXPO_ROUTER_CTX_IGNORE } = require('expo-router/_ctx-shared');
const { getTypedRoutesDeclarationFile } = require('@expo/router-server/build/typed-routes/generate');
const names = ['foundation', 'core', 'source', 'test-components', 'test-other'];

test('UI composed tests resolve the build-owned projector through a declaration boundary', () => {
  const { parsed } = readTypecheckProject(join(uiDir, 'tsconfig.json'));
  const caller = join(uiDir, 'sources/sync/ops/actions/defaultActionExecutor.managedMachine.test.ts');
  const resolved = ts.resolveModuleName('../../../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs',
    caller, parsed.options, ts.sys).resolvedModule;
  assert.ok(resolved, 'the real projector import must resolve');
  assert.equal(resolved.extension, ts.Extension.Dmts,
    'the CLI build script must not become a JavaScript root in a foreign TypeScript project');
});

test('UI partitions own current and explicit test roots once across separate test programs', async t => {
  const packageDir = await mkdtemp(join(tmpdir(), 'happier-ui-partition-'));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const roots = ['src/core.ts', 'sources/components/new.test.ts', 'sources/domain/new.spec.ts', 'examples/authoring.ts'];
  for (const path of roots) {
    await mkdir(dirname(join(packageDir, path)), { recursive: true });
    await writeFile(join(packageDir, path), 'export const value = 1;\n');
  }
  await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts', 'sources/**/*.ts'] }));
  for (const name of ['foundation', 'core', 'source', 'test']) await writeFile(join(packageDir, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: name === 'test' ? ['examples/authoring.ts'] : ['src/core.ts'], include: [],
  }));
  for (const name of ['test-components', 'test-other']) await writeFile(join(packageDir, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.test.json', include: [],
  }));
  const inventory = await deriveUiTypecheckProjects(packageDir);
  assert.deepEqual(inventory.map(item => item.project), ['foundation', 'core', 'source', 'test-components', 'test-other']);
  const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
  for (const path of roots) assert.equal(configs.filter(config => config.files.includes(resolve(packageDir, path))).length, 1, path);
  assert.ok(configs[3].files.includes(resolve(packageDir, 'sources/components/new.test.ts')));
  assert.ok(configs[4].files.includes(resolve(packageDir, 'sources/domain/new.spec.ts')));
  assert.ok(configs[4].files.includes(resolve(packageDir, 'examples/authoring.ts')), 'explicit authoring fixture remains a test root');
});

test('UI compiler preparation keeps configured routes when Expo regenerates its live declaration', async t => {
  const packageDir = await mkdtemp(join(tmpdir(), 'happier-ui-route-preparation-'));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const assertPrivateOutputs = await installUiTypecheckFixtureDependencies(t, packageDir);
  const write = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await write(join(packageDir, 'package.json'), JSON.stringify({ name: 'ui-route-preparation-fixture' }));
  await write(join(packageDir, 'app.json'), JSON.stringify({ expo: {
    name: 'Route preparation', slug: 'route-preparation',
    experiments: { typedRoutes: true }, extra: { router: { root: './src/routes' } },
    plugins: [['expo-router', { root: './src/routes' }]],
  } }));
  // Consume the real exclusion owner, rather than copying its test-file regex.
  await write(join(packageDir, 'metro.config.js'), `module.exports = require(${JSON.stringify(join(uiDir, 'metro.config.js'))});\n`);
  const sourcePaths = ['src/routes/settings/index.tsx', 'src/routes/session/[id].tsx',
    'src/routes/settings/_layout.test.tsx', 'src/routes/settings/_layout.ownership.test.tsx'];
  for (const path of sourcePaths) await write(join(packageDir, path), 'export default function Route() { return null; }\n');
  const declarationPath = join(packageDir, '.expo/types/router.d.ts');
  const bare = getTypedRoutesDeclarationFile(requireContext(join(packageDir, 'src/routes'), true, EXPO_ROUTER_CTX_IGNORE));
  assert.ok(!bare.includes('pathname: `/settings`'), 'the installed bare producer reproduces the empty inventory');
  await write(declarationPath, bare);
  await write(join(packageDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { jsx: 'react-jsx', moduleResolution: 'bundler', module: 'esnext' },
    include: ['src/**/*.tsx', '.expo/types/router.d.ts'],
  }));
  for (const name of names) await write(join(packageDir, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: ['.expo/types/router.d.ts'], include: [],
  }));
  await write(join(packageDir, 'tsconfig.test.json'), JSON.stringify({ extends: './tsconfig.json', files: ['.expo/types/router.d.ts'], include: [] }));
  const inventory = await prepareUiTypecheckProjects(names.map(name => ({ project: `tsconfig.${name}.json` })), packageDir);
  await assertPrivateOutputs(inventory);
  const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
  for (const path of sourcePaths) assert.equal(configs.filter(config => config.files.includes(resolve(packageDir, path))).length, 1, `${path} remains owned once`);
  // Expo's watcher uses this unfiltered context and can publish it after finite
  // preparation. Every actual compiler root must keep the complete route input.
  await write(declarationPath, bare);
  for (const config of configs) {
    const declarations = config.files.filter(path => path.endsWith('/router.d.ts') || path.endsWith('\\router.d.ts'));
    assert.equal(declarations.length, 1, 'each strict partition consumes one route augmentation');
    const declaration = await readFile(declarations[0], 'utf8');
    assert.ok(declaration.includes('pathname: `/settings`'), 'Expo regeneration cannot erase finite compiler routes');
    assert.ok(declaration.includes('pathname: `/session/[id]`'), 'dynamic routes keep their real parameter contract');
    assert.ok(!declaration.includes('/settings/_layout.test'), 'excluded tests never become navigation routes');
  }
  await rm(declarationPath);
  await write(join(packageDir, 'src/routes/settings/added.tsx'), 'export default function Route() { return null; }\n');
  const refreshed = await prepareUiTypecheckProjects(names.map(name => ({ project: `tsconfig.${name}.json` })), packageDir);
  await assertPrivateOutputs(refreshed);
  for (const { configPath } of refreshed) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const routeFile = config.files.find(path => path.endsWith('/router.d.ts') || path.endsWith('\\router.d.ts'));
    assert.ok(routeFile, 'cold compilation does not depend on a live Expo declaration');
    assert.ok((await readFile(routeFile, 'utf8')).includes('pathname: `/settings/added`'), 'the next preparation uses current routes');
  }
});
