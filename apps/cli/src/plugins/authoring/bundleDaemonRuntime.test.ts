import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { build as EsbuildBuild } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2, type PluginManifestV2 } from '@happier-dev/protocol';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';

import {
  bundlePluginDaemonRuntime as bundlePluginDaemonRuntimeImplementation,
  stagePluginDaemonRuntime as stagePluginDaemonRuntimeImplementation,
  PluginAuthorBundlerUnavailableError,
  regularFilesMayAlias,
  resolvePluginAuthorBundlerMainPath,
} from './bundleDaemonRuntime';
import { PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH } from './daemonOutputManifest';
import { evaluatePluginAuthorSource } from './sourceModule';

const execFileAsync = promisify(execFile);
const fixtureEsbuildDynamicRequireError = "throw Error('Dynamic require of \"' + x + '\" is not supported');";
const publicAuthoringSourceRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk/examples/public-authoring',
  import.meta.url,
));
const canonicalPluginSdkRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-sdk',
  import.meta.url,
));
const canonicalPluginProtocolRoot = fileURLToPath(new URL(
  '../../../../../packages/protocol',
  import.meta.url,
));
const canonicalPluginAgentsRoot = fileURLToPath(new URL(
  '../../../../../packages/agents',
  import.meta.url,
));
const canonicalPluginCliCommonRoot = fileURLToPath(new URL(
  '../../../../../packages/cli-common',
  import.meta.url,
));
const canonicalPluginUiRoot = fileURLToPath(new URL(
  '../../../../../packages/plugin-ui',
  import.meta.url,
));

async function linkCanonicalPublicRuntimePackages(projectRoot: string): Promise<void> {
  const scopeRoot = join(projectRoot, 'node_modules', '@happier-dev');
  await mkdir(scopeRoot, { recursive: true });
  for (const [packageName, packageRoot] of [
    ['protocol', canonicalPluginProtocolRoot],
    ['agents', canonicalPluginAgentsRoot],
    ['cli-common', canonicalPluginCliCommonRoot],
    ['plugin-ui', canonicalPluginUiRoot],
  ] as const) {
    await symlink(
      packageRoot,
      join(scopeRoot, packageName),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const sdkRoot = join(scopeRoot, 'plugin-sdk');
  await mkdir(sdkRoot, { recursive: true });
  const sdkPackageJson = JSON.parse(
    await readFile(join(canonicalPluginSdkRoot, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const rewriteSourceExport = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replace('./dist/', './src/')
        .replace(/\.js$/u, '.ts');
    }
    if (Array.isArray(value)) return value.map(rewriteSourceExport);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      rewriteSourceExport(child),
    ]));
  };
  sdkPackageJson.main = './src/index.ts';
  sdkPackageJson.types = './src/index.ts';
  sdkPackageJson.exports = rewriteSourceExport(sdkPackageJson.exports);
  await writeFile(join(sdkRoot, 'package.json'), `${JSON.stringify(sdkPackageJson)}\n`, 'utf8');
  await cp(join(canonicalPluginSdkRoot, 'src'), join(sdkRoot, 'src'), { recursive: true });
}

function fixtureEsbuildDynamicRequireHelper(
  helperName = '__require',
  errorStatement = fixtureEsbuildDynamicRequireError,
): string {
  return [
    `var ${helperName} = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {`,
    '  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]',
    '}) : x)(function(x) {',
    '  if (typeof require !== "undefined") return require.apply(this, arguments);',
    `  ${errorStatement}`,
    '});',
  ].join('\n');
}

function fakeEsbuildOutput(params: Readonly<{
  sourceRoot: string;
  outputPath: string;
  contents: string;
}>): typeof EsbuildBuild {
  return async () => {
    await writeFile(params.outputPath, params.contents, 'utf8');
    const outputKey = relative(params.sourceRoot, params.outputPath).replaceAll('\\', '/');
    return {
      errors: [],
      warnings: [],
      outputFiles: [],
      mangleCache: {},
      metafile: {
        inputs: {
          'index.ts': { bytes: 0, imports: [], format: 'esm' },
        },
        outputs: {
          [outputKey]: {
            bytes: Buffer.byteLength(params.contents),
            inputs: { 'index.ts': { bytesInOutput: 0 } },
            imports: [],
            exports: [],
            entryPoint: 'index.ts',
          },
        },
      },
    };
  };
}

async function bundlePluginDaemonRuntime(
  projectRoot: string,
  ...rest: Parameters<typeof bundlePluginDaemonRuntimeImplementation> extends readonly [string, ...infer Tail]
    ? Tail
    : never
): ReturnType<typeof bundlePluginDaemonRuntimeImplementation> {
  const packageJsonPath = join(projectRoot, 'package.json');
  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  if (packageJson.type === undefined) {
    await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, type: 'module' }), 'utf8');
  }
  const manifest = JSON.parse(
    await readFile(join(projectRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
  ) as Readonly<{ entrypoints?: Readonly<{ development?: string }> }>;
  const development = manifest.entrypoints?.development?.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (development) {
    const sourcePath = join(projectRoot, ...development.split('/'));
    const source = await readFile(sourcePath, 'utf8');
    if (!source.includes('export const manifest')) {
      await writeFile(sourcePath, `export const manifest = ${JSON.stringify(manifest)};\n${source}`, 'utf8');
    }
  }
  return await bundlePluginDaemonRuntimeImplementation(projectRoot, ...rest);
}

async function stagePluginDaemonRuntime(
  ...args: Parameters<typeof stagePluginDaemonRuntimeImplementation>
): ReturnType<typeof stagePluginDaemonRuntimeImplementation> {
  const packageJsonPath = join(args[0].sourceRootPath, 'package.json');
  let packageJson: Record<string, unknown> = {};
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  if (packageJson.type === undefined) {
    await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, type: 'module' }), 'utf8');
  }
  return await stagePluginDaemonRuntimeImplementation(...args);
}

const fixtureNativePackageName = '@esbuild/fixture-native';
const fixtureEsbuildVersion = '0.27.2';

async function writeFixtureEsbuildPackage(params: Readonly<{
  runtimeRoot: string;
  packageNodeModulesRoot?: string;
  nativePackageRoot?: string;
  version?: string;
}>): Promise<string> {
  const version = params.version ?? fixtureEsbuildVersion;
  const esbuildPackageRoot = join(
    params.packageNodeModulesRoot ?? params.runtimeRoot,
    'node_modules',
    'esbuild',
  );
  const esbuildMainPath = join(esbuildPackageRoot, 'lib', 'main.js');
  const nativePackageRoot = join(
    params.nativePackageRoot ?? params.runtimeRoot,
    'node_modules',
    ...fixtureNativePackageName.split('/'),
  );
  const nativeBinaryPath = join(
    nativePackageRoot,
    ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']),
  );
  await mkdir(join(esbuildPackageRoot, 'lib'), { recursive: true });
  await mkdir(join(nativeBinaryPath, '..'), { recursive: true });
  await writeFile(join(esbuildPackageRoot, 'package.json'), JSON.stringify({
    name: 'esbuild',
    version,
    main: 'lib/main.js',
    optionalDependencies: { [fixtureNativePackageName]: version },
  }), 'utf8');
  await writeFile(esbuildMainPath, 'module.exports = {};\n', 'utf8');
  await writeFile(join(nativePackageRoot, 'package.json'), JSON.stringify({
    name: fixtureNativePackageName,
    version,
    os: [process.platform],
    cpu: [process.arch],
  }), 'utf8');
  await writeFile(nativeBinaryPath, 'fixture native binary\n', { mode: 0o755 });
  return esbuildMainPath;
}

describe('bundlePluginDaemonRuntime', () => {
  it('pins the CLI esbuild dependency to the dynamic-require helper source contract', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ dependencies?: Readonly<Record<string, unknown>> }>;

    expect(packageJson.dependencies?.esbuild).toBe(fixtureEsbuildVersion);
  });

  it('resolves esbuild only from an exact physical packaged-runtime root', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-runtime-'));
    const esbuildMainPath = await writeFixtureEsbuildPackage({ runtimeRoot });

    try {
      expect(resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toBe(await realpath(esbuildMainPath));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('resolves a declared physical dependency from the same scoped npm install tree', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-npm-install-'));
    const runtimeRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
    const esbuildMainPath = await writeFixtureEsbuildPackage({
      runtimeRoot,
      packageNodeModulesRoot: installRoot,
      nativePackageRoot: installRoot,
    });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      dependencies: { esbuild: `^${fixtureEsbuildVersion}` },
    }), 'utf8');

    try {
      expect(resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toBe(await realpath(esbuildMainPath));
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it('accepts a same-install esbuild package symlink whose physical target remains inside node_modules', async ({ skip }) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-npm-install-alias-'));
    const runtimeRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
    const storedPackageRoot = join(installRoot, 'node_modules', '.store');
    const esbuildMainPath = await writeFixtureEsbuildPackage({
      runtimeRoot,
      packageNodeModulesRoot: storedPackageRoot,
      nativePackageRoot: storedPackageRoot,
    });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      dependencies: { esbuild: `^${fixtureEsbuildVersion}` },
    }), 'utf8');

    try {
      try {
        await symlink(
          join(storedPackageRoot, 'node_modules', 'esbuild'),
          join(installRoot, 'node_modules', 'esbuild'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      expect(resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toBe(await realpath(esbuildMainPath));
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it('rejects a same-install esbuild patch release that could emit another helper shape', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-npm-install-helper-shape-'));
    const runtimeRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
    await writeFixtureEsbuildPackage({
      runtimeRoot,
      packageNodeModulesRoot: installRoot,
      nativePackageRoot: installRoot,
      version: '0.27.3',
    });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      dependencies: { esbuild: `^${fixtureEsbuildVersion}` },
    }), 'utf8');

    try {
      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(PluginAuthorBundlerUnavailableError);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['undeclared', {}],
    ['outside the declared range', { esbuild: '^2.0.0' }],
  ] as const)('rejects a same-install dependency that is %s', async (_label, dependencies) => {
    const installRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-npm-install-invalid-'));
    const runtimeRoot = join(installRoot, 'node_modules', '@happier-dev', 'cli');
    await writeFixtureEsbuildPackage({
      runtimeRoot,
      packageNodeModulesRoot: installRoot,
      nativePackageRoot: installRoot,
    });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      dependencies,
    }), 'utf8');

    try {
      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(PluginAuthorBundlerUnavailableError);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it('rejects an esbuild main symlink that escapes the packaged runtime root', async ({ skip }) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-runtime-escape-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-outside-'));
    const esbuildLibDir = join(runtimeRoot, 'node_modules', 'esbuild', 'lib');
    const outsideMainPath = join(outsideRoot, 'main.js');
    await mkdir(esbuildLibDir, { recursive: true });
    await writeFile(outsideMainPath, 'module.exports = {};\n', 'utf8');
    try {
      try {
        await symlink(outsideMainPath, join(esbuildLibDir, 'main.js'), 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('file symlinks are unavailable on this host');
          return;
        }
        throw error;
      }

      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(/physical packaged runtime dependency is unavailable/u);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('typed-fails for an invalid authoritative runtime instead of resolving an ambient ancestor install', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-ambient-'));
    const runtimeRoot = join(parentRoot, 'runtime');
    const ambientPackageRoot = join(parentRoot, 'node_modules', 'esbuild');
    const packagedPackageRoot = join(runtimeRoot, 'node_modules', 'esbuild');
    await mkdir(join(ambientPackageRoot, 'lib'), { recursive: true });
    await mkdir(join(packagedPackageRoot, 'lib'), { recursive: true });
    await writeFile(join(ambientPackageRoot, 'package.json'), JSON.stringify({
      name: 'esbuild',
      main: 'lib/main.js',
    }), 'utf8');
    await writeFile(join(ambientPackageRoot, 'lib', 'main.js'), 'module.exports = {};\n', 'utf8');
    await writeFile(join(packagedPackageRoot, 'package.json'), JSON.stringify({
      name: 'not-esbuild',
      main: 'lib/main.js',
    }), 'utf8');
    await writeFile(join(packagedPackageRoot, 'lib', 'main.js'), 'module.exports = {};\n', 'utf8');

    try {
      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(PluginAuthorBundlerUnavailableError);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('typed-fails before loading esbuild when only an ambient ancestor native package exists', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-native-ambient-'));
    const runtimeRoot = join(parentRoot, 'runtime');
    await writeFixtureEsbuildPackage({
      runtimeRoot,
      nativePackageRoot: parentRoot,
    });

    try {
      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(PluginAuthorBundlerUnavailableError);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('accepts a multi-link esbuild main file when its installed path remains contained', async ({ skip }) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-runtime-hardlink-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-runtime-hardlink-outside-'));
    const esbuildMainPath = await writeFixtureEsbuildPackage({ runtimeRoot });
    const outsideMainPath = join(outsideRoot, 'main.js');
    await writeFile(outsideMainPath, 'module.exports = {};\n', 'utf8');

    try {
      await rm(esbuildMainPath);
      try {
        await link(outsideMainPath, esbuildMainPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (
          code === 'EPERM'
          || code === 'EACCES'
          || code === 'ENOTSUP'
          || code === 'ENOSYS'
          || code === 'EXDEV'
        ) {
          skip('hard links are unavailable on this host filesystem');
          return;
        }
        throw error;
      }

      expect(resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toBe(await realpath(esbuildMainPath));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('accepts a declared native package that includes the current os and cpu', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-native-platform-'));
    const esbuildMainPath = await writeFixtureEsbuildPackage({ runtimeRoot });
    const nativePackageRoot = join(runtimeRoot, 'node_modules', ...fixtureNativePackageName.split('/'));
    await writeFile(join(nativePackageRoot, 'package.json'), JSON.stringify({
      name: fixtureNativePackageName,
      version: fixtureEsbuildVersion,
      os: [process.platform, process.platform === 'linux' ? 'darwin' : 'linux'],
      cpu: [process.arch, process.arch === 'x64' ? 'arm64' : 'x64'],
    }), 'utf8');

    try {
      expect(resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toBe(await realpath(esbuildMainPath));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['os', { os: ['unsupported-os'], cpu: [process.arch] }],
    ['cpu', { os: [process.platform], cpu: ['unsupported-cpu'] }],
  ] as const)('rejects a native optional package that does not support the current %s', async (_label, platform) => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundler-native-mismatch-'));
    await writeFixtureEsbuildPackage({ runtimeRoot });
    const nativePackageRoot = join(runtimeRoot, 'node_modules', ...fixtureNativePackageName.split('/'));
    await writeFile(join(nativePackageRoot, 'package.json'), JSON.stringify({
      name: fixtureNativePackageName,
      version: fixtureEsbuildVersion,
      ...platform,
    }), 'utf8');

    try {
      expect(() => resolvePluginAuthorBundlerMainPath({
        runtimeAuthority: { root: runtimeRoot, provenance: 'packaged-launch' },
      })).toThrow(PluginAuthorBundlerUnavailableError);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('fails closed only for ambiguous multi-link file identities', () => {
    expect(regularFilesMayAlias({
      sourcePath: '/project/src/index.js',
      sourceIdentity: { dev: 0, ino: 101, nlink: 2 },
      outputPath: '/project/dist/index.js',
      outputIdentity: { dev: 0, ino: 202, nlink: 2 },
    })).toBe(true);
    expect(regularFilesMayAlias({
      sourcePath: '/project/src/index.js',
      sourceIdentity: { dev: 0, ino: 101, nlink: 1 },
      outputPath: '/project/dist/index.js',
      outputIdentity: { dev: 0, ino: 202, nlink: 1 },
    })).toBe(false);
  });

  it('re-evaluates a preloaded ambient ESBUILD_BINARY_PATH override and restores it after bundling', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-env-'));
    const fakeBinaryPath = join(projectRoot, 'ambient-esbuild');
    const previousOverride = process.env.ESBUILD_BINARY_PATH;
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-env',
      version: '1.0.0',
      displayName: 'Bundle Environment Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(fakeBinaryPath, 'not a native executable\n', { mode: 0o755 });
    process.env.ESBUILD_BINARY_PATH = fakeBinaryPath;
    const mainPath = resolvePluginAuthorBundlerMainPath();
    const requireFromBundler = createRequire(mainPath);
    delete requireFromBundler.cache[mainPath];
    requireFromBundler(mainPath);

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).resolves.toBeUndefined();
      expect(process.env.ESBUILD_BINARY_PATH).toBe(fakeBinaryPath);
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('activate');
    } finally {
      if (previousOverride === undefined) {
        delete process.env.ESBUILD_BINARY_PATH;
      } else {
        process.env.ESBUILD_BINARY_PATH = previousOverride;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses the same portable Windows-separator entrypoint contract as the development loop', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-portable-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'dist'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-portable',
      version: '1.0.0',
      displayName: 'Bundle Portable Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: '.\\src\\index.ts', daemon: '.\\dist\\index.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(projectRoot, 'dist', 'index.js'), 'stale output\n', 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).resolves.toBeUndefined();
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('activate');
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.not.toContain('stale output');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses the current TypeScript manifest when the generated JSON artifact is stale and malformed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-source-owner-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), '{ stale malformed json', 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      'export const manifest = {',
      "  schemaVersion: 2, id: 'acme.source-owner', version: '1.0.0',",
      "  displayName: 'Source owner', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
      "  entrypoints: { daemon: './dist/source-owned.js' }, hostAccess: { required: [], optional: [] },",
      '  contributes: {},',
      '};',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(bundlePluginDaemonRuntimeImplementation(projectRoot)).resolves.toBeUndefined();
      await expect(readFile(join(projectRoot, 'dist', 'source-owned.js'), 'utf8'))
        .resolves.toContain('activate');
      await expect(readFile(
        join(projectRoot, PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH),
        'utf8',
      )).resolves.toMatch(/dist\/source-owned\.js/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('builds the current public-authoring source into its declared daemon entry and activates its declared runtimes', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-public-authoring-stage-'));
    const projectRoot = join(parentRoot, 'public-authoring');
    try {
      await cp(publicAuthoringSourceRoot, projectRoot, { recursive: true });
      await linkCanonicalPublicRuntimePackages(projectRoot);

      const evaluated = await evaluatePluginAuthorSource({ locator: projectRoot });
      await bundlePluginDaemonRuntimeImplementation(projectRoot);

      const daemonPath = join(projectRoot, 'dist', 'daemon.js');
      await execFileAsync(process.execPath, [
        '--test',
        'test/index.test.mjs',
      ], { cwd: projectRoot });

      const generatedManifestPath = join(projectRoot, '.happier-plugin', 'plugin.json');
      await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
      await writeFile(generatedManifestPath, evaluated.canonicalManifestJson, 'utf8');
      const daemonModuleLoaded = await import(`${pathToFileURL(daemonPath).href}?public-authoring-stage`);
      const daemonModule = daemonModuleLoaded as Readonly<{
          manifest: unknown;
          activate(api: unknown): Promise<void>;
          reviewAgentRunnerFactory: Readonly<{
            module: string;
            export: string;
            runtimeApiVersion: number;
          }>;
        }>;
      const registered = Object.freeze({
        actions: [] as string[],
        agents: [] as string[],
        hooks: [] as string[],
        dynamicResources: [] as string[],
        voiceProviders: [] as string[],
        composerReferences: [] as string[],
      });

      await daemonModule.activate({
        actions: { register(id: string) { registered.actions.push(id); } },
        agents: { register(id: string) { registered.agents.push(id); } },
        hooks: { register(id: string) { registered.hooks.push(id); } },
        resources: {
          registerDynamicResource(id: string) { registered.dynamicResources.push(id); },
        },
        voiceProviders: { register(id: string) { registered.voiceProviders.push(id); } },
        composerReferences: {
          register(id: string) { registered.composerReferences.push(id); },
        },
      });

      const daemonManifestResult = ingestPluginManifestV2(daemonModule.manifest);
      expect(daemonManifestResult).toMatchObject({ ok: true });
      if (!daemonManifestResult.ok) {
        throw new Error('Bundled public-authoring manifest must remain valid at the canonical ingress');
      }
      const daemonManifest = daemonManifestResult.manifest;
      const declared = daemonManifest.contributes;
      const declaredActions = declared?.actions;
      const declaredAgents = declared?.agents;
      const declaredHooks = declared?.hooks;
      const declaredResources = declared?.resources;
      const declaredVoiceProviders = declared?.voiceProviders;
      const declaredComposerReferences = declared?.composerReferences;
      if (
        !declaredActions
        || !declaredAgents
        || !declaredHooks
        || !declaredResources
        || !declaredVoiceProviders
        || !declaredComposerReferences
      ) {
        throw new Error('Public authoring fixture must declare every exercised daemon contribution family');
      }
      const generatedManifest = JSON.parse(await readFile(generatedManifestPath, 'utf8')) as PluginManifestV2;
      expect(generatedManifest).toEqual(evaluated.manifest);
      expect(daemonManifest).toEqual(generatedManifest);
      expect(daemonManifest.entrypoints).toEqual({ daemon: './dist/daemon.js' });
      expect(daemonModule.reviewAgentRunnerFactory).toEqual({
        module: './agent/runtime.js',
        export: 'createReviewAgentRuntime',
        runtimeApiVersion: 1,
      });
      // Client-target actions are activated by their declared client artifact;
      // daemon activation owns only the daemon-target declarations.
      expect(registered.actions).toEqual(
        declaredActions
          .filter(({ execution }) => execution.target === 'daemon')
          .map(({ id }) => id),
      );
      expect(registered.agents).toEqual(declaredAgents.map(({ id }) => id));
      expect(registered.hooks).toEqual(declaredHooks.map(({ id }) => id));
      expect(registered.dynamicResources).toEqual(
        declaredResources.filter(({ source }) => source === 'dynamic').map(({ id }) => id),
      );
      // Conversation Voice rows point at their client artifact and therefore
      // are intentionally absent from daemon activation; speech rows carry
      // the daemon runtime producer in this source definition.
      expect(registered.voiceProviders).toEqual(
        declaredVoiceProviders
          .filter(({ kind }) => kind === 'speech')
          .map(({ id }) => id),
      );
      expect(registered.composerReferences).toEqual(
        declaredComposerReferences.map(({ id }) => id),
      );
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('builds a Session Agent runner through canonical staging and preserves an unowned sibling export', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-session-runner-'));
    await mkdir(join(projectRoot, 'src', 'agent', 'runtime'), { recursive: true });
    await mkdir(join(projectRoot, 'dist', 'agent', 'runtime'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      "import { createSessionAgentRuntime } from './agent/runtime/factory.js';",
      'export const manifest = {',
      "  schemaVersion: 2, id: 'acme.session-build', version: '1.0.0',",
      "  displayName: 'Session build', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },",
      "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },",
      '  contributes: { agents: [{',
      "    id: 'session-build', title: 'Session build', runtime: { kind: 'custom' }, primary: 'sessions',",
      "    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },",
      '  }] },',
      '};',
      'export function activate(api) {',
      "  api.agents.register('session-build', createSessionAgentRuntime, {",
      "    sessionRunnerFactory: { module: './agent/runtime/factory', export: 'createSessionAgentRuntime', runtimeApiVersion: 1 },",
      '  });',
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      join(projectRoot, 'src', 'agent', 'runtime', 'factory.ts'),
      'export function createSessionAgentRuntime() { return { sessions: {} }; }\n',
      'utf8',
    );
    const siblingPath = join(projectRoot, 'dist', 'agent', 'runtime', 'companion.js');
    await writeFile(siblingPath, 'export const companion = true;\n', 'utf8');

    try {
      await bundlePluginDaemonRuntimeImplementation(projectRoot);
      const activation = await import(pathToFileURL(join(projectRoot, 'dist', 'index.js')).href);
      const runner = await import(pathToFileURL(
        join(projectRoot, 'dist', 'agent', 'runtime', 'factory.js'),
      ).href);
      let registeredFactory: unknown;
      activation.activate({
        agents: {
          register(_id: string, factory: unknown) {
            registeredFactory = factory;
          },
        },
      });
      expect(registeredFactory).toBe(runner.createSessionAgentRuntime);
      await expect(readFile(siblingPath, 'utf8')).resolves.toBe('export const companion = true;\n');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['drive-relative', 'C:dist/index.js'],
    ['escaping', '..\\outside.js'],
  ] as const)('rejects a %s portable output entrypoint', async (_label, daemonEntrypoint) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-portable-invalid-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-portable-invalid',
      version: '1.0.0',
      displayName: 'Bundle Portable Invalid Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: daemonEntrypoint },
      contributes: {},
    };
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).rejects.toThrow(/relative|inside|traverse|escape/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['the declared outDir', 'dist', './dist/index.js'],
    ['a nested directory inside the declared outDir', 'dist', './dist/runtime/daemon.js'],
    ['a non-default outDir', 'build', './build/index.js'],
  ] as const)('refuses to bundle the daemon into %s, where the author TypeScript compiler also emits', async (
    _label,
    outDir,
    daemonEntrypoint,
  ) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-emit-collision-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-emit-collision',
      version: '1.0.0',
      displayName: 'Bundle Emit Collision Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: daemonEntrypoint },
      contributes: {},
    };
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'acme-bundle-emit-collision', version: '1.0.0', type: 'module',
    }), 'utf8');
    await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir, module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }), 'utf8');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).rejects.toThrow(
        /entrypoints\.daemon must not resolve inside the TypeScript output directory/u,
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('bundles the daemon when the author TypeScript config emits into a different directory', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-emit-disjoint-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-emit-disjoint',
      version: '1.0.0',
      displayName: 'Bundle Emit Disjoint Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './.happier-plugin/daemon.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'acme-bundle-emit-disjoint', version: '1.0.0', type: 'module',
    }), 'utf8');
    await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'dist', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }), 'utf8');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).resolves.toBeUndefined();
      expect(existsSync(join(projectRoot, '.happier-plugin', 'daemon.js'))).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('bundles the daemon into the TypeScript output directory when that config cannot emit', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-emit-noemit-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-emit-noemit',
      version: '1.0.0',
      displayName: 'Bundle No-Emit Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'acme-bundle-emit-noemit', version: '1.0.0', type: 'module',
    }), 'utf8');
    await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        rootDir: 'src', outDir: 'dist', noEmit: true, module: 'ESNext', moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts'],
    }), 'utf8');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).resolves.toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects a contained output-directory symlink that aliases the development entrypoint', async ({ skip }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-symlink-alias-'));
    const sourcePath = join(projectRoot, 'src', 'index.ts');
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-symlink-alias',
      version: '1.0.0',
      displayName: 'Bundle Symlink Alias Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    const sourceContents = [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(sourcePath, sourceContents, 'utf8');

    try {
      try {
        await link(sourcePath, join(projectRoot, 'src', 'index.js'));
        await symlink(
          join(projectRoot, 'src'),
          join(projectRoot, 'dist'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(bundlePluginDaemonRuntime(projectRoot))
        .rejects.toThrow('entrypoints.daemon must not overwrite the plugin author entry');
      await expect(readFile(sourcePath, 'utf8')).resolves.toContain(sourceContents);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an existing regular-file hard link that aliases the development entrypoint', async ({ skip }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-hardlink-alias-'));
    const sourcePath = join(projectRoot, 'src', 'index.ts');
    const outputPath = join(projectRoot, 'dist', 'index.js');
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'dist'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-hardlink-alias',
      version: '1.0.0',
      displayName: 'Bundle Hard Link Alias Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    const sourceContents = [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n');
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(sourcePath, sourceContents, 'utf8');

    try {
      try {
        await link(sourcePath, outputPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (
          code === 'EPERM'
          || code === 'EACCES'
          || code === 'ENOTSUP'
          || code === 'ENOSYS'
          || code === 'EXDEV'
        ) {
          skip('hard links are unavailable on this host filesystem');
          return;
        }
        throw error;
      }
      const [sourceStat, outputStat] = await Promise.all([lstat(sourcePath), lstat(outputPath)]);
      if (sourceStat.dev === 0 || sourceStat.ino === 0 || outputStat.dev === 0 || outputStat.ino === 0) {
        skip('this host filesystem does not expose stable device/inode identity');
        return;
      }
      expect({ dev: outputStat.dev, ino: outputStat.ino }).toEqual({
        dev: sourceStat.dev,
        ino: sourceStat.ino,
      });

      await expect(bundlePluginDaemonRuntime(projectRoot))
        .rejects.toThrow('entrypoints.daemon must not overwrite the plugin author entry');
      await expect(readFile(sourcePath, 'utf8')).resolves.toContain(sourceContents);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes a self-contained daemon entrypoint with project dependencies bundled', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-fixture',
      version: '1.0.0',
      displayName: 'Bundle Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      "import { answer } from 'fixture-dependency';",
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export const dependencyAnswer = answer;',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(projectRoot, 'node_modules', 'fixture-dependency', 'package.json'), JSON.stringify({
      name: 'fixture-dependency',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }), 'utf8');
    await writeFile(join(projectRoot, 'node_modules', 'fixture-dependency', 'index.js'), 'export const answer = 42;\n', 'utf8');

    try {
      await bundlePluginDaemonRuntime(projectRoot);
      await rm(join(projectRoot, 'node_modules'), { recursive: true, force: true });
      const outputPath = join(projectRoot, 'dist', 'index.js');
      expect(await readFile(outputPath, 'utf8')).not.toMatch(/from\s+["']fixture-dependency["']/u);
      const module = await import(`${pathToFileURL(outputPath).href}?fixture=${Date.now()}`) as {
        dependencyAnswer: number;
      };
      expect(module.dependencyAnswer).toBe(42);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves the canonical PluginError contract across the packed SDK copy', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-error-abi-'));
    const manifest = {
      schemaVersion: 2,
      id: 'acme.error-abi',
      version: '1.0.0',
      displayName: 'Error ABI Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    };
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      "import { PluginError, isPluginError } from '@happier-dev/plugin-sdk';",
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function readHostError(error: unknown) {',
      '  if (!isPluginError(error)) return null;',
      '  return { code: error.code, details: error.details };',
      '}',
      'export function createPluginError() {',
      "  return new PluginError({ code: 'plugin_failure', details: { direction: 'plugin-to-host' } });",
      '}',
      'export function isPluginFailure(error: unknown) { return isPluginError(error); }',
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await linkCanonicalPublicRuntimePackages(projectRoot);

    try {
      await bundlePluginDaemonRuntime(projectRoot);
      const outputPath = join(projectRoot, 'dist', 'index.js');
      const packed = await import(`${pathToFileURL(outputPath).href}?error-abi=${Date.now()}`) as Readonly<{
        readHostError(error: unknown): unknown;
        createPluginError(): unknown;
        isPluginFailure(error: unknown): boolean;
      }>;
      const hostError = new PluginError({
        code: 'host_failure',
        details: { direction: 'host-to-plugin' },
      });

      expect(packed.readHostError(hostError)).toEqual({
        code: 'host_failure',
        details: { direction: 'host-to-plugin' },
      });

      const pluginError = packed.createPluginError();
      expect(pluginError).not.toBeInstanceOf(PluginError);
      expect(isPluginError(pluginError)).toBe(true);
      if (!isPluginError(pluginError)) {
        throw new Error('Packed PluginError must retain the canonical public error contract.');
      }
      expect(pluginError.code).toBe('plugin_failure');
      expect(pluginError.details).toEqual({ direction: 'plugin-to-host' });

      expect(isPluginError({ ...hostError })).toBe(false);
      expect(packed.isPluginFailure({ ...pluginError })).toBe(false);
      expect(isPluginError(new Error('ordinary failure'))).toBe(false);
      expect(packed.isPluginFailure(new Error('ordinary failure'))).toBe(false);

      const decoratedOrdinaryError = Object.assign(new Error('ordinary failure'), {
        code: 'plugin_failure',
        retryable: false,
        data: {
          name: 'PluginError',
          code: 'plugin_failure',
          message: 'ordinary failure',
        },
      });
      expect(isPluginError(decoratedOrdinaryError)).toBe(false);
      expect(packed.isPluginFailure(decoratedOrdinaryError)).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an output directory that resolves outside the plugin project without creating it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-contained-'));
    const projectRoot = join(parent, 'plugin');
    const outsideRoot = join(parent, 'outside');
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(outsideRoot);
    const manifest = {
      schemaVersion: 2,
      id: 'acme.bundle-contained',
      version: '1.0.0',
      displayName: 'Bundle Containment Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/nested/index.js' },
      contributes: {},
    };
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      `export const manifest = ${JSON.stringify(manifest)};`,
      'export function activate() {}',
      '',
    ].join('\n'), 'utf8');
    await symlink(outsideRoot, join(projectRoot, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).rejects.toThrow(/inside|contained/u);
      await expect(lstat(join(outsideRoot, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects a runner output that collides with the packed activation entry before invoking esbuild', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-runner-output-collision-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');
    const runnerBytes = Buffer.from('export const factory = () => ({});\n', 'utf8');
    await writeFile(join(sourceRoot, 'daemon.ts'), runnerBytes);
    let buildCalled = false;
    const build: typeof EsbuildBuild = async () => {
      buildCalled = true;
      throw new Error('esbuild must not run for colliding entrypoints');
    };

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/daemon.js',
        sessionRunnerFactories: [{
          localAgentId: 'fixture',
          locator: { module: './daemon.js', export: 'factory', runtimeApiVersion: 1 },
          normalizedModulePath: 'daemon.ts',
          loadMode: 'source-ts',
        }],
      }, { build })).rejects.toThrow(/runner module.*activation entry/u);
      expect(buildCalled).toBe(false);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { packageType: 'commonjs', daemonEntrypoint: './dist/index.js' },
    { packageType: 'module', daemonEntrypoint: './dist/index.cjs' },
  ])('rejects ESM output at $daemonEntrypoint for a $packageType package before invoking esbuild', async ({
    packageType,
    daemonEntrypoint,
  }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-esm-admission-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: packageType }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');
    let buildCalled = false;
    const build: typeof EsbuildBuild = async () => {
      buildCalled = true;
      throw new Error('esbuild must not run for an incompatible daemon format');
    };

    try {
      await expect(stagePluginDaemonRuntimeImplementation({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint,
      }, { build })).rejects.toThrow(/emits ESM|type:module/u);
      expect(buildCalled).toBe(false);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a relative source import whose package-local symlink resolves outside the package root', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-import-escape-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from './linked/marker.js';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(outsideRoot, 'marker.js'), "export const marker = 'external-marker';\n", 'utf8');

    try {
      try {
        await symlink(
          outsideRoot,
          join(sourceRoot, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/source import.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects an absolute source import outside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-absolute-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outsideModulePath = join(parentRoot, 'outside.js');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(outsideModulePath, "export const marker = 'absolute-marker';\n", 'utf8');
    const portableOutsideModulePath = outsideModulePath.replaceAll('\\', '/');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      `import { marker } from ${JSON.stringify(portableOutsideModulePath)};\nexport function activate() { return marker; }\n`,
      'utf8',
    );

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/source import.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a bare tsconfig paths alias that resolves outside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-tsconfig-paths-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': ['../outside/*'] },
      },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'escape/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(outsideRoot, 'marker.ts'), "export const marker = 'paths-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/(?:source import|TypeScript config).*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a wildcard paths substitution whose package-local symlink resolves outside the package root', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-wildcard-symlink-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': ['*'] },
      },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'escape/linked/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(outsideRoot, 'marker.ts'), "export const marker = 'wildcard-symlink-marker';\n", 'utf8');

    try {
      try {
        await symlink(
          outsideRoot,
          join(sourceRoot, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/(?:paths|source import).*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects an outside tsconfig alias even when adjacent package metadata spoofs the bare package name', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-paths-spoof-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'escape/*': ['../outside/*'] },
      },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'escape/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(outsideRoot, 'package.json'), JSON.stringify({ name: 'escape' }), 'utf8');
    await writeFile(join(outsideRoot, 'marker.ts'), "export const marker = 'spoofed-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/TypeScript config.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects a bare baseUrl source alias that resolves outside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-base-url-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const outsideRoot = join(parentRoot, 'outside');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '..' },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'outside/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(outsideRoot, 'marker.ts'), "export const marker = 'base-url-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/TypeScript config.*outside.*package root/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('does not enable baseUrl-only source resolution that author evaluation cannot consume', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-base-url-only-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.' },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'src/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(sourceRoot, 'src', 'marker.ts'), "export const marker = 'base-url-only-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).rejects.toThrow(/Could not resolve ['"]src\/marker\.ts['"]/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('allows a package-local tsconfig paths alias that remains inside the package root', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-local-paths-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'local/*': ['src/*'] },
      },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'local/marker.ts';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(sourceRoot, 'src', 'marker.ts'), "export const marker = 'local-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.js'] });
      await expect(readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('local-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('allows package imports and package self-reference when their resolved source remains contained', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-self-reference-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'fixture-self-reference',
      version: '1.0.0',
      type: 'module',
      imports: { '#local': './src/local.js' },
      exports: { './self': './src/self.js' },
    }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      [
        "import { local } from '#local';",
        "import { self } from 'fixture-self-reference/self';",
        'export function activate() { return `${local}:${self}`; }',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(sourceRoot, 'src', 'local.js'), "export const local = 'imports-marker';\n", 'utf8');
    await writeFile(join(sourceRoot, 'src', 'self.js'), "export const self = 'self-marker';\n", 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.js'] });
      const bundled = await readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8');
      expect(bundled).toContain('imports-marker');
      expect(bundled).toContain('self-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('allows a bare package dependency whose physical closure is outside the package root', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-bare-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const dependencyRoot = join(parentRoot, 'fixture-dependency');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
    await mkdir(dependencyRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'fixture-dependency';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'fixture-dependency',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }), 'utf8');
    await writeFile(join(dependencyRoot, 'index.js'), "export { marker } from './marker.js';\n", 'utf8');
    await writeFile(join(dependencyRoot, 'marker.js'), "export const marker = 'bare-marker';\n", 'utf8');

    try {
      try {
        await symlink(
          dependencyRoot,
          join(sourceRoot, 'node_modules', 'fixture-dependency'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.js'] });
      await expect(readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('bare-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('allows dependency-relative closure through a nested unnamed package scope', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-unnamed-scope-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const dependencyRoot = join(parentRoot, 'fixture-dependency');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
    await mkdir(join(dependencyRoot, 'nested'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from 'fixture-dependency';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'fixture-dependency',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }), 'utf8');
    await writeFile(join(dependencyRoot, 'index.js'), "export { marker } from './nested/entry.js';\n", 'utf8');
    await writeFile(join(dependencyRoot, 'nested', 'package.json'), '{}', 'utf8');
    await writeFile(join(dependencyRoot, 'nested', 'entry.js'), "export { marker } from './marker.js';\n", 'utf8');
    await writeFile(join(dependencyRoot, 'nested', 'marker.js'), "export const marker = 'nested-marker';\n", 'utf8');

    try {
      try {
        await symlink(
          dependencyRoot,
          join(sourceRoot, 'node_modules', 'fixture-dependency'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.js'] });
      await expect(readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('nested-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('allows scoped subpath exports and transitive package closure in symlinked package layouts', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-scoped-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const dependencyRoot = join(parentRoot, 'store', 'scoped');
    const transitiveRoot = join(parentRoot, 'store', 'transitive');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'node_modules', '@fixture'), { recursive: true });
    await mkdir(join(dependencyRoot, 'node_modules'), { recursive: true });
    await mkdir(transitiveRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { marker } from '@fixture/scoped/marker';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
      name: '@fixture/scoped',
      version: '1.0.0',
      type: 'module',
      exports: { './marker': './index.js' },
    }), 'utf8');
    await writeFile(join(dependencyRoot, 'index.js'), [
      "import { transitive } from 'fixture-transitive';",
      "import { local } from './local.js';",
      'export const marker = `${local}:${transitive}`;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(dependencyRoot, 'local.js'), "export const local = 'scoped-local';\n", 'utf8');
    await writeFile(join(transitiveRoot, 'package.json'), JSON.stringify({
      name: 'fixture-transitive',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }), 'utf8');
    await writeFile(join(transitiveRoot, 'index.js'), "export { transitive } from './marker.js';\n", 'utf8');
    await writeFile(join(transitiveRoot, 'marker.js'), "export const transitive = 'transitive-marker';\n", 'utf8');

    try {
      try {
        await symlink(
          dependencyRoot,
          join(sourceRoot, 'node_modules', '@fixture', 'scoped'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        await symlink(
          transitiveRoot,
          join(dependencyRoot, 'node_modules', 'fixture-transitive'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.js'] });
      const bundled = await readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8');
      expect(bundled).toContain('scoped-local');
      expect(bundled).toContain('transitive-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('stages first-party workspace imports from canonical roots despite nested workspace copies', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-workspace-roots-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const canonicalSdkRoot = join(parentRoot, 'workspace', 'packages', 'fixture-sdk');
    const canonicalProtocolRoot = join(parentRoot, 'workspace', 'packages', 'fixture-protocol');
    const nestedSdkRoot = join(parentRoot, 'nested', 'fixture-sdk');
    const nestedProtocolRoot = join(parentRoot, 'nested', 'fixture-protocol');
    const flatSdkRoot = join(parentRoot, 'flat', 'fixture-sdk');
    const flatProtocolRoot = join(parentRoot, 'flat', 'fixture-protocol');
    const nestedStagedRoot = join(parentRoot, 'staged-nested');
    const flatStagedRoot = join(parentRoot, 'staged-flat');
    const workspacePackageRoots = Object.freeze({
      '@happier-dev/fixture-sdk': canonicalSdkRoot,
      '@happier-dev/fixture-protocol': canonicalProtocolRoot,
    });
    const writeExternal = async (packageRoot: string) => {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'fixture-external',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }), 'utf8');
      await writeFile(join(packageRoot, 'index.js'), "export const external = 'same-external';\n", 'utf8');
    };
    const writeProtocol = async (packageRoot: string) => {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/fixture-protocol',
        version: '1.0.0',
        type: 'module',
        exports: './dist/index.js',
      }), 'utf8');
      await writeFile(
        join(packageRoot, 'dist', 'index.js'),
        "import { external } from 'fixture-external';\nexport const protocol = `protocol:${external}`;\n",
        'utf8',
      );
      await writeExternal(join(packageRoot, 'node_modules', 'fixture-external'));
    };
    const writeSdk = async (packageRoot: string) => {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/fixture-sdk',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './dist/index.js',
          './subpath': './dist/subpath.js',
        },
      }), 'utf8');
      await writeFile(
        join(packageRoot, 'dist', 'index.js'),
        "import { protocol } from '@happier-dev/fixture-protocol';\nexport const sdk = `sdk:${protocol}`;\n",
        'utf8',
      );
      await writeFile(join(packageRoot, 'dist', 'subpath.js'), "export const subpath = 'subpath';\n", 'utf8');
    };

    await mkdir(join(sourceRoot, 'node_modules', '@happier-dev'), { recursive: true });
    await mkdir(nestedStagedRoot, { recursive: true });
    await mkdir(flatStagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      [
        "import { sdk } from '@happier-dev/fixture-sdk';",
        "import { subpath } from '@happier-dev/fixture-sdk/subpath';",
        'export const result = `${sdk}:${subpath}`;',
        '',
      ].join('\n'),
      'utf8',
    );
    await Promise.all([
      writeSdk(canonicalSdkRoot),
      writeProtocol(canonicalProtocolRoot),
      writeSdk(nestedSdkRoot),
      writeProtocol(nestedProtocolRoot),
      writeSdk(flatSdkRoot),
      writeProtocol(flatProtocolRoot),
    ]);

    const sdkLink = join(sourceRoot, 'node_modules', '@happier-dev', 'fixture-sdk');
    const protocolLink = join(sourceRoot, 'node_modules', '@happier-dev', 'fixture-protocol');
    try {
      try {
        await symlink(
          nestedSdkRoot,
          sdkLink,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        await mkdir(join(nestedSdkRoot, 'node_modules', '@happier-dev'), { recursive: true });
        await symlink(
          nestedProtocolRoot,
          join(nestedSdkRoot, 'node_modules', '@happier-dev', 'fixture-protocol'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      const stageParams = (stagedRootPath: string): Parameters<typeof stagePluginDaemonRuntimeImplementation>[0] & Readonly<{
        canonicalWorkspacePackageRoots: typeof workspacePackageRoots;
      }> => ({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath,
        daemonEntrypoint: './dist/index.js',
        canonicalWorkspacePackageRoots: workspacePackageRoots,
      });
      await stagePluginDaemonRuntime(stageParams(nestedStagedRoot));
      const nestedBytes = await readFile(join(nestedStagedRoot, 'dist', 'index.js'));

      await rm(sdkLink, { recursive: true, force: true });
      await symlink(
        flatSdkRoot,
        sdkLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await symlink(
        flatProtocolRoot,
        protocolLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await stagePluginDaemonRuntime(stageParams(flatStagedRoot));
      const flatBytes = await readFile(join(flatStagedRoot, 'dist', 'index.js'));

      expect(flatBytes).toEqual(nestedBytes);
      expect(flatBytes.toString('utf8')).toContain('same-external');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('emits the same daemon bytes from two checkouts at different absolute paths', async () => {
    // esbuild labels every bundled module with its path relative to the build working
    // directory, which is the staged root. A module resolved outside it — every canonical
    // workspace package — was therefore labelled by walking up to the filesystem root,
    // stamping the author's checkout path into the shipped bundle.
    const stagedRoots: string[] = [];
    const buildCheckout = async (checkoutRoot: string): Promise<ReadonlyMap<string, Buffer>> => {
      const packagesRoot = join(checkoutRoot, 'packages');
      const sourceRoot = join(packagesRoot, 'plugin');
      const sdkRoot = join(packagesRoot, 'fixture-sdk');
      const protocolRoot = join(packagesRoot, 'fixture-protocol');
      // The real pack stages into a temp directory unrelated to the checkout, so every
      // workspace module is labelled by walking out of the staged root entirely.
      const stagedRoot = await mkdtemp(join(tmpdir(), 'happier-bundle-staged-'));
      stagedRoots.push(stagedRoot);

      await mkdir(join(sdkRoot, 'dist'), { recursive: true });
      await mkdir(join(protocolRoot, 'dist'), { recursive: true });
      await mkdir(join(protocolRoot, 'node_modules', 'fixture-external'), { recursive: true });
      await mkdir(join(protocolRoot, 'node_modules', 'fixture-cjs'), { recursive: true });
      await mkdir(sourceRoot, { recursive: true });

      await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/fixture-sdk',
        version: '1.0.0',
        type: 'module',
        exports: './dist/index.js',
      }), 'utf8');
      await writeFile(
        join(sdkRoot, 'dist', 'index.js'),
        "import { protocol } from '@happier-dev/fixture-protocol';\nexport const sdk = `sdk:${protocol}`;\n",
        'utf8',
      );
      await writeFile(join(protocolRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/fixture-protocol',
        version: '1.0.0',
        type: 'module',
        exports: './dist/index.js',
      }), 'utf8');
      await writeFile(
        join(protocolRoot, 'dist', 'index.js'),
        [
          "import { external } from 'fixture-external';",
          "import commonJsDependency from 'fixture-cjs';",
          'export const protocol = `protocol:${external}:${commonJsDependency.commonJs}`;',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(join(protocolRoot, 'node_modules', 'fixture-external', 'package.json'), JSON.stringify({
        name: 'fixture-external',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }), 'utf8');
      await writeFile(
        join(protocolRoot, 'node_modules', 'fixture-external', 'index.js'),
        "export const external = 'same-external';\n",
        'utf8',
      );
      // A CommonJS dependency makes esbuild wrap the module in `__commonJS({ "<path>"(…) {…} })`,
      // where the same path esbuild writes into the `// <path>` comment is also emitted as an
      // executable string literal. Both carry the build machine's layout.
      await writeFile(join(protocolRoot, 'node_modules', 'fixture-cjs', 'package.json'), JSON.stringify({
        name: 'fixture-cjs',
        version: '1.0.0',
        main: './index.js',
      }), 'utf8');
      await writeFile(
        join(protocolRoot, 'node_modules', 'fixture-cjs', 'index.js'),
        "module.exports = { commonJs: 'same-commonjs' };\n",
        'utf8',
      );
      await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      await writeFile(join(sourceRoot, 'index.ts'), [
        "import { sdk } from '@happier-dev/fixture-sdk';",
        'export const result = `${sdk}`;',
        '',
      ].join('\n'), 'utf8');
      // A second entrypoint sharing the workspace closure makes esbuild split it into a
      // content-hashed chunk. esbuild derives that chunk's FILE NAME from the bytes it emits,
      // before any post-processing runs, and every importing output names the chunk in an
      // executable import specifier — so a label that still carried the checkout path would
      // survive relabelling as a divergent file name.
      await writeFile(join(sourceRoot, 'runner.ts'), [
        "import { sdk } from '@happier-dev/fixture-sdk';",
        'export function createRuntime() { return `runner:${sdk}`; }',
        '',
      ].join('\n'), 'utf8');

      const staged = await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
        sessionRunnerFactories: [{
          localAgentId: 'fixture',
          locator: { module: './runner', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: 'runner.ts',
          loadMode: 'source-ts',
        }],
        canonicalWorkspacePackageRoots: Object.freeze({
          '@happier-dev/fixture-sdk': sdkRoot,
          '@happier-dev/fixture-protocol': protocolRoot,
        }),
      });
      return new Map(await Promise.all(staged.outputRelativePaths.map(
        async (relativePath) => [
          relativePath,
          await readFile(join(stagedRoot, ...relativePath.split('/'))),
        ] as const,
      )));
    };

    // Two checkouts differing in both absolute prefix and depth: a bundle that records
    // where it was built cannot produce the same bytes from both.
    const shallowCheckout = await mkdtemp(join(tmpdir(), 'happier-bundle-checkout-a-'));
    const deepCheckoutParent = await mkdtemp(join(tmpdir(), 'happier-bundle-checkout-b-'));
    const deepCheckout = join(deepCheckoutParent, 'nested', 'deeper', 'still');
    await mkdir(deepCheckout, { recursive: true });

    try {
      const shallowOutputs = await buildCheckout(shallowCheckout);
      const deepOutputs = await buildCheckout(deepCheckout);
      const shallowSource = [...shallowOutputs.values()].map((bytes) => bytes.toString('utf8')).join('\n');
      const deepSource = [...deepOutputs.values()].map((bytes) => bytes.toString('utf8')).join('\n');

      expect(shallowSource).toContain('same-external');
      expect(shallowSource).toContain('same-commonjs');
      // Emitted file names carry the chunk content hash, so comparing the name lists first
      // distinguishes a divergent chunk identity from divergent chunk bytes.
      expect([...shallowOutputs.keys()]).toEqual([...deepOutputs.keys()]);
      expect([...shallowOutputs.keys()].filter((path) => path.includes('/.happier-chunks/'))).not.toEqual([]);
      for (const [relativePath, bytes] of shallowOutputs) {
        expect(deepOutputs.get(relativePath)).toEqual(bytes);
      }
      for (const bytes of shallowOutputs.values()) {
        for (const line of bytes.toString('utf8').split('\n')) {
          if (line.startsWith('// ')) {
            expect(line).not.toMatch(/^\/\/ (?:\.\.\/|\/|[A-Za-z]:[\\/])/u);
            continue;
          }
          // esbuild's module-registry keys are executable strings, not comments: a bundle that
          // strips only the comments still ships the build machine's layout inside `__commonJS`.
          expect(line).not.toMatch(/^\s*"(?:\.\.\/|\/|[A-Za-z]:[\\/])[^"]*"\(/u);
        }
      }
      // A label that escapes the staged root only as far as a shared ancestor still names the
      // checkout by its own directory, so assert on that unique segment rather than the whole
      // absolute path — which a sibling temp root elides.
      for (const checkoutSegment of [basename(shallowCheckout), basename(deepCheckoutParent)]) {
        expect(shallowSource).not.toContain(checkoutSegment);
        expect(deepSource).not.toContain(checkoutSegment);
      }
      expect(shallowSource).not.toContain(shallowCheckout);
      expect(deepSource).not.toContain(deepCheckout);
      expect(shallowSource).toContain('// fixture-protocol/node_modules/fixture-external/index.js');
      expect(shallowSource).toContain('"fixture-protocol/node_modules/fixture-cjs/index.js"(');
    } finally {
      await rm(shallowCheckout, { recursive: true, force: true });
      await rm(deepCheckoutParent, { recursive: true, force: true });
      await Promise.all(stagedRoots.map((stagedRoot) => rm(stagedRoot, { recursive: true, force: true })));
    }
  });

  it('preserves Node ESM-to-CommonJS default-import semantics through canonical workspace roots', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-workspace-esm-interop-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const canonicalSdkRoot = join(parentRoot, 'workspace', 'packages', 'fixture-sdk');
    const canonicalProtocolRoot = join(parentRoot, 'workspace', 'packages', 'fixture-protocol');
    const stagedRoot = join(parentRoot, 'staged');

    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(canonicalSdkRoot, 'dist'), { recursive: true });
    await mkdir(join(canonicalProtocolRoot, 'dist'), { recursive: true });
    await mkdir(join(canonicalProtocolRoot, 'node_modules', 'fixture-nested-cjs'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { interopWinner } from '@happier-dev/fixture-sdk';\nexport const result = interopWinner;\n",
      'utf8',
    );
    await writeFile(join(canonicalSdkRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/fixture-sdk',
      version: '1.0.0',
      type: 'module',
      exports: './dist/index.js',
    }), 'utf8');
    await writeFile(
      join(canonicalSdkRoot, 'dist', 'index.js'),
      "import { interopWinner } from '@happier-dev/fixture-protocol/node-interop';\nexport { interopWinner };\n",
      'utf8',
    );
    await writeFile(join(canonicalProtocolRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/fixture-protocol',
      version: '1.0.0',
      type: 'module',
      exports: {
        './node-interop': './dist/node-interop.js',
      },
    }), 'utf8');
    await writeFile(
      join(canonicalProtocolRoot, 'dist', 'node-interop.js'),
      [
        "import nestedDefault from 'fixture-nested-cjs';",
        "export const interopWinner = nestedDefault === 'x' ? 'babel' : nestedDefault.default === 'x' ? 'node' : 'unknown';",
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(canonicalProtocolRoot, 'node_modules', 'fixture-nested-cjs', 'package.json'), JSON.stringify({
      name: 'fixture-nested-cjs',
      version: '1.0.0',
      main: './index.cjs',
    }), 'utf8');
    await writeFile(
      join(canonicalProtocolRoot, 'node_modules', 'fixture-nested-cjs', 'index.cjs'),
      "exports.__esModule = true;\nexports.default = 'x';\n",
      'utf8',
    );

    try {
      await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
        canonicalWorkspacePackageRoots: Object.freeze({
          '@happier-dev/fixture-sdk': canonicalSdkRoot,
          '@happier-dev/fixture-protocol': canonicalProtocolRoot,
        }),
      });
      const emitted = await import(`${pathToFileURL(join(stagedRoot, 'dist', 'index.mjs')).href}?canonical-workspace-esm-interop`);
      expect(emitted.result).toBe('node');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('uses canonical workspace import and require export conditions while staging', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-workspace-conditions-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const canonicalPackageRoot = join(parentRoot, 'workspace', 'packages', 'fixture-conditional');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(canonicalPackageRoot, 'dist'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(canonicalPackageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/fixture-conditional',
      version: '1.0.0',
      type: 'module',
      sideEffects: false,
      exports: {
        './entry': {
          import: './dist/import.js',
          require: './dist/require.cjs',
          default: './dist/default.js',
        },
        './unused': './dist/unused.js',
      },
    }), 'utf8');
    await writeFile(
      join(canonicalPackageRoot, 'dist', 'import.js'),
      "export const marker = 'esm-import-target';\n",
      'utf8',
    );
    await writeFile(
      join(canonicalPackageRoot, 'dist', 'require.cjs'),
      "exports.marker = 'commonjs-require-target';\n",
      'utf8',
    );
    await writeFile(
      join(canonicalPackageRoot, 'dist', 'default.js'),
      "export const marker = 'default-target';\n",
      'utf8',
    );
    await writeFile(
      join(canonicalPackageRoot, 'dist', 'unused.js'),
      "globalThis.__happierCanonicalWorkspaceFixtureSideEffect = 'unused-side-effect-marker';\n",
      'utf8',
    );
    await writeFile(
      join(sourceRoot, 'index.ts'),
      [
        "import '@happier-dev/fixture-conditional/unused';",
        "import { marker as importedMarker } from '@happier-dev/fixture-conditional/entry';",
        "const { marker: requiredMarker } = require('@happier-dev/fixture-conditional/entry');",
        'export const result = `${importedMarker}:${requiredMarker}`;',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
        canonicalWorkspacePackageRoots: Object.freeze({
          '@happier-dev/fixture-conditional': canonicalPackageRoot,
        }),
      });
      const bundled = await readFile(join(stagedRoot, 'dist', 'index.js'), 'utf8');
      expect(bundled).toContain('esm-import-target');
      expect(bundled).toContain('commonjs-require-target');
      expect(bundled).not.toContain('default-target');
      expect(bundled).not.toContain('unused-side-effect-marker');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for unexported canonical subpaths and unknown first-party imports', async ({ skip }) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-workspace-subpath-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const canonicalSdkRoot = join(parentRoot, 'workspace', 'packages', 'fixture-sdk');
    const localSdkRoot = join(parentRoot, 'local', 'fixture-sdk');
    const stagedRoot = join(parentRoot, 'staged');
    const writeSdk = async (packageRoot: string, exports: Readonly<Record<string, string>>) => {
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/fixture-sdk',
        version: '1.0.0',
        type: 'module',
        exports,
      }), 'utf8');
      await writeFile(join(packageRoot, 'dist', 'index.js'), "export const sdk = 'canonical';\n", 'utf8');
      await writeFile(join(packageRoot, 'dist', 'only-local.js'), "export const onlyLocal = 'local';\n", 'utf8');
    };

    await mkdir(join(sourceRoot, 'node_modules', '@happier-dev'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import { onlyLocal } from '@happier-dev/fixture-sdk/only-local';\nexport const result = onlyLocal;\n",
      'utf8',
    );
    await writeSdk(canonicalSdkRoot, { '.': './dist/index.js' });
    await writeSdk(localSdkRoot, {
      '.': './dist/index.js',
      './only-local': './dist/only-local.js',
    });

    try {
      try {
        await symlink(
          localSdkRoot,
          join(sourceRoot, 'node_modules', '@happier-dev', 'fixture-sdk'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') {
          skip('directory symlinks/junctions are unavailable on this host');
          return;
        }
        throw error;
      }

      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
        canonicalWorkspacePackageRoots: Object.freeze({
          '@happier-dev/fixture-sdk': canonicalSdkRoot,
        }),
      })).rejects.toThrow(
        /@happier-dev\/fixture-sdk\/only-local/u,
      );

      await writeFile(
        join(sourceRoot, 'index.ts'),
        "import { unknown } from '@happier-dev/fixture-unknown';\nexport const result = unknown;\n",
        'utf8',
      );
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.js',
        canonicalWorkspacePackageRoots: Object.freeze({
          '@happier-dev/fixture-sdk': canonicalSdkRoot,
        }),
      })).rejects.toThrow(
        /Unable to resolve first-party import '@happier-dev\/fixture-unknown': First-party import '@happier-dev\/fixture-unknown' is not in the canonical workspace dependency closure/u,
      );
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('loads a bundled CommonJS dependency that requires a Node builtin from ESM output', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-cjs-builtin-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const secondStagedRoot = join(parentRoot, 'staged-second');
    await mkdir(join(sourceRoot, 'node_modules', 'fixture-cjs'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await mkdir(secondStagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      [
        "import digest from 'fixture-cjs';",
        "export const require = 'author-require';",
        "export const __happierCreateRequire = 'author-create-require';",
        "export const __happierInjectedRequire = 'author-injected-require';",
        "export function activate() { return digest('happier'); }",
        '',
      ].join('\n'),
      'utf8',
    );
    const runnerBytes = Buffer.from([
      "import digest from 'fixture-cjs';",
      "export function createRuntime() { return digest('runner'); }",
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(sourceRoot, 'runner.ts'), runnerBytes);
    await writeFile(
      join(sourceRoot, 'node_modules', 'fixture-cjs', 'package.json'),
      JSON.stringify({ name: 'fixture-cjs', version: '1.0.0', main: './index.cjs' }),
      'utf8',
    );
    await writeFile(
      join(sourceRoot, 'node_modules', 'fixture-cjs', 'index.cjs'),
      [
        "var __happierInjectedRequire = 'author-cjs-shadow';",
        '(function initialize(api) {',
        "  let crypto = typeof self === 'undefined' ? null : self.crypto;",
        "  if (!crypto && typeof require !== 'undefined') crypto = require('crypto');",
        "  api.digest = (value) => crypto.createHash('sha256').update(value).digest('hex');",
        "}(typeof module !== 'undefined' && module.exports",
        "  ? module.exports",
        "  : (self.fixtureCjs = self.fixtureCjs || {})));",
        'module.exports = module.exports.digest;',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      const stage = async (stagedRootPath: string) => await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath,
        daemonEntrypoint: './dist/index.mjs',
        sessionRunnerFactories: [{
          localAgentId: 'fixture',
          locator: { module: './runner', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: 'runner.ts',
          loadMode: 'source-ts',
        }],
      });
      const firstResult = await stage(stagedRoot);
      expect(firstResult).toEqual(expect.objectContaining({
        outputRelativePaths: expect.arrayContaining([
          'dist/index.mjs',
          'dist/runner.mjs',
        ]),
      }));
      const secondResult = await stage(secondStagedRoot);
      expect(secondResult.outputRelativePaths).toEqual(firstResult.outputRelativePaths);
      const firstOutputs = await Promise.all(firstResult.outputRelativePaths.map(
        async (relativePath) => await readFile(join(stagedRoot, relativePath), 'utf8'),
      ));
      const secondOutputs = await Promise.all(secondResult.outputRelativePaths.map(
        async (relativePath) => await readFile(join(secondStagedRoot, relativePath), 'utf8'),
      ));
      expect(secondOutputs).toEqual(firstOutputs);
      expect(firstOutputs.join('\n')).not.toContain('happier-plugin-runtime-inject-');
      const outputUrl = pathToFileURL(join(stagedRoot, 'dist', 'index.mjs')).href;
      const { stdout } = await execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        [
          `const bundled = await import(${JSON.stringify(outputUrl)});`,
          'process.stdout.write(JSON.stringify({',
          '  value: bundled.activate(),',
          '  authorRequire: bundled.require,',
          '  authorCreateRequire: bundled.__happierCreateRequire,',
          '  authorInjectedRequire: bundled.__happierInjectedRequire,',
          '}));',
        ].join('\n'),
      ]);
      expect(JSON.parse(stdout)).toEqual({
        value: createHash('sha256').update('happier').digest('hex'),
        authorRequire: 'author-require',
        authorCreateRequire: 'author-create-require',
        authorInjectedRequire: 'author-injected-require',
      });
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('supports esbuild dynamic-require helper output at byte zero', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-direct-require-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      [
        'declare const require: (name: string) => typeof import("node:crypto");',
        'export function activate(name = "crypto") {',
        '  return require(name).createHash("sha256").update("direct").digest("hex");',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      });
      const outputUrl = pathToFileURL(join(stagedRoot, 'dist', 'index.mjs')).href;
      const { stdout } = await execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const bundled = await import(${JSON.stringify(outputUrl)}); process.stdout.write(bundled.activate());`,
      ]);
      expect(stdout).toBe(createHash('sha256').update('direct').digest('hex'));
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'an added semantic side effect',
      `// preceding output\n${fixtureEsbuildDynamicRequireHelper().replace(
        '  if (typeof require !== "undefined")',
        '  globalThis.unapprovedSideEffect = true;\n  if (typeof require !== "undefined")',
      )}`,
    ],
    [
      'a changed failure shape',
      `// preceding output\n${fixtureEsbuildDynamicRequireHelper(
        '__require',
        `throw Error('Unsupported require: ' + x);`,
      )}`,
    ],
  ])('rejects esbuild dynamic-require helper output with %s', async (_label, contents) => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-helper-shape-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outputPath = join(stagedRoot, 'dist', 'index.mjs');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(stagedRoot, 'dist'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({ sourceRoot, outputPath, contents }),
      })).rejects.toThrow(/unrecognized esbuild dynamic-require helper/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('ignores an esbuild dynamic-require diagnostic string outside a helper', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-helper-marker-only-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outputPath = join(stagedRoot, 'dist', 'index.mjs');
    const contents = `const diagnostic = \`${fixtureEsbuildDynamicRequireError}\`;\nexport { diagnostic };\n`;
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(stagedRoot, 'dist'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({ sourceRoot, outputPath, contents }),
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.mjs'] });
      await expect(readFile(outputPath, 'utf8')).resolves.toBe(contents);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rewrites one exact helper while preserving an unrelated matching diagnostic string', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-helper-marker-sibling-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outputPath = join(stagedRoot, 'dist', 'index.mjs');
    const contents = [
      fixtureEsbuildDynamicRequireHelper(),
      `const diagnostic = \`${fixtureEsbuildDynamicRequireError}\`;`,
      'export { diagnostic };',
      '',
    ].join('\n');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(stagedRoot, 'dist'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({ sourceRoot, outputPath, contents }),
      })).resolves.toEqual({ outputRelativePaths: ['dist/index.mjs'] });
      const output = await readFile(outputPath, 'utf8');
      expect(output).toContain(fixtureEsbuildDynamicRequireError);
      expect(output).toContain('var __require = /* @__PURE__ */ __requireFactory(import.meta.url);');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects more than one exact esbuild dynamic-require helper in one output', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-duplicate-helper-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outputPath = join(stagedRoot, 'dist', 'index.mjs');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(stagedRoot, 'dist'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({
          sourceRoot,
          outputPath,
          contents: [
            fixtureEsbuildDynamicRequireHelper('__require'),
            fixtureEsbuildDynamicRequireHelper('__require2'),
          ].join('\n'),
        }),
      })).rejects.toThrow(/more than one esbuild dynamic-require helper/u);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('avoids an author binding that collides with the generated createRequire factory name', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-helper-collision-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outputPath = join(stagedRoot, 'dist', 'index.mjs');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(stagedRoot, 'dist'), { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({
          sourceRoot,
          outputPath,
          contents: [
            'var __requireFactory = "author-factory";',
            fixtureEsbuildDynamicRequireHelper('__require'),
          ].join('\n'),
        }),
      });

      const output = await readFile(outputPath, 'utf8');
      expect(output).toContain('var __requireFactory = "author-factory";');
      expect(output).toContain('import { createRequire as __requireFactory2 } from "node:module";');
      expect(output).toContain('var __require = /* @__PURE__ */ __requireFactory2(import.meta.url);');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('checks every emitted output path before post-processing it', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-output-escape-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    const outsidePath = join(parentRoot, 'outside.mjs');
    const outsideContents = `// outside output\n${fixtureEsbuildDynamicRequireHelper()}`;
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(join(sourceRoot, 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
      }, {
        build: fakeEsbuildOutput({
          sourceRoot,
          outputPath: outsidePath,
          contents: outsideContents,
        }),
      })).rejects.toThrow(/escaped its package root/u);
      await expect(readFile(outsidePath, 'utf8')).resolves.toBe(outsideContents);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('keeps a bundled CommonJS relative require module-local in split ESM output', async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-pack-bundle-cjs-relative-'));
    const sourceRoot = join(parentRoot, 'plugin');
    const stagedRoot = join(parentRoot, 'staged');
    await mkdir(join(sourceRoot, 'node_modules', 'fixture-cjs'), { recursive: true });
    await mkdir(stagedRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    await writeFile(
      join(sourceRoot, 'index.ts'),
      "import marker from 'fixture-cjs';\nexport function activate() { return marker; }\n",
      'utf8',
    );
    const runnerBytes = Buffer.from(
      "import marker from 'fixture-cjs';\nexport function createRuntime() { return marker; }\n",
      'utf8',
    );
    await writeFile(join(sourceRoot, 'runner.ts'), runnerBytes);
    await writeFile(
      join(sourceRoot, 'node_modules', 'fixture-cjs', 'package.json'),
      JSON.stringify({ name: 'fixture-cjs', version: '1.0.0', main: './index.cjs' }),
      'utf8',
    );
    await writeFile(
      join(sourceRoot, 'node_modules', 'fixture-cjs', 'index.cjs'),
      "module.exports = require('./core');\n",
      'utf8',
    );
    await writeFile(
      join(sourceRoot, 'node_modules', 'fixture-cjs', 'core.js'),
      "module.exports = 'relative-core';\n",
      'utf8',
    );

    try {
      await stagePluginDaemonRuntime({
        sourceRootPath: sourceRoot,
        sourceEntryPath: join(sourceRoot, 'index.ts'),
        stagedRootPath: stagedRoot,
        daemonEntrypoint: './dist/index.mjs',
        sessionRunnerFactories: [{
          localAgentId: 'fixture',
          locator: { module: './runner', export: 'createRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: 'runner.ts',
          loadMode: 'source-ts',
        }],
      });
      const outputUrl = pathToFileURL(join(stagedRoot, 'dist', 'index.mjs')).href;
      const { stdout } = await execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const bundled = await import(${JSON.stringify(outputUrl)}); process.stdout.write(bundled.activate());`,
      ]);
      expect(stdout).toBe('relative-core');
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });
});
