import { cp, mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createWorkspaceSourceResolver, readCliSourceEntries, readWorkspacePackages, resolveWorkspaceSource, workspaceSourceCompilerPaths } from '../sourceRuntimeEntries.mjs';

describe('CLI source entry ownership', () => {
  it('links source-only SDK exports before tsx can select stale UI declaration paths', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-source-ui-declarations-'));
    const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    try {
      const common = join(fixture, 'packages/cli-common');
      const ui = join(fixture, 'apps/ui');
      await mkdir(common, { recursive: true });
      await mkdir(ui, { recursive: true });
      for (const name of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'cliRuntimeSidecars.mjs']) {
        await cp(join(repoDir, 'packages/cli-common', name), join(common, name));
      }
      await symlink(join(repoDir, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(ui, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {
        '@happier-dev/plugin-sdk/*': ['../../packages/plugin-sdk/dist/*/index.d.ts'],
      } } }));
      const stale = 'export const stale = true;';
      const sources = [
        ['plugin-sdk', 'sessions', 'SessionInputForgeEvidenceV1Schema'],
        ['plugin-sdk', 'protocol', 'ScmHostingRepositoryIdentityV1ProtocolSchema'],
        ['protocol', 'evidence', 'sourceProtocolEvidence'],
      ];
      for (const directory of ['plugin-sdk', 'protocol']) {
        const root = join(fixture, 'packages', directory);
        const exports = {};
        for (const [, subpath, name] of sources.filter(([owner]) => owner === directory)) {
          await mkdir(join(root, 'src', subpath), { recursive: true });
          await mkdir(join(root, 'dist', subpath), { recursive: true });
          exports[`./${subpath}`] = { 'happier-source': `./src/${subpath}/index.ts`, default: `./dist/${subpath}/index.js` };
          await writeFile(join(root, 'src', subpath, 'index.ts'), `export const ${name} = ${JSON.stringify(name)};`);
          await writeFile(join(root, 'dist', subpath, 'index.d.ts'), 'export declare const stale: boolean;');
          await writeFile(join(root, 'dist', subpath, 'index.js'), stale);
        }
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@happier-dev/${directory}`, type: 'module', exports }));
      }
      const manifest = join(ui, 'manifest.mjs');
      await writeFile(manifest, sources.map(([owner, subpath, name]) => `import { ${name} } from '@happier-dev/${owner}/${subpath}';`).join('\n')
        + `\nexport const evidence = [${sources.map(([, , name]) => name).join(',')}];`);
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--conditions=happier-source', '--import', join(common, 'registerSourceRuntime.mjs'),
        '--input-type=module', '-e', `
import { createRequire } from 'node:module';
const imported = await import(${JSON.stringify(pathToFileURL(manifest).href)});
const required = createRequire(import.meta.url)(${JSON.stringify(manifest)});
console.log(JSON.stringify([imported.evidence, required.evidence]));
`,
      ], { cwd: ui, env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: join(ui, 'tsconfig.json') } });
      const expected = sources.map(([, , name]) => name);
      expect(JSON.parse(stdout)).toEqual([expected, expected]);
      for (const [owner, subpath] of sources) {
        expect(await readFile(join(fixture, 'packages', owner, 'dist', subpath, 'index.js'), 'utf8')).toBe(stale);
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains importer dependencies and conditions across a host dependency relayout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-import-owner-'));
    try {
      const plugin = join(root, 'installed plugin#owner');
      const host = join(root, 'apps/cli');
      const outputRoot = join(root, 'runtime');
      const output = join(outputRoot, 'apps/cli');
      for (const directory of [root, plugin]) {
        const dependency = join(directory, 'node_modules', 'fixture-css');
        await mkdir(dependency, { recursive: true });
        await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-css', type: 'module',
          exports: { import: './index.js', require: './index.cjs' } }));
        const owner = directory === plugin ? 'plugin' : 'host';
        await writeFile(join(dependency, 'index.js'), `export const generate = '${owner}-import';`);
        await writeFile(join(dependency, 'index.cjs'), `module.exports = { generate: '${owner}-require' };`);
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(plugin, 'shape.js'), "import { generate } from 'fixture-css'; export { generate }; export const required = require('fixture-css').generate;");
      await writeFile(join(plugin, 'index.js'), "export async function parse() { const shape = await import('./shape.js'); return [shape.generate, shape.required]; } export async function optional() { return import('fixture-uninstalled'); }");
      const nested = join(host, 'node_modules/fixture-relayout');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'fixture-relayout', type: 'module',
        exports: { import: './index.js', require: './index.cjs' } }));
      await writeFile(join(nested, 'index.js'), "export const value = 'host-import';");
      await writeFile(join(nested, 'index.cjs'), "module.exports = { value: 'host-require' };");
      await writeFile(join(host, 'index.js'), `export { parse, optional } from '../../installed plugin#owner/index.js';
import { value } from 'fixture-relayout';
export const hostValues = [value, require('fixture-relayout').value];
export async function lazyHost() { return (await import('fixture-relayout')).value; }`);
      await mkdir(output, { recursive: true });
      await symlink(join(root, 'node_modules'), join(outputRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(join(host, 'node_modules'), join(output, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await build({ entryPoints: [join(host, 'index.js')], outdir: output, bundle: true,
        splitting: true, format: 'esm', platform: 'node',
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
        plugins: [createWorkspaceSourceResolver({ workspacePackages: new Map(), requireFromProject: createRequire(join(host, 'package.json')) })],
      });
      // Native import observes the emitted graph without Vitest re-resolving it.
      const probe = async () => {
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
const m = await import(${JSON.stringify(pathToFileURL(join(output, 'index.js')).href)});
let missing; try { await m.optional(); } catch (e) { missing = e.code; }
console.log(JSON.stringify({ parsed: await m.parse(), missing, hostValues: m.hostValues, lazyHost: await m.lazyHost() }));
`]);
        expect(JSON.parse(stdout)).toEqual({ parsed: ['plugin-import', 'plugin-require'], missing: 'ERR_MODULE_NOT_FOUND',
          hostValues: ['host-import', 'host-require'], lazyHost: 'host-import' });
      };
      await probe();
      await cp(nested, join(root, 'node_modules/fixture-relayout'), { recursive: true });
      await rm(nested, { recursive: true });
      await probe();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads Stack storage helpers without unrelated Home lifecycle and account schemas', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-storage-imports-'));
    try {
      const loader = join(fixture, 'reject-unrelated-home.mjs');
      await writeFile(loader, `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (/\\/(?:personalHome\\/bootAdmission|auth\\/accountDirectory)\\.(?:js|ts)$/.test(result.url)) {
    throw new Error('Stack storage loaded unrelated Home lifecycle/schema: ' + result.url);
  }
  return result;
}
`);
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--no-warnings', '--experimental-loader', loader,
        '--import', fileURLToPath(new URL('../registerSourceRuntime.mjs', import.meta.url)),
        '--input-type=module', '-e', `
const { applyRuntimeServerDatabaseEnv } = await import(${JSON.stringify(new URL('../../../apps/stack/scripts/utils/server/apply_runtime_server_database_env.mjs', import.meta.url).href)});
const { hasRetainedServerData } = await import(${JSON.stringify(new URL('../../../apps/stack/scripts/utils/dev_targets/retained_server_data.mjs', import.meta.url).href)});
const env = { HAPPIER_SERVER_LIGHT_DATA_DIR: ${JSON.stringify(join(fixture, 'server-data'))} };
applyRuntimeServerDatabaseEnv({ env, serverDir: ${JSON.stringify(fixture)} });
console.log(JSON.stringify({ databaseUrl: env.DATABASE_URL, retained: await hasRetainedServerData(${JSON.stringify(join(fixture, 'missing'))}) }));
`,
      ], { env: { ...process.env, NODE_OPTIONS: '' } });
      const result = JSON.parse(stdout);
      expect(result.databaseUrl).toMatch(/happier-server-light\.sqlite/);
      expect(result.retained).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('loads ESM and CommonJS source tools without indexing the shared tsx disk cache', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-source-cache-'));
    try {
      const marker = join(fixture, 'cache-indexed');
      const observer = join(fixture, 'observe-cache.mjs');
      // Observe the real filesystem boundary without replacing tsx or its transforms.
      await writeFile(observer, `
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const readdirSync = fs.readdirSync;
fs.readdirSync = function(path, ...args) {
  if (basename(String(path)).startsWith('tsx-')) fs.writeFileSync(${JSON.stringify(marker)}, 'indexed');
  return readdirSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
      const esm = join(fixture, 'source.mts');
      const cjs = join(fixture, 'source.cts');
      await writeFile(esm, 'export enum Value { answer = 42 }');
      await writeFile(cjs, 'export enum Value { answer = 43 }');
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--import', observer,
        '--import', fileURLToPath(new URL('../registerSourceRuntime.mjs', import.meta.url)),
        '--input-type=module', '-e', `
import { createRequire } from 'node:module';
const esm = await import(${JSON.stringify(pathToFileURL(esm).href)});
const cjs = createRequire(import.meta.url)(${JSON.stringify(cjs)});
console.log(JSON.stringify([esm.Value.answer, cjs.Value.answer]));
`,
      ], { env: { ...process.env, NODE_OPTIONS: '', TSX_DISABLE_CACHE: '', TMPDIR: fixture, TEMP: fixture, TMP: fixture } });
      expect(JSON.parse(stdout)).toEqual([42, 43]);
      expect(existsSync(marker), 'source-tool bootstrap must not retain the shared cache directory index').toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('selects the declared portable SDK source while preserving Node source ownership', async () => {
    const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const packages = await readWorkspacePackages(repoDir);
    const sdkRoot = join(repoDir, 'packages/plugin-sdk');
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/index.browser.ts'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/contributions', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/contributions/index.browser.ts'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk')).toBe(join(sdkRoot, 'src/index.ts'));
    expect(workspaceSourceCompilerPaths(packages)['@happier-dev/plugin-sdk']).toEqual([join(sdkRoot, 'src/index.ts')]);
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/async', {
      conditions: ['react-native', 'browser'],
    })).toBe(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/async'));
    expect(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/voice/client', {
      conditions: ['react-native', 'browser'],
    })).toBe(join(sdkRoot, 'src/voice/client/index.ts'));
  });

  it('preserves conditional wildcard exports without accepting a built-dist portable branch', () => {
    const root = resolve('fixture-author-root');
    const packages = new Map([['fixture-author', { root, manifest: { exports: {
      './portable/*': {
        browser: { 'happier-source': './src/browser/*.ts', default: './dist/browser/*.js' },
        'happier-source': './src/node/*.ts', default: './dist/node/*.js',
      },
      './published-only': {
        browser: { default: './dist/browser/published.js' },
        'happier-source': './src/node/published.ts',
      },
    } } }]]);
    expect(resolveWorkspaceSource(packages, 'fixture-author/portable/migration', {
      conditions: ['browser'],
    })).toBe(join(root, 'src/browser/migration.ts'));
    expect(resolveWorkspaceSource(packages, 'fixture-author/portable/migration')).toBe(join(root, 'src/node/migration.ts'));
    expect(() => resolveWorkspaceSource(packages, 'fixture-author/published-only', {
      conditions: ['browser'],
    })).toThrow('Source runtime requires an explicit source export');
  });

  it('includes a bundled plugin native worker declared by its package imports', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-plugin-native-entries-'));
    try {
      const cliDir = join(repoDir, 'apps/cli');
      const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
      const pluginDir = join(repoDir, 'packages/plugins/native-worker');
      await mkdir(locatorDir, { recursive: true });
      await mkdir(join(pluginDir, 'src/machine'), { recursive: true });
      await writeFile(join(pluginDir, 'src/index.ts'), 'export const activate = () => {};');
      await writeFile(join(pluginDir, 'src/machine/worker.ts'), 'export const value = 1;');
      await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-native-worker',
        exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } },
        imports: { '#native-worker': { 'happier-source': './src/machine/worker.ts', default: './dist/machine/worker.js' } },
      }));
      await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'),
        `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS = ${JSON.stringify([{
          daemonEntryPath: './.happier-plugin/daemon.js',
          sourceSpec: { locator: '@happier-dev/plugins-native-worker' },
          manifest: { entrypoints: { daemon: './.happier-plugin/daemon.js' }, runtime: {} },
        }])};`);
      const { entries } = await readCliSourceEntries({ repoDir, manifest: {}, transform });
      expect(entries['packages/plugins/native-worker/dist/machine/worker']).toBe(join(pluginDir, 'src/machine/worker.ts'));
      expect(entries['packages/plugins/native-worker/.happier-plugin/daemon']).toBe(join(pluginDir, 'src/index.ts'));
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
