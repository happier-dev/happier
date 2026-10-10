import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  type SourceDevSharedDepsPreflightResult,
} from '@/subprocess/sourceDevSharedDepsPreflight';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
  createBundledActivationSourceResolver,
  resolvePackagedBundledActivationPaths,
  resolveBundledActivationSourceRepoRoot,
  resolveSourceDevelopmentBundledPackageNames,
} from './bundledActivationSource';
import type { PluginDaemonModuleNamespace } from './types';

const pluginModuleFixture: PluginDaemonModuleNamespace = {
  activate: async () => undefined,
};

const syncedPreflight = {
  type: 'ready',
  checked: true,
  reason: 'synced',
} satisfies SourceDevSharedDepsPreflightResult;

const distOnlyPreflight = {
  type: 'ready',
  checked: false,
  reason: 'not-source-dev',
} satisfies SourceDevSharedDepsPreflightResult;

const tempDirs: string[] = [];
async function writeFlatAdmittedPluginCopy(params: Readonly<{
  cliProjectPath: string;
  workspaceName: string;
}>): Promise<{ outputPath: string }> {
  const packageDir = join(
    params.cliProjectPath,
    'node_modules',
    '@happier-dev',
    params.workspaceName,
  );
  const packageJsonPath = join(packageDir, 'package.json');
  const outputPath = join(packageDir, 'dist', 'index.js');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    packageJsonPath,
    JSON.stringify({
      name: `@happier-dev/${params.workspaceName}`,
      main: './dist/index.js',
    }),
    'utf8',
  );
  await writeFile(outputPath, 'export const admitted = true;\n', 'utf8');
  const packageJsonStat = await stat(packageJsonPath);
  const outputStat = await stat(outputPath);
  await writeFile(
    join(params.cliProjectPath, '.cli-source-snapshot-admission.json'),
    JSON.stringify({
      version: 1,
      packages: {
        [params.workspaceName]: {
          dependencies: [],
          dist: {
            fileCount: 1,
            totalBytes: outputStat.size,
          },
          outputs: [
            {
              path: 'package.json',
              size: packageJsonStat.size,
              mtimeMs: packageJsonStat.mtimeMs,
            },
            {
              path: 'dist/index.js',
              size: outputStat.size,
              mtimeMs: outputStat.mtimeMs,
            },
          ],
        },
      },
    }),
    'utf8',
  );
  return { outputPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('createBundledActivationSourceResolver', () => {
  it('activates frozen bundle plugins and runner leaves on first demand from a bundled host chunk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-first-demand-'));
    tempDirs.push(root);
    const pluginRoot = join(root, 'packages/plugins/fixture');
    await mkdir(join(pluginRoot, 'dist/agent'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/plugins-fixture', type: 'module' }));
    await writeFile(join(pluginRoot, 'dist/index.js'), "export const marker = 'frozen-activation'; export async function activate() {}\n");
    await writeFile(join(pluginRoot, 'dist/agent/runner.js'), "export const marker = 'frozen-runner';\n");
    const repoRoot = resolveBundledActivationSourceRepoRoot(pathToFileURL(join(root, 'apps/cli/src/chunks/runtime.js')).href);
    const source = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-fixture'], repoRoot,
      canImportFirstPartyPluginSource: () => false,
    })({ pluginId: 'happier.fixture', daemonEntryPath: '@happier-dev/plugins-fixture' });
    expect((await source?.load())?.marker).toBe('frozen-activation');
    expect((await source?.resolveRelativeModule('./agent/runner.js'))?.module.marker).toBe('frozen-runner');
  });
  it('binds packaged activation from an executing runner snapshot to snapshot custody', () => {
    const pluginId = 'happier.snapshot.fixture';
    const packageName = '@happier-dev/plugins-snapshot-fixture';
    const packageRoot = '/runtime/.runner-snapshots/snapshot-a/node_modules/@happier-dev/plugins-snapshot-fixture';
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.js');

    const source = createBundledActivationSourceResolver({
      bundledPackageNames: [packageName],
      immutableArtifactPackageNames: [packageName],
      immutableArtifactEntryPathsByPackageName: new Map([[packageName, daemonEntryPath]]),
      immutableArtifactRootPathsByPackageName: new Map([[packageName, packageRoot]]),
      canImportFirstPartyPluginSource: () => false,
      packagedRuntime: {
        kind: 'pinned_runner_snapshot',
        snapshotId: 'snapshot-a',
      },
    })({ pluginId, daemonEntryPath: packageName });

    expect(source?.sourceAuthority).toEqual({
      kind: 'bundled_first_party',
      packagedRuntime: {
        kind: 'pinned_runner_snapshot',
        snapshotId: 'snapshot-a',
      },
      resolvedRoot: packageRoot,
    });
  });

  it('activates directly from an authoritative CLI version root without creating a plugin generation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-packaged-bundled-direct-'));
    tempDirs.push(tempDir);
    const runtimeRoot = join(tempDir, 'versions', 'cli-version-0.3.0');
    const happyHomeDir = join(tempDir, 'home');
    const packageName = '@happier-dev/plugins-direct-fixture';
    const pluginId = 'happier.direct.fixture';
    const packageRoot = join(
      runtimeRoot,
      'node_modules',
      '@happier-dev',
      'plugins-direct-fixture',
    );
    const daemonEntryPath = join(packageRoot, '.happier-plugin', 'daemon.js');
    await mkdir(dirname(daemonEntryPath), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: packageName,
      version: '1.0.0',
    }), 'utf8');
    await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'Direct fixture',
      engines: { happier: '^0.3.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    }), 'utf8');
    await writeFile(daemonEntryPath, 'export async function activate() {}\n', 'utf8');

    const packaged = resolvePackagedBundledActivationPaths({
      runtimeRoot,
      activationTargets: [{
        pluginId,
        daemonEntryPath: packageName,
        sourceSpec: { kind: 'bundled' },
      }],
      metadata: [{ pluginId, packageName }],
      locators: [{
        pluginId,
        manifest: {
          schemaVersion: 2,
          id: pluginId,
          version: '1.0.0',
          displayName: 'Direct fixture',
          engines: { happier: '^0.3.0' },
          runtime: { apiVersion: 1 },
          entrypoints: { daemon: './.happier-plugin/daemon.js' },
          hostAccess: { required: [], optional: [] },
          contributes: {},
        },
      }],
    });
    const importModule = vi.fn(async () => pluginModuleFixture);
    const source = createBundledActivationSourceResolver({
      bundledPackageNames: [packageName],
      immutableArtifactPackageNames: [packageName],
      immutableArtifactEntryPathsByPackageName: packaged.entryPathsByPackageName,
      immutableArtifactRootPathsByPackageName: packaged.rootPathsByPackageName,
      canImportFirstPartyPluginSource: () => false,
      importModule,
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-0.3.0' },
      repoRoot: '/source-checkout-unavailable',
    })({ pluginId, daemonEntryPath: packageName });

    expect(source?.sourceAuthority).toEqual({
      kind: 'bundled_first_party',
      packagedRuntime: {
        kind: 'cli_version_root',
        versionRootId: 'cli-version-0.3.0',
      },
      resolvedRoot: packageRoot,
    });
    await expect(source?.load()).resolves.toBe(pluginModuleFixture);
    expect(importModule).toHaveBeenCalledWith(pathToFileURL(daemonEntryPath).href);
    await expect(stat(resolvePluginStorePaths({ happyHomeDir }).generationsDir))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves the canonical checkout through a preserve-symlinks source snapshot path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-source-root-symlink-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const canonicalSourceRoot = join(repoRoot, 'apps', 'cli', 'src');
    const canonicalModulePath = join(
      canonicalSourceRoot,
      'plugins',
      'runtime',
      'bundledActivationSource.ts',
    );
    const snapshotSourceRoot = join(
      repoRoot,
      '.project',
      'tmp',
      'cli-dist-snapshot',
      'src',
    );
    await mkdir(dirname(canonicalModulePath), { recursive: true });
    await mkdir(dirname(snapshotSourceRoot), { recursive: true });
    await writeFile(canonicalModulePath, '// source fixture\n', 'utf8');
    await symlink(canonicalSourceRoot, snapshotSourceRoot, 'dir');

    expect(resolveBundledActivationSourceRepoRoot(
      pathToFileURL(join(
        snapshotSourceRoot,
        'plugins',
        'runtime',
        'bundledActivationSource.ts',
      )),
    )).toBe(resolve(await realpath(repoRoot)));
  });

  it('retains lexical root resolution for virtual packaged module paths', () => {
    expect(resolveBundledActivationSourceRepoRoot(
      pathToFileURL('/$bunfs/root/apps/cli/src/plugins/runtime/bundledActivationSource.js'),
    )).toBe(resolve('/$bunfs/root'));
  });

  it('recognizes a source-development package resolved through the snapshot node_modules overlay', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-package-overlay-symlink-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const packageName = '@happier-dev/plugins-session-owner';
    const workspaceName = 'plugins-session-owner';
    const sourceEntryPath = join(
      repoRoot,
      'packages',
      'plugins',
      'session-owner',
      'src',
      'index.ts',
    );
    const canonicalPackageRoot = join(
      repoRoot,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      workspaceName,
    );
    const canonicalPackageEntry = join(canonicalPackageRoot, 'dist', 'index.js');
    const snapshotPackageRoot = join(
      repoRoot,
      '.project',
      'tmp',
      'cli-dist-snapshot',
      'node_modules',
      '@happier-dev',
      workspaceName,
    );
    await mkdir(dirname(sourceEntryPath), { recursive: true });
    await mkdir(dirname(canonicalPackageEntry), { recursive: true });
    await mkdir(dirname(snapshotPackageRoot), { recursive: true });
    await writeFile(sourceEntryPath, 'export function activate() {}\n', 'utf8');
    await writeFile(canonicalPackageEntry, 'export function activate() {}\n', 'utf8');
    await symlink(canonicalPackageRoot, snapshotPackageRoot, 'dir');

    expect([...resolveSourceDevelopmentBundledPackageNames({
      artifacts: [{
        packageName,
        packageEntryRelativePath: 'dist/index.js',
      }],
      canImportFirstPartyPluginSource: () => true,
      repoRoot,
      resolveBundledPackageEntry: () => join(snapshotPackageRoot, 'dist', 'index.js'),
    })]).toEqual([packageName]);
  });

  it('ignores declarative bundled targets without an executable daemon entry', () => {
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-example'],
    });

    expect(resolveActivationSource({
      pluginId: 'happier.example',
      daemonEntryPath: null,
    })).toBeNull();
  });

  it('fails before importing a bundled plugin module when source-dev shared deps are stale', async () => {
    const importModule = vi.fn();
    const prepareSourceDevSharedDeps = vi.fn(async () => ({
      type: 'error' as const,
      errorMessage: 'source-dev shared deps are stale',
    }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/scm-git/src/index.ts',
      importModule,
      packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-0.3.0' },
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    const source = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    });

    expect(source).toEqual(expect.objectContaining({
      kind: 'bundled',
      moduleId: '@happier-dev/plugins-scm-git',
    }));
    await expect(source?.load()).rejects.toThrow('source-dev shared deps are stale');
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: '@happier-dev/plugins-scm-git',
      }),
    );
    expect(importModule).not.toHaveBeenCalled();
  });

  it('uses first-party plugin dist when source exists but the current host cannot import plugin source', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/scm-git/src/index.ts'
        || path === '/repo/packages/plugins/scm-git/dist/index.js'
      ),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/dist\/index\.js$/u);
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
  });

  it('binds checkout development custody to a first-party plugin loaded from its checkout dist', async () => {
    // A repo-dev daemon runs from built output, so it cannot import plugin
    // source and loads `packages/plugins/<id>/dist`. There is no packaged
    // runtime root; the checkout package root is the source authority.
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-triage'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/triage/src/index.ts'
        || path === '/repo/packages/plugins/triage/dist/index.js'
      ),
      importModule: vi.fn(async () => pluginModuleFixture),
      prepareSourceDevSharedDeps: vi.fn(async () => syncedPreflight),
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: rootPath,
        canonicalRoot: rootPath,
        observedRevision: pluginId === 'happier.triage' ? 0 : -1,
      }),
      repoRoot: '/repo',
    });

    const source = resolveActivationSource({
      pluginId: 'happier.triage',
      daemonEntryPath: '@happier-dev/plugins-triage',
    });

    expect(source?.sourceAuthority).toEqual({
      kind: 'development',
      registeredRootId: '/repo/packages/plugins/triage',
      canonicalRoot: '/repo/packages/plugins/triage',
      observedRevision: 0,
    });
  });

  it('prefers first-party plugin source over dist when the current host can import plugin source', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => (
        path === '/repo/packages/plugins/scm-git/src/index.ts'
        || path === '/repo/packages/plugins/scm-git/dist/index.js'
      ),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/src\/index\.ts$/u);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(1);
  });

  it('selects the canonical source-development activation input', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-source-dev-copy-extras-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const sourceEntryPath = join(
      repoRoot,
      'packages',
      'plugins',
      'session-owner',
      'src',
      'index.ts',
    );
    await mkdir(join(sourceEntryPath, '..'), { recursive: true });
    await writeFile(sourceEntryPath, 'export function activate() {}\n', 'utf8');
    const sourceDevelopmentPackageNames =
      resolveSourceDevelopmentBundledPackageNames({
        artifacts: [{
          packageName: '@happier-dev/plugins-session-owner',
          packageEntryRelativePath: 'dist/index.js',
        }],
        canImportFirstPartyPluginSource: () => true,
        existsSync: (path) => path === sourceEntryPath,
        repoRoot,
        resolveBundledPackageEntry: () =>
          join(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', 'plugins-session-owner', 'dist', 'index.js'),
      });
    expect([...sourceDevelopmentPackageNames]).toEqual([
      '@happier-dev/plugins-session-owner',
    ]);

    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: [],
      unavailableImmutableArtifactPackageNames: new Set(),
      canImportFirstPartyPluginSource: () => true,
      importModule,
      prepareSourceDevSharedDeps,
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development',
        registeredRootId: `registered:${pluginId}`,
        canonicalRoot: rootPath,
        observedRevision: 3,
      }),
      repoRoot,
    });

    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });
    await expect(source?.load()).resolves.toBe(pluginModuleFixture);
    expect(source?.sourceAuthority).toEqual({
      kind: 'development',
      registeredRootId: 'registered:happier.agent.session-owner',
      canonicalRoot: join(repoRoot, 'packages', 'plugins', 'session-owner'),
      observedRevision: 3,
    });
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-session-owner',
      workspaceNames: ['plugins-session-owner'],
    });
    expect(importModule).toHaveBeenCalledWith(
      expect.stringMatching(/\/packages\/plugins\/session-owner\/src\/index\.ts$/u),
    );
  });

  it('keeps an unavailable immutable artifact fail-closed outside a source-capable host', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      unavailableImmutableArtifactPackageNames: new Set([
        '@happier-dev/plugins-session-owner',
      ]),
      canImportFirstPartyPluginSource: () => false,
      existsSync: () => true,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    })?.load()).rejects.toThrow('Bundled immutable artifact is unavailable');
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('does not fall through to dist when a known immutable artifact has no exact admitted path', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      canImportFirstPartyPluginSource: () => false,
      existsSync: (path) => (
        path === '/repo/packages/plugins/session-owner/dist/index.js'
        || path === '/repo/packages/plugins/session-owner/dist/agent/runtime/engine.js'
      ),
      importModule,
      prepareSourceDevSharedDeps: async () => distOnlyPreflight,
      repoRoot: '/repo',
    });
    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });

    await expect(source?.load()).rejects.toThrow(
      'Bundled immutable artifact is unavailable',
    );
    await expect(source?.resolveRelativeModule('./agent/runtime/engine')).rejects.toThrow(
      'has no file-backed runner module root',
    );
    expect(importModule).not.toHaveBeenCalled();
  });

  it('does not bypass a rejected immutable artifact with unadmitted source-dev bytes', async () => {
    expect([...resolveSourceDevelopmentBundledPackageNames({
      artifacts: [{
        packageName: '@happier-dev/plugins-session-owner',
        packageEntryRelativePath: 'dist/index.js',
      }],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/session-owner/src/index.ts',
      repoRoot: '/repo',
      resolveBundledPackageEntry: () =>
        '/installed/plugins-session-owner/dist/index.js',
    })]).toEqual([]);
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-session-owner'],
      unavailableImmutableArtifactPackageNames: new Set([
        '@happier-dev/plugins-session-owner',
      ]),
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/session-owner/src/index.ts',
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    })?.load()).rejects.toThrow('Bundled immutable artifact is unavailable');
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('loads an inventory-admitted bundled artifact from its exact admitted package entry', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const admittedEntryPath = '/installed/review-coderabbit/dist/index.js';
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-review-coderabbit'],
      immutableArtifactEntryPathsByPackageName: new Map([
        ['@happier-dev/plugins-review-coderabbit', admittedEntryPath],
      ]),
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => true,
      importModule,
      prepareSourceDevSharedDeps: async () => syncedPreflight,
      repoRoot: '/different-source-checkout',
    });

    await resolveActivationSource({
      pluginId: 'happier.review.coderabbit',
      daemonEntryPath: '@happier-dev/plugins-review-coderabbit',
    })?.load();

    expect(imported).toEqual([expect.stringMatching(/\/installed\/review-coderabbit\/dist\/index\.js$/u)]);
  });

  it('activates the published daemon runtime and its staged runner leaf, not the compiler package root export', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-daemon-entry-'));
    tempDirs.push(tempDir);
    const installedRoot = join(tempDir, 'installed', 'plugins-session-owner');
    // The compiler's own emit. The publisher never writes here, and the daemon must
    // never resolve activation or a runner leaf out of it.
    const compilerPackageEntryPath = join(installedRoot, 'dist', 'index.js');
    const compilerRunnerPath = join(installedRoot, 'dist', 'agent', 'runtime', 'engine.js');
    // The published daemon runtime and the runner leaf staged beside it.
    const daemonEntryPath = join(installedRoot, '.happier-plugin', 'daemon.js');
    const publishedRunnerPath = join(installedRoot, '.happier-plugin', 'agent', 'runtime', 'engine.js');
    await mkdir(dirname(compilerRunnerPath), { recursive: true });
    await mkdir(dirname(publishedRunnerPath), { recursive: true });
    const publishedRunnerBytes = 'export const createSessionOwnerAgentRuntime = () => ({ published: true });\n';
    await writeFile(compilerPackageEntryPath, 'export const packageRootExport = true;\n', 'utf8');
    await writeFile(compilerRunnerPath, 'export const createSessionOwnerAgentRuntime = () => ({});\n', 'utf8');
    await writeFile(daemonEntryPath, 'export const activate = () => undefined;\n', 'utf8');
    await writeFile(publishedRunnerPath, publishedRunnerBytes, 'utf8');
    await writeFile(join(installedRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugins-session-owner',
    }), 'utf8');
    await writeFile(join(installedRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'happier.agent.session-owner',
      version: '1.0.0',
      displayName: 'Session owner',
      engines: { happier: '^0.3.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    }), 'utf8');

    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-session-owner'],
      immutableArtifactEntryPathsByPackageName: new Map([
        ['@happier-dev/plugins-session-owner', daemonEntryPath],
      ]),
      immutableArtifactRootPathsByPackageName: new Map([
        ['@happier-dev/plugins-session-owner', installedRoot],
      ]),
      canImportFirstPartyPluginSource: () => true,
      importModule,
      prepareSourceDevSharedDeps: async () => syncedPreflight,
      repoRoot: join(tempDir, 'unrelated-source-checkout'),
    });
    const source = resolveActivationSource({
      pluginId: 'happier.agent.session-owner',
      daemonEntryPath: '@happier-dev/plugins-session-owner',
    });

    await source?.load();
    expect(imported).toEqual([pathToFileURL(daemonEntryPath).href]);

    const resolved = await source?.resolveRelativeModule('./agent/runtime/engine');
    expect(resolved?.normalizedModulePath).toBe('.happier-plugin/agent/runtime/engine.js');
    expect(imported.at(-1)).toBe(pathToFileURL(await realpath(publishedRunnerPath)).href);
  });

  it('falls back to first-party plugin dist when source is unavailable', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      existsSync: (path) => path === '/repo/packages/plugins/scm-git/dist/index.js',
      importModule,
      prepareSourceDevSharedDeps: async () => distOnlyPreflight,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/scm-git\/dist\/index\.js$/u);
  });

  it('rejects a corrupt admitted flat plugin copy before import under inherited test-process env', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-flat-copy-corrupt-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    const { outputPath } = await writeFlatAdmittedPluginCopy({
      cliProjectPath,
      workspaceName: 'plugins-scm-git',
    });
    await writeFile(outputPath, 'export const admitted = false;\n', 'utf8');
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
      admittedCopyOnly?: boolean;
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
        processEnv: {
          VITEST: 'true',
          NODE_ENV: 'test',
        },
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).rejects.toThrow('admitted source snapshot');
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
      admittedCopyOnly: true,
    });
    expect(importModule).not.toHaveBeenCalled();
  });

  it('imports a valid admitted flat plugin copy after local preflight under inherited test-process env', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-flat-copy-valid-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    await writeFlatAdmittedPluginCopy({
      cliProjectPath,
      workspaceName: 'plugins-scm-git',
    });
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
      admittedCopyOnly?: boolean;
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
        processEnv: {
          VITEST: 'true',
          NODE_ENV: 'test',
        },
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).resolves.toBe(pluginModuleFixture);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
      admittedCopyOnly: true,
    });
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('keeps an ordinary test-process dist load without local admission free of live preflight', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-bundled-no-admission-'));
    tempDirs.push(tempDir);
    const cliProjectPath = join(tempDir, 'flat-cli-copy');
    await mkdir(cliProjectPath, { recursive: true });
    const runSyncProcess = vi.fn();
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn((params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
      admittedCopyOnly?: boolean;
    }>) =>
      prepareSourceDevSharedDepsForBundledPluginRuntimeLoad({
        ...params,
        cliProjectPath,
        processEnv: {
          VITEST: 'true',
          NODE_ENV: 'test',
        },
        runSyncProcess,
      }));
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: () => false,
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: join(tempDir, 'outside-flat-copy'),
    });

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).resolves.toBe(pluginModuleFixture);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
      admittedCopyOnly: true,
    });
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(runSyncProcess).not.toHaveBeenCalled();
  });

  it('shares one deterministic source-dev shared-deps closure preflight across distinct bundled plugin source loads', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    let releasePreflight!: () => void;
    const prepareSourceDevSharedDeps = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      return syncedPreflight;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: [
        '@happier-dev/plugins-scm-sapling',
        '@happier-dev/plugins-scm-git',
        '@happier-dev/plugins-scm-sapling',
      ],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path.endsWith('/src/index.ts'),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    const firstLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();
    const secondLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.sapling',
      daemonEntryPath: '@happier-dev/plugins-scm-sapling',
    })?.load();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(1);
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledWith({
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git', 'plugins-scm-sapling'],
    });
    expect(importModule).not.toHaveBeenCalled();

    releasePreflight();
    await Promise.all([firstLoad, secondLoad]);

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('falls back to isolated package-local preflight in the same load after closure preflight failure', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    let saplingAttempts = 0;
    const prepareSourceDevSharedDeps = vi.fn(async (params: Readonly<{
      packageName: string;
      workspaceNames?: readonly string[];
    }>) => {
      if ((params.workspaceNames?.length ?? 0) > 1) {
        return {
          type: 'error' as const,
          errorMessage: 'bundled plugin workspace closure is stale',
        };
      }
      if (params.packageName === '@happier-dev/plugins-scm-sapling') {
        saplingAttempts += 1;
        if (saplingAttempts > 1) return syncedPreflight;
        return {
          type: 'error' as const,
          errorMessage: 'sapling workspace is stale',
        };
      }
      return syncedPreflight;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: [
        '@happier-dev/plugins-scm-git',
        '@happier-dev/plugins-scm-sapling',
      ],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path.endsWith('/src/index.ts'),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    const gitSource = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    });
    const saplingSource = resolveActivationSource({
      pluginId: 'happier.scm.backend.sapling',
      daemonEntryPath: '@happier-dev/plugins-scm-sapling',
    });

    await expect(Promise.allSettled([
      gitSource?.load(),
      saplingSource?.load(),
    ])).resolves.toEqual([
      expect.objectContaining({
        status: 'fulfilled',
        value: pluginModuleFixture,
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'sapling workspace is stale' }),
      }),
    ]);
    await expect(saplingSource?.load()).resolves.toBe(pluginModuleFixture);

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(4);
    expect(prepareSourceDevSharedDeps.mock.calls).toEqual([
      [{
        packageName: '@happier-dev/plugins-scm-git',
        workspaceNames: ['plugins-scm-git', 'plugins-scm-sapling'],
      }],
      [{
        packageName: '@happier-dev/plugins-scm-git',
        workspaceNames: ['plugins-scm-git'],
      }],
      [{
        packageName: '@happier-dev/plugins-scm-sapling',
        workspaceNames: ['plugins-scm-sapling'],
      }],
      [{
        packageName: '@happier-dev/plugins-scm-sapling',
        workspaceNames: ['plugins-scm-sapling'],
      }],
    ]);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-flight source-dev shared-deps preflight for the same bundled plugin target', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    let releasePreflight!: () => void;
    const prepareSourceDevSharedDeps = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      return syncedPreflight;
    });
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path.endsWith('/src/index.ts'),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    const firstLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();
    const secondLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(1);
    releasePreflight();
    await Promise.all([firstLoad, secondLoad]);

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('retries source-dev shared-deps preflight after a transient bundled plugin load failure', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn()
      .mockResolvedValueOnce({
        type: 'error' as const,
        errorMessage: 'source-dev shared deps are temporarily locked',
      })
      .mockResolvedValueOnce(syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-scm-git'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => path === '/repo/packages/plugins/scm-git/src/index.ts',
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });
    const source = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    });

    await expect(source?.load()).rejects.toThrow('source-dev shared deps are temporarily locked');
    await expect(source?.load()).resolves.toBe(pluginModuleFixture);

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(2);
    expect(importModule).toHaveBeenCalledTimes(1);
  });
});
