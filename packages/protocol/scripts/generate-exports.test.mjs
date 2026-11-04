import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch } from 'node:fs';
import { test, expect } from 'vitest';
import { generateProtocolExports, prepareProtocolExports, watchProtocolExports } from './generate-exports.mjs';
import { readWorkspacePackages, resolveWorkspaceSource } from '../../cli-common/sourceRuntimeEntries.mjs';
import { captureBuildInputFiles } from '../../../scripts/workspaces/buildInputConvergence.mjs';
import { readWorkspaceBuildInputs } from '../../../apps/stack/scripts/utils/fs/workspaceBuildInputs.mjs';

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
      '.': 'index', './catalog': 'catalog/index', './legacy-name': 'newName', './nested/newModule': 'nested/newModule',
    })) {
      expect(manifest.exports[specifier]).toEqual({
        'happier-source': `./src/${source}.ts`, types: `./dist/${source}.d.ts`, default: `./dist/${source}.js`,
      });
    }
    for (const privatePath of sources.slice(4).concat(['ambient'])) {
      expect(manifest.exports[`./${privatePath}`]).toBeUndefined();
    }
    expect(manifest.exports['./import-condition'].import).toBe('./dist/newName.js');
    await mkdir(join(packageRoot, 'dist/nested'), { recursive: true });
    await writeFile(join(packageRoot, 'dist/nested/newModule.js'), 'export const value = 42;\n');
    expect(await runImport('@happier-dev/protocol/nested/newModule', [])).toBe('42');
    await generateProtocolExports({ packageRoot, check: true });
    await writeFile(join(packageRoot, 'src/later.ts'), 'export const value = 43;\n');
    await expect(generateProtocolExports({ packageRoot, check: true })).rejects.toThrow('Protocol exports are stale');
    await generateProtocolExports({ packageRoot });
    expect(await runImport('@happier-dev/protocol/later', ['--experimental-strip-types', '--conditions=happier-source'])).toBe('43');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('published exports match the current compiled public source inventory', async () => {
  await generateProtocolExports({ check: true });
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
  let manifestWatcher;
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
    const published = new Promise((resolve, reject) => {
      manifestWatcher = watch(packageRoot, (_event, filename) => {
        if (filename === 'package.json') { manifestWatcher.close(); resolve(); }
      });
      manifestWatcher.on('error', reject);
    });
    await writeFile(join(packageRoot, 'src/systemSessionMarker.ts'), 'export const value = 43;');
    await published;
    await captureBuildInputFiles({ sourceDir: join(root, 'source'), captureDir,
      readPaths: () => readWorkspaceBuildInputs(packageRoot).map(path => `packages/protocol/${path}`),
    });
    const packages = await readWorkspacePackages(captureDir);
    const target = resolveWorkspaceSource(packages, '@happier-dev/protocol/systemSessionMarker');
    expect(target).toBe(join(captureDir, 'packages/protocol/src/systemSessionMarker.ts'));
    const manifest = JSON.parse(await readFile(join(captureDir, 'packages/protocol/package.json'), 'utf8'));
    expect(manifest.exports['./systemSessionMarker']['happier-source']).toBe('./src/systemSessionMarker.ts');
    expect(await readFile(join(captureDir, 'packages/protocol/package.json'), 'utf8'))
      .toBe(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const imported = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types', '--conditions=happier-source', '--input-type=module', '-e',
      'import { value } from "@happier-dev/protocol/systemSessionMarker"; console.log(value);',
    ], { cwd: join(captureDir, 'packages/protocol'), env: { ...process.env, NODE_OPTIONS: '' } });
    expect(imported.stdout.trim()).toBe('43');
  } finally {
    manifestWatcher?.close();
    await developmentWatcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});
