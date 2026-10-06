import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_SDK_PACKAGE_NAME,
  preparePluginSingleFileDevelopmentLoad,
  resolveHostPluginSdkPackageRoot,
} from './hostSdkResolution';

async function writePackagedRuntimeFixture(params: Readonly<{
  root: string;
  declareSdk: boolean;
}>): Promise<string> {
  await mkdir(join(params.root, 'dist', 'plugins'), { recursive: true });
  await writeFile(join(params.root, 'dist', 'plugins', 'entry.js'), 'export {};\n', 'utf8');
  const runtimePackageJson: Record<string, unknown> = {
    name: '@happier-dev/cli',
    dependencies: params.declareSdk ? { [PLUGIN_SDK_PACKAGE_NAME]: '0.0.0' } : {},
    bundledDependencies: params.declareSdk ? [PLUGIN_SDK_PACKAGE_NAME] : [],
  };
  await writeFile(join(params.root, 'package.json'), JSON.stringify(runtimePackageJson), 'utf8');
  const sdkPackageRoot = join(params.root, 'node_modules', '@happier-dev', 'plugin-sdk');
  await mkdir(join(sdkPackageRoot, 'dist', 'manifest'), { recursive: true });
  await mkdir(join(sdkPackageRoot, 'dist', 'host', 'registration'), { recursive: true });
  await writeFile(join(sdkPackageRoot, 'package.json'), JSON.stringify({
    name: PLUGIN_SDK_PACKAGE_NAME,
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    exports: {
      '.': './dist/index.js',
      './manifest': './dist/manifest/index.js',
      './host/registration': './dist/host/registration/index.js',
    },
  }), 'utf8');
  await writeFile(join(sdkPackageRoot, 'dist', 'index.js'), 'export const sdkMarker = \'packaged\';\n', 'utf8');
  await writeFile(join(sdkPackageRoot, 'dist', 'manifest', 'index.js'), 'export const manifestMarker = \'packaged-manifest\';\n', 'utf8');
  await writeFile(join(sdkPackageRoot, 'dist', 'host', 'registration', 'index.js'), 'export const hostMarker = \'private\';\n', 'utf8');
  return sdkPackageRoot;
}

describe('host plugin SDK resolution', () => {
  it.each(['hostSdkResolution.ts', 'typescriptConfigBoundary.ts'])(
    'keeps the TypeScript API unloaded when importing %s before authoring demand',
    async (moduleName) => {
      const moduleUrl = new URL(`./${moduleName}`, import.meta.url).href;
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e',
        `import { createRequire } from 'node:module';
         const require = createRequire(import.meta.url);
         const compilerPath = require.resolve('typescript');
         await import(${JSON.stringify(moduleUrl)});
         console.log(JSON.stringify({ compilerLoaded: Boolean(require.cache[compilerPath]) }));`,
      ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
      expect(JSON.parse(stdout)).toEqual({ compilerLoaded: false });
    },
  );

  it.each([
    ['direct', ['code', 'payload'], 'module'],
    ['runner-snapshot', ['.runner-snapshots', 'runtime'], 'module'],
    ['launched-runner-snapshot', ['.runner-snapshots', 'runtime'], 'launch'],
    ['legacy-runner-snapshot', ['dist', '.runner-snapshots', 'runtime'], 'module'],
  ] as const)('resolves %s bundled packages from shared support with a manifest-free daemon home and cwd', async (_layout, segments, evidence) => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-host-sdk-shared-support-'));
    const root = join(parent, ...segments);
    const supportRoot = join(parent, 'support', 'payload');
    const originalCwd = process.cwd();
    const originalArgv = process.argv;
    try {
      await writePackagedRuntimeFixture({ root, declareSdk: true });
      await mkdir(supportRoot, { recursive: true });
      await rename(join(root, 'node_modules'), join(supportRoot, 'node_modules'));
      await symlink(join(supportRoot, 'node_modules'), join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
      const runtimeModuleUrl = evidence === 'launch'
        ? 'file:///$bunfs/root/chunk.js'
        : pathToFileURL(join(root, 'dist', 'plugins', 'entry.js')).href;
      if (evidence === 'launch') {
        process.argv = [process.execPath, join(root, 'dist', 'index.mjs')];
      }
      vi.stubEnv('HAPPIER_HOME_DIR', parent);
      process.chdir(parent);

      expect(resolveHostPluginSdkPackageRoot({ runtimeModuleUrl })).toBe(
        await realpath(join(supportRoot, 'node_modules', '@happier-dev', 'plugin-sdk')),
      );
    } finally {
      process.chdir(originalCwd);
      process.argv = originalArgv;
      vi.unstubAllEnvs();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects a package symlink escaping the runtime-owned dependency tree', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-host-sdk-package-escape-'));
    const root = join(parent, 'runtime');
    const outsideRoot = join(parent, 'outside');
    try {
      const sdkPackageRoot = await writePackagedRuntimeFixture({ root, declareSdk: true });
      await rename(sdkPackageRoot, outsideRoot);
      await symlink(outsideRoot, sdkPackageRoot, process.platform === 'win32' ? 'junction' : 'dir');
      const runtimeModuleUrl = pathToFileURL(join(root, 'dist', 'plugins', 'entry.js')).href;

      expect(() => resolveHostPluginSdkPackageRoot({ runtimeModuleUrl }))
        .toThrow(/no physical bundled/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('resolves the packaged CLI SDK root and public specifier aliases through the canonical packaged resolver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-host-sdk-packaged-'));
    // The author file lives outside the fixture runtime root so no local SDK
    // copy can win normal resolution; the host alias is the only resolver.
    const authorRoot = await mkdtemp(join(tmpdir(), 'happier-host-sdk-packaged-author-'));
    try {
      const sdkPackageRoot = await writePackagedRuntimeFixture({ root, declareSdk: true });
      const runtimeModuleUrl = pathToFileURL(join(root, 'dist', 'plugins', 'entry.js')).href;

      const resolvedSdkRoot = await realpath(resolveHostPluginSdkPackageRoot({ runtimeModuleUrl }));
      expect(resolvedSdkRoot).toBe(await realpath(sdkPackageRoot));

      const loneEntry = join(authorRoot, 'lone.ts');
      await writeFile(loneEntry, [
        "import { definePlugin } from '@happier-dev/plugin-sdk';",
        "import { defineManifest } from '@happier-dev/plugin-sdk/manifest';",
        'export const manifest = definePlugin({',
        "  id: 'example.packaged-host', version: '0.1.0', displayName: 'Packaged host',",
        "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
        '  hostAccess: { required: [], optional: [] }, contributes: {},',
        '}).manifest;',
        'void defineManifest;',
        '',
      ].join('\n'), 'utf8');

      const aliases = await preparePluginSingleFileDevelopmentLoad(loneEntry, { runtimeModuleUrl });
      expect(aliases[PLUGIN_SDK_PACKAGE_NAME]).toBe(await realpath(join(sdkPackageRoot, 'dist', 'index.js')));
      expect(aliases[`${PLUGIN_SDK_PACKAGE_NAME}/manifest`]).toBe(
        await realpath(join(sdkPackageRoot, 'dist', 'manifest', 'index.js')),
      );
      expect(Object.keys(aliases)).not.toContain(`${PLUGIN_SDK_PACKAGE_NAME}/host/registration`);
    } finally {
      await rm(authorRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the shipped runtime closure does not declare the SDK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-host-sdk-undeclared-'));
    try {
      await writePackagedRuntimeFixture({ root, declareSdk: false });
      const runtimeModuleUrl = pathToFileURL(join(root, 'dist', 'plugins', 'entry.js')).href;
      expect(() => resolveHostPluginSdkPackageRoot({ runtimeModuleUrl }))
        .toThrow(/does not declare its '@happier-dev\/plugin-sdk' runtime dependency/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects host-private SDK subpaths for single-file development', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-host-sdk-private-'));
    try {
      await writePackagedRuntimeFixture({ root, declareSdk: true });
      const runtimeModuleUrl = pathToFileURL(join(root, 'dist', 'plugins', 'entry.js')).href;
      const loneEntry = join(root, 'author', 'lone.ts');
      await mkdir(join(root, 'author'), { recursive: true });
      await writeFile(loneEntry, [
        "import { normalizePluginDaemonDatabaseRuntimeProjection } from '@happier-dev/plugin-sdk/host/registration';",
        'void normalizePluginDaemonDatabaseRuntimeProjection;',
        '',
      ].join('\n'), 'utf8');
      await expect(preparePluginSingleFileDevelopmentLoad(loneEntry, { runtimeModuleUrl }))
        .rejects.toThrow(/host-private plugin SDK module/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns no alias when the entry already resolves a local SDK copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-host-sdk-local-win-'));
    try {
      const loneEntry = join(root, 'lone.ts');
      await writeFile(loneEntry, [
        `import { definePlugin } from '${PLUGIN_SDK_PACKAGE_NAME}';`,
        'void definePlugin;',
        '',
      ].join('\n'), 'utf8');
      const stubPackageRoot = join(root, 'node_modules', '@happier-dev', 'plugin-sdk');
      await mkdir(join(stubPackageRoot, 'dist'), { recursive: true });
      await writeFile(join(stubPackageRoot, 'package.json'), JSON.stringify({
        name: PLUGIN_SDK_PACKAGE_NAME,
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: { '.': './dist/index.js' },
      }), 'utf8');
      await writeFile(join(stubPackageRoot, 'dist', 'index.js'), 'export {};\n', 'utf8');

      const runtimeModuleUrl = pathToFileURL(join(root, 'unused-runtime', 'entry.js')).href;
      await expect(preparePluginSingleFileDevelopmentLoad(loneEntry, { runtimeModuleUrl }))
        .resolves.toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
