import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from 'vitest';
import { createServer } from 'vite';
import exportMatch from '../../cli-common/packageExportMatch.cjs';
import { generateProtocolExports, prepareProtocolExports, watchProtocolExports } from './generate-exports.mjs';
import { readWorkspacePackages, resolveWorkspaceSource } from '../../cli-common/sourceRuntimeEntries.mjs';
import { captureBuildInputFiles } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';
import { withPatchedProcessEnv } from '../../../apps/stack/scripts/testkit/core/env_scope.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';

const { matchPackageExport, substitutePackageExportTarget } = exportMatch;

test('publishes newly added source subpaths without hand-editing the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'protocol-derived-exports-'));
  const packageRoot = join(root, 'packages/protocol');
  try {
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/protocol', type: 'module', exports: {},
    }));
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    }));
    await writeFile(join(packageRoot, 'export-aliases.json'), JSON.stringify({
      '.': './src/index.ts', './catalog': './src/catalog/index.ts',
      './legacy-name': './src/newName.ts',
      './import-condition': {
        'happier-source': './src/newName.ts', types: './dist/newName.d.ts',
        import: './dist/newName.js', default: './dist/newName.js',
      },
    }));
    const sources = ['index', 'catalog/index', 'newName', 'nested/newModule',
      'nested/newModule.test', 'nested/newModule.testkit', 'test/setup', 'fixtures/sample'];
    for (const source of sources) {
      const file = join(packageRoot, `src/${source}.ts`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'export const value = 42;\n');
    }
    // Real declaration-only inputs must not acquire nonexistent runtime targets.
    await writeFile(join(packageRoot, 'src/ambient.d.ts'), 'declare const ambient: unknown;\n');
    await generateProtocolExports({ packageRoot });
    const runImport = async (specifier, conditions) => {
      const { stdout } = await promisify(execFile)(process.execPath, [
        ...conditions, '--input-type=module', '-e',
        `const { value } = await import(${JSON.stringify(specifier)}); console.log(value);`,
      ], { cwd: packageRoot, env: { ...process.env, NODE_OPTIONS: '' } });
      return stdout.trim();
    };
    expect(await runImport('@happier-dev/protocol/nested/newModule', ['--experimental-strip-types', '--conditions=happier-source'])).toBe('42');
    await expect(runImport('@happier-dev/protocol/test/setup', ['--experimental-strip-types', '--conditions=happier-source']))
      .rejects.toThrow('ERR_PACKAGE_PATH_NOT_EXPORTED');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    for (const [specifier, source] of Object.entries({
      '.': 'index', './catalog': 'catalog/index', './legacy-name': 'newName', './*': '*',
    })) {
      expect(manifest.exports[specifier]).toEqual({
        'happier-source': `./src/${source}.ts`, types: `./dist/${source}.d.ts`, default: `./dist/${source}.js`,
      });
    }
    // Public modules are published by one pattern; the map stays small (Node re-reads it per loaded file).
    expect(Object.keys(manifest.exports).length).toBeLessThan(sources.length + 8);
    for (const privatePath of sources.slice(4)) {
      await expect(runImport(`@happier-dev/protocol/${privatePath}`, ['--experimental-strip-types', '--conditions=happier-source']))
        .rejects.toThrow('ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
    expect(manifest.exports['./import-condition'].import).toBe('./dist/newName.js');
    await mkdir(join(packageRoot, 'dist/nested'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/nested/newModule.js'), 'export const value = 42;\n');
    expect(await runImport('@happier-dev/protocol/nested/newModule', [])).toBe('42');
    await generateProtocolExports({ packageRoot, check: true });
    await writeFile(join(packageRoot, 'src/later.ts'), 'export const value = 43;\n');
    await generateProtocolExports({ packageRoot, check: true });
    expect(await runImport('@happier-dev/protocol/later', ['--experimental-strip-types', '--conditions=happier-source'])).toBe('43');
    await mkdir(join(packageRoot, 'src/fixtures'), { recursive: true });
    await writeFile(join(packageRoot, 'src/fixtures/later.ts'), 'export const value = 44;\n');
    await expect(generateProtocolExports({ packageRoot, check: true })).rejects.toThrow('Protocol exports are stale');
    await generateProtocolExports({ packageRoot });
    await expect(runImport('@happier-dev/protocol/fixtures/later', ['--experimental-strip-types', '--conditions=happier-source']))
      .rejects.toThrow('ERR_PACKAGE_PATH_NOT_EXPORTED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Vite 7 (resolve.exports 2.0.3) builds an unescaped RegExp from each pattern key,
// so a key such as `./*.d` reads as "any subpath ending in d". The generated map
// must resolve the same public and private sets under Vite as under Node.
test('Vite and Node resolve the same public and private subpaths through the generated map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'protocol-vite-exports-'));
  const packageRoot = join(root, 'packages/protocol');
  let server;
  try {
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: {} }));
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
      include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    }));
    await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
    const publicSources = ['plugins/actions/qualifiedActionId', 'system/tasks/spec', 'nested/latest'];
    const privateSources = ['nested/latest.test', 'nested/helper.spec', 'nested/helper.testkit', 'nested/types.test-d', 'fixtures/sample'];
    for (const source of [...publicSources, ...privateSources]) {
      await mkdir(dirname(join(packageRoot, `src/${source}.ts`)), { recursive: true });
      await writeFile(join(packageRoot, `src/${source}.ts`), 'export const value = 42;\n');
    }
    await generateProtocolExports({ packageRoot });
    const { exports } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const nodeTarget = subpath => {
      const match = matchPackageExport(exports, subpath);
      return match?.declaration ? substitutePackageExportTarget(match.declaration['happier-source'], match.replacement) : null;
    };
    await mkdir(join(root, 'node_modules/@happier-dev'), { recursive: true });
    await symlink(packageRoot, join(root, 'node_modules/@happier-dev/protocol'), 'junction');
    await writeFile(join(root, 'importer.ts'), '');
    server = await createServer({
      root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, ws: false },
      optimizeDeps: { noDiscovery: true }, resolve: { conditions: ['happier-source'] },
      ssr: { resolve: { conditions: ['happier-source'] } },
    });
    const realPackageRoot = await realpath(packageRoot);
    const viteTarget = async subpath => {
      try {
        const resolved = await server.environments.ssr.pluginContainer.resolveId(
          `@happier-dev/protocol/${subpath.slice(2)}`, join(root, 'importer.ts'));
        return resolved ? `./${relative(realPackageRoot, resolved.id).replaceAll('\\', '/')}` : null;
      } catch (error) {
        if (String(error?.message).includes('Missing "')) return null;
        throw error;
      }
    };
    const expected = Object.fromEntries([...publicSources, ...privateSources]
      .map(source => [source, publicSources.includes(source) ? `./src/${source}.ts` : null]));
    const observe = async read => Object.fromEntries(await Promise.all(Object.keys(expected)
      .map(async source => [source, await read(`./${source}`)])));
    expect({ node: await observe(nodeTarget), vite: await observe(viteTarget) }).toEqual({ node: expected, vite: expected });
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('published exports match the current compiled public source inventory', async () => {
  await generateProtocolExports({ check: true });
});

test('local preparation publishes once for concurrent callers and leaves current manifests untouched', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'protocol-preparation-'));
  // Model authoring preparation, before native compiler admission. The outer
  // test reader is admitted; inheriting that marker would forbid lock waits.
  const restoreEnv = withPatchedProcessEnv(null, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined });
  try {
    await mkdir(join(packageRoot, 'src'));
    const sideEffects = ['./src/zodRuntimePolicy.ts', './dist/zodRuntimePolicy.js'];
    const manifestPath = join(packageRoot, 'package.json');
    await writeFile(manifestPath, JSON.stringify({ name: '@happier-dev/protocol', sideEffects, exports: {} }));
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
    await writeFile(join(packageRoot, 'src/added.ts'), 'export const value = 1;');
    const preparations = await Promise.allSettled(Array.from({ length: 2 }, () => prepareProtocolExports({ packageRoot, env: {} })));
    for (const preparation of preparations) {
      if (preparation.status === 'rejected') throw preparation.reason;
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.exports['./*'].default).toBe('./dist/*.js');
    expect(manifest.sideEffects).toEqual(sideEffects);
    const marker = new Date('2020-01-01T00:00:00Z');
    await utimes(manifestPath, marker, marker);
    await withWorkspaceBundleLock(async () => {
      const restoreAdmittedEnv = withPatchedProcessEnv(null, {
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0',
      });
      try {
        await prepareProtocolExports({ packageRoot, env: {} });
        expect((await stat(manifestPath)).mtimeMs).toBe(marker.getTime());
        await mkdir(join(packageRoot, 'src/fixtures'), { recursive: true });
        await writeFile(join(packageRoot, 'src/fixtures/later.ts'), 'export const later = 2;');
        await expect(prepareProtocolExports({ packageRoot, env: {} }))
          .rejects.toMatchObject({ code: 'EWORKSPACEBUNDLELOCKBUSY' });
      } finally {
        restoreAdmittedEnv();
      }
    }, { lockPath: resolveWorkspacePackageBuildLockPath(packageRoot, { name: '@happier-dev/protocol' }) });
    await prepareProtocolExports({ packageRoot, env: {} });
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).exports['./fixtures/later']).toBeNull();
    await generateProtocolExports({ packageRoot, check: true });
  } finally {
    restoreEnv();
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test.each([
  { env: { CI: 'true' } },
  { env: { HAPPIER_DEV_TARGET_EXECUTION: '1' } },
  { env: { npm_lifecycle_event: 'prepack' } },
  { env: { npm_lifecycle_event: 'publish' } },
  { env: {}, publicationMode: 'artifact' },
])('CI and publication preparation verifies stale maps without writing: %j', async context => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'protocol-verification-'));
  try {
    await mkdir(join(packageRoot, 'src'));
    const manifestPath = join(packageRoot, 'package.json');
    const original = JSON.stringify({ name: '@happier-dev/protocol', exports: {} });
    await writeFile(manifestPath, original);
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
    await writeFile(join(packageRoot, 'src/added.ts'), 'export const value = 1;');
    await expect(prepareProtocolExports({ packageRoot, ...context })).rejects.toThrow('Protocol exports are stale');
    expect(await readFile(manifestPath, 'utf8')).toBe(original);
    await generateProtocolExports({ packageRoot });
    await prepareProtocolExports({ packageRoot, ...context });
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('the development watcher publishes a new leaf before tooling-free workspace capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'protocol-captured-exports-'));
  const packageRoot = join(root, 'source/packages/protocol');
  const captureDir = join(root, 'capture');
  let developmentWatcher;
  try {
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await mkdir(join(packageRoot, 'scripts'));
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/protocol', type: 'module', exports: {},
    }));
    await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    await writeFile(join(packageRoot, 'export-aliases.json'), '{".":"./src/index.ts"}');
    await writeFile(join(packageRoot, 'src/index.ts'), 'export const value = 1;');
    // Source preparation must consume committed exports without importing tooling.
    await writeFile(join(packageRoot, 'scripts/generate-exports.mjs'),
      'throw new Error("Runtime preparation imported the export generator");');
    developmentWatcher = await watchProtocolExports({ packageRoot });
    // The pattern map published at watcher start already covers a new public leaf.
    await writeFile(join(packageRoot, 'src/systemSessionMarker.ts'), 'export const value = 43;');
    await captureBuildInputFiles({ sourceDir: join(root, 'source'), captureDir,
      readPaths: () => readWorkspaceBuildInputs(packageRoot).map(path => `packages/protocol/${path}`),
    });
    const packages = await readWorkspacePackages(captureDir);
    const target = resolveWorkspaceSource(packages, '@happier-dev/protocol/systemSessionMarker');
    expect(target).toBe(join(captureDir, 'packages/protocol/src/systemSessionMarker.ts'));
    const manifest = JSON.parse(await readFile(join(captureDir, 'packages/protocol/package.json'), 'utf8'));
    expect(manifest.exports['./*']['happier-source']).toBe('./src/*.ts');
    expect(await readFile(join(captureDir, 'packages/protocol/package.json'), 'utf8'))
      .toBe(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const imported = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types', '--conditions=happier-source', '--input-type=module', '-e',
      'import { value } from "@happier-dev/protocol/systemSessionMarker"; console.log(value);',
    ], { cwd: join(captureDir, 'packages/protocol'), env: { ...process.env, NODE_OPTIONS: '' } });
    expect(imported.stdout.trim()).toBe('43');
  } finally {
    await developmentWatcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});
