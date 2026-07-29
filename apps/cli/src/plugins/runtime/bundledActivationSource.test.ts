import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  type SourceDevSharedDepsPreflightResult,
} from '@/subprocess/sourceDevSharedDepsPreflight';

import { createBundledActivationSourceResolver } from './bundledActivationSource';
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

  it('loads inventory-admitted bundled artifacts from dist even in source development', async () => {
    const imported: string[] = [];
    const importModule = vi.fn(async (specifier: string) => {
      imported.push(specifier);
      return pluginModuleFixture;
    });
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
    const resolveActivationSource = createBundledActivationSourceResolver({
      bundledPackageNames: ['@happier-dev/plugins-review-coderabbit'],
      immutableArtifactPackageNames: ['@happier-dev/plugins-review-coderabbit'],
      canImportFirstPartyPluginSource: () => true,
      existsSync: (path) => (
        path === '/repo/packages/plugins/review-coderabbit/src/index.ts'
        || path === '/repo/packages/plugins/review-coderabbit/dist/index.js'
      ),
      importModule,
      prepareSourceDevSharedDeps,
      repoRoot: '/repo',
    });

    await resolveActivationSource({
      pluginId: 'happier.review.coderabbit',
      daemonEntryPath: '@happier-dev/plugins-review-coderabbit',
    })?.load();

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/packages\/plugins\/review-coderabbit\/dist\/index\.js$/u);
    expect(prepareSourceDevSharedDeps).not.toHaveBeenCalled();
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
