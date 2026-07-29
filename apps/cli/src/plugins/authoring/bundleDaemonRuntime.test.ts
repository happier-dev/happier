import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  bundlePluginDaemonRuntime,
  PluginAuthorBundlerUnavailableError,
  regularFilesMayAlias,
  resolvePluginAuthorBundlerMainPath,
} from './bundleDaemonRuntime';

const fixtureNativePackageName = '@esbuild/fixture-native';

async function writeFixtureEsbuildPackage(params: Readonly<{
  runtimeRoot: string;
  packageNodeModulesRoot?: string;
  nativePackageRoot?: string;
}>): Promise<string> {
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
    version: '1.2.3',
    main: 'lib/main.js',
    optionalDependencies: { [fixtureNativePackageName]: '1.2.3' },
  }), 'utf8');
  await writeFile(esbuildMainPath, 'module.exports = {};\n', 'utf8');
  await writeFile(join(nativePackageRoot, 'package.json'), JSON.stringify({
    name: fixtureNativePackageName,
    version: '1.2.3',
    os: [process.platform],
    cpu: [process.arch],
  }), 'utf8');
  await writeFile(nativeBinaryPath, 'fixture native binary\n', { mode: 0o755 });
  return esbuildMainPath;
}

describe('bundlePluginDaemonRuntime', () => {
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
      dependencies: { esbuild: '^1.2.0' },
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
      dependencies: { esbuild: '^1.2.0' },
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
      version: '1.2.3',
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
      version: '1.2.3',
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
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-env',
      version: '1.0.0',
      displayName: 'Bundle Environment Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');
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
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-portable',
      version: '1.0.0',
      displayName: 'Bundle Portable Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: '.\\src\\index.ts', daemon: '.\\dist\\index.js' },
      contributes: {},
    }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');
    await writeFile(join(projectRoot, 'dist', 'index.js'), 'stale output\n', 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).resolves.toBeUndefined();
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.toContain('activate');
      await expect(readFile(join(projectRoot, 'dist', 'index.js'), 'utf8')).resolves.not.toContain('stale output');
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
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-portable-invalid',
      version: '1.0.0',
      displayName: 'Bundle Portable Invalid Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: daemonEntrypoint },
      contributes: {},
    }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).rejects.toThrow(/relative|inside|traverse|escape/u);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects a contained output-directory symlink that aliases the development entrypoint', async ({ skip }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-symlink-alias-'));
    const sourcePath = join(projectRoot, 'src', 'index.js');
    const sourceContents = 'export function activate() { return "source"; }\n';
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-symlink-alias',
      version: '1.0.0',
      displayName: 'Bundle Symlink Alias Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.js', daemon: './dist/index.js' },
      contributes: {},
    }), 'utf8');
    await writeFile(sourcePath, sourceContents, 'utf8');

    try {
      try {
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
        .rejects.toThrow('entrypoints.daemon must not overwrite entrypoints.development');
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(sourceContents);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an existing regular-file hard link that aliases the development entrypoint', async ({ skip }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-hardlink-alias-'));
    const sourcePath = join(projectRoot, 'src', 'index.js');
    const outputPath = join(projectRoot, 'dist', 'index.js');
    const sourceContents = 'export function activate() { return "source"; }\n';
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'dist'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-hardlink-alias',
      version: '1.0.0',
      displayName: 'Bundle Hard Link Alias Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.js', daemon: './dist/index.js' },
      contributes: {},
    }), 'utf8');
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
        .rejects.toThrow('entrypoints.daemon must not overwrite entrypoints.development');
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(sourceContents);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes a self-contained daemon entrypoint with project dependencies bundled', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-bundle-'));
    await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'node_modules', 'fixture-dependency'), { recursive: true });
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-fixture',
      version: '1.0.0',
      displayName: 'Bundle Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/index.js' },
      contributes: {},
    }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), [
      "import { answer } from 'fixture-dependency';",
      'export function activate() { return answer; }',
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
      const module = await import(`${pathToFileURL(outputPath).href}?fixture=${Date.now()}`) as { activate(): number };
      expect(module.activate()).toBe(42);
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
    await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'acme.bundle-contained',
      version: '1.0.0',
      displayName: 'Bundle Containment Fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { development: './src/index.ts', daemon: './dist/nested/index.js' },
      contributes: {},
    }), 'utf8');
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function activate() {}\n', 'utf8');
    await symlink(outsideRoot, join(projectRoot, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');

    try {
      await expect(bundlePluginDaemonRuntime(projectRoot)).rejects.toThrow(/inside|contained/u);
      await expect(lstat(join(outsideRoot, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
