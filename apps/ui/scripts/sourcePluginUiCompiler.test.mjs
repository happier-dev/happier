// @happier-test-preparation source
import '../../../packages/cli-common/registerSourceRuntime.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';

test('source Plugin UI compilation succeeds with the SDK dist compiler unavailable', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-source-compiler-' });
  const repoRoot = fixture.path('repo');
  const write = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  await write(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({ name: '@fixture/ui' }));
  await write(join(repoRoot, 'packages/plugin-sdk/package.json'), JSON.stringify({
    name: '@happier-dev/plugin-sdk', exports: { '.': './src/index.ts' },
  }));
  await write(join(repoRoot, 'packages/plugin-sdk/src/index.ts'), 'export const host = true;');
  const projectRoot = join(repoRoot, 'packages/plugins/alpha');
  await write(join(projectRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-alpha', version: '0.0.0', exports: {
      './manifest': './src/manifest.ts',
      './happier-plugin-ui/panel': { 'happier-source': './src/ui.ts' },
    },
  }));
  await write(join(projectRoot, 'src/manifest.ts'), 'export const PLUGIN_MANIFEST = {};');
  await write(join(projectRoot, 'src/ui.ts'),
    'export async function renderSurface() { await Promise.resolve(); return "source-only"; }');
  const manifest = {
    schemaVersion: 2, id: 'happier.alpha', version: '0.0.0', displayName: 'alpha',
    runtime: { apiVersion: 1 }, contributes: { ui: {
      renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }],
      views: [{ id: 'panel', container: 'appPage', target: { kind: 'app' }, renderer: 'panel', title: 'alpha' }],
    } },
  };
  // The module resolver is an OS/runtime boundary. Leave the real compiler,
  // graph discovery, artifact validation and publication beneath it intact.
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes('/packages/plugin-sdk/dist/ui/build/')) {
      throw Object.assign(new Error('Fixture SDK dist compiler is unavailable'), { code: 'ENOENT' });
    }
    return resolved;
  } });
  t.after(() => hook.deregister());
  const { prepareSourcePluginUiArtifacts } = await import('./prepareSourcePluginUiArtifacts.mjs');
  const result = await prepareSourcePluginUiArtifacts({ repoRoot, outputDir: fixture.path('output'),
    plugins: [{ directory: 'alpha', manifest }] });
  assert.deepEqual(result.pluginFailures, []);
  const bundle = await readFile(join(result.artifactRoots.alpha, 'react-native/panel/entry.cjs.bundle'), 'utf8');
  assert.doesNotMatch(bundle, /\basync\s+function\b/u, 'the current compiler lowers async for native guests');
  const module = { exports: {} };
  runInNewContext(bundle, { module, exports: module.exports });
  assert.equal(await module.exports.renderSurface(), 'source-only');
});

test('a relocated copy of a prepared checkout reuses unchanged Plugin UI bundles and recompiles only an edited plugin', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-relocated-reuse-' });
  const write = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  const origin = fixture.path('origin');
  await write(join(origin, 'apps/ui/package.json'), '{}');
  const workspaceNames = ['plugins-alpha', 'plugins-beta'];
  for (const directory of ['alpha', 'beta']) {
    const root = join(origin, 'packages/plugins', directory);
    await write(join(root, 'package.json'), JSON.stringify({
      name: `@happier-dev/plugins-${directory}`, version: '0.0.0', exports: {
        './happier-plugin-ui/account-runtime': { 'happier-source': './src/account.ts' },
      },
    }));
    await write(join(root, 'src/account.ts'), `export function activateAccount() { return "${directory}-ready"; }`);
    await write(join(root, '.happier-plugin/plugin.json'), JSON.stringify({
      schemaVersion: 2, id: `happier.${directory}`, version: '0.0.0', displayName: directory,
      runtime: { apiVersion: 1 }, contributes: { actions: [{
        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
      }] },
    }));
  }
  // The compiler's per-batch outcome line is the owner's observable reuse count.
  const outcomes = [];
  const error = console.error;
  t.after(() => { console.error = error; });
  console.error = (...args) => {
    const line = args.join(' ');
    const match = /phase=plugin-ui-input-reuse .*compiled=(\d+) reused=(\d+)/u.exec(line);
    if (match) outcomes.push({ compiled: Number(match[1]), reused: Number(match[2]) });
    else error(...args);
  };
  const { prepareSourceCliPluginUiArtifacts } = await import('../../cli/scripts/prepareSourcePluginUiArtifacts.mjs');
  await prepareSourceCliPluginUiArtifacts({ repoRoot: origin, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 2, reused: 0 });
  // A snapshot is the same bytes at another checkout path, with the package
  // dists carried and no consumer scratch (.project is never captured).
  const relocated = fixture.path('relocated');
  await cp(origin, relocated, { recursive: true, filter: source => !source.includes(`${join(origin, '.project')}`) });
  await prepareSourceCliPluginUiArtifacts({ repoRoot: relocated, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 0, reused: 2 });
  await write(join(relocated, 'packages/plugins/beta/src/account.ts'),
    'export function activateAccount() { return "beta-edited"; }');
  await prepareSourceCliPluginUiArtifacts({ repoRoot: relocated, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 1, reused: 1 });
  const artifact = JSON.parse(await readFile(join(relocated, 'packages/plugins/beta/dist/happier-plugin-ui/ui-artifacts.json'), 'utf8'));
  const module = { exports: {} };
  runInNewContext(await readFile(join(relocated, 'packages/plugins/beta/dist/happier-plugin-ui', artifact.entries[0].entry), 'utf8'),
    { module, exports: module.exports });
  assert.equal(module.exports.activateAccount(), 'beta-edited');
});

test('source publication into a package dist keeps the compiler\'s exact artifact manifest bytes', async t => {
  // A package build records its dist/happier-plugin-ui outputs by digest. A
  // re-serialized manifest made every later package check report changed
  // outputs and refresh the package, which then recompiled the UI again.
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-exact-manifest-' });
  const repoRoot = fixture.path('repo');
  const root = join(repoRoot, 'packages/plugins/alpha');
  const write = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  await write(join(repoRoot, 'apps/ui/package.json'), '{}');
  await write(join(root, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-alpha', version: '0.0.0', exports: {
      './happier-plugin-ui/account-runtime': { 'happier-source': './src/account.ts' },
    },
  }));
  await write(join(root, 'src/account.ts'), 'export function activateAccount() { return "alpha-ready"; }');
  await write(join(root, '.happier-plugin/plugin.json'), JSON.stringify({
    schemaVersion: 2, id: 'happier.alpha', version: '0.0.0', displayName: 'alpha',
    runtime: { apiVersion: 1 }, contributes: { actions: [{
      id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    }] },
  }));
  const { prepareSourceCliPluginUiArtifacts } = await import('../../cli/scripts/prepareSourcePluginUiArtifacts.mjs');
  await prepareSourceCliPluginUiArtifacts({ repoRoot, workspaceNames: ['plugins-alpha'] });
  const compiled = await readFile(join(repoRoot, '.project/tmp/source-cli-plugin-ui/alpha/happier-plugin-ui/ui-artifacts.json'));
  const published = await readFile(join(root, 'dist/happier-plugin-ui/ui-artifacts.json'));
  assert.equal(published.toString('utf8'), compiled.toString('utf8'));
});

test('the Plugin UI compiler key ignores unrelated lockfile, install-marker and host manifest edits but follows the installed tools it imports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-compiler-key-' });
  const write = async (path, bytes) => {
    await mkdir(dirname(fixture.path(path)), { recursive: true });
    await writeFile(fixture.path(path), bytes);
  };
  await write('packages/plugin-sdk/package.json', JSON.stringify({ name: '@happier-dev/plugin-sdk' }));
  await write('packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts', 'export { tool } from "fixture-tool";');
  await write('node_modules/fixture-tool/package.json', JSON.stringify({ name: 'fixture-tool', version: '1.0.0', main: 'index.js' }));
  await write('node_modules/fixture-tool/index.js', 'exports.tool = "v1";');
  await write('node_modules/esbuild/package.json', JSON.stringify({ name: 'esbuild', version: '0.0.1' }));
  await write('node_modules/.happier-stack-dependencies-ready', JSON.stringify({ identity: 'install-1', inputs: [] }));
  await write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  await write('pnpm-workspace.yaml', 'packages: [apps/*, packages/*]\n');
  for (const app of ['ui', 'cli', 'stack']) await write(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}`, scripts: {} }));
  await write('apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs', 'export const compiler = 1;');
  const { readSourcePluginUiCompilerIdentity } = await import('./prepareSourcePluginUiArtifacts.mjs');
  const key = async () => JSON.stringify((await readSourcePluginUiCompilerIdentity({ compilerRepo: fixture.root })).identity);
  const baseline = await key();
  // A dependency added for an unrelated app rewrites the lockfile, the install
  // marker and host manifests; none of those bytes reach a Plugin UI bundle.
  await write('pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: { apps/server: { dependencies: { unrelated: 1.0.0 } } }\n');
  await write('pnpm-workspace.yaml', 'packages: [apps/*, packages/*]\ncatalog: { unrelated: 1.0.0 }\n');
  await write('node_modules/.happier-stack-dependencies-ready', JSON.stringify({ identity: 'install-2', inputs: [] }));
  for (const app of ['ui', 'cli', 'stack']) await write(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}`, scripts: { added: 'true' } }));
  assert.equal(await key(), baseline, 'unrelated install and host manifest edits keep the compiler key');
  await write('node_modules/fixture-tool/index.js', 'exports.tool = "v2";');
  const toolChanged = await key();
  assert.notEqual(toolChanged, baseline, 'installed bytes the compiler imports are part of the key');
  await write('node_modules/esbuild/package.json', JSON.stringify({ name: 'esbuild', version: '0.0.2' }));
  assert.notEqual(await key(), toolChanged, 'the esbuild version is part of the key');
});

test('an unrelated lockfile edit reuses every Plugin UI, while a changed bundled package recompiles only its importer', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-ui-installed-key-' });
  const repoRoot = fixture.path('repo');
  const write = async (path, bytes) => {
    await mkdir(dirname(join(repoRoot, path)), { recursive: true });
    await writeFile(join(repoRoot, path), bytes);
  };
  await write('apps/ui/package.json', '{}');
  await write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  await write('pnpm-workspace.yaml', 'packages: [apps/*, packages/*, packages/plugins/*]\n');
  await write('node_modules/fixture-lib/package.json', JSON.stringify({ name: 'fixture-lib', version: '1.0.0', main: 'index.js' }));
  await write('node_modules/fixture-lib/index.js', 'exports.libValue = "lib-v1";');
  for (const [directory, source] of [
    ['alpha', 'import { libValue } from "fixture-lib"; export function activateAccount() { return libValue; }'],
    ['beta', 'export function activateAccount() { return "beta-ready"; }'],
  ]) {
    await write(`packages/plugins/${directory}/package.json`, JSON.stringify({
      name: `@happier-dev/plugins-${directory}`, version: '0.0.0', exports: {
        './happier-plugin-ui/account-runtime': { 'happier-source': './src/account.ts' },
      },
    }));
    await write(`packages/plugins/${directory}/src/account.ts`, source);
    await write(`packages/plugins/${directory}/.happier-plugin/plugin.json`, JSON.stringify({
      schemaVersion: 2, id: `happier.${directory}`, version: '0.0.0', displayName: directory,
      runtime: { apiVersion: 1 }, contributes: { actions: [{
        id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
      }] },
    }));
  }
  const outcomes = [];
  const error = console.error;
  t.after(() => { console.error = error; });
  console.error = (...args) => {
    const match = /phase=plugin-ui-input-reuse .*compiled=(\d+) reused=(\d+)/u.exec(args.join(' '));
    if (match) outcomes.push({ compiled: Number(match[1]), reused: Number(match[2]) });
    else error(...args);
  };
  const { prepareSourceCliPluginUiArtifacts } = await import('../../cli/scripts/prepareSourcePluginUiArtifacts.mjs');
  const workspaceNames = ['plugins-alpha', 'plugins-beta'];
  await prepareSourceCliPluginUiArtifacts({ repoRoot, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 2, reused: 0 });
  await write('pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: { apps/server: { dependencies: { unrelated: 1.0.0 } } }\n');
  await write('pnpm-workspace.yaml', 'packages: [apps/*, packages/*, packages/plugins/*]\ncatalog: { unrelated: 1.0.0 }\n');
  await prepareSourceCliPluginUiArtifacts({ repoRoot, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 0, reused: 2 }, 'an unrelated lockfile line recompiles nothing');
  // The bundled package's installed bytes change without any authored edit.
  await write('node_modules/fixture-lib/package.json', JSON.stringify({ name: 'fixture-lib', version: '1.0.1', main: 'index.js' }));
  await write('node_modules/fixture-lib/index.js', 'exports.libValue = "lib-v2";');
  await prepareSourceCliPluginUiArtifacts({ repoRoot, workspaceNames });
  assert.deepEqual(outcomes.at(-1), { compiled: 1, reused: 1 }, 'only the importer of the changed package recompiles');
  const distDir = join(repoRoot, 'packages/plugins/alpha/dist/happier-plugin-ui');
  const artifact = JSON.parse(await readFile(join(distDir, 'ui-artifacts.json'), 'utf8'));
  const module = { exports: {} };
  runInNewContext(await readFile(join(distDir, artifact.entries[0].entry), 'utf8'), { module, exports: module.exports });
  assert.equal(module.exports.activateAccount(), 'lib-v2', 'a changed bundled package is never served from a stale bundle');
});
