import { describe, expect, it, vi } from 'vitest';

import type { SourceDevSharedDepsPreflightResult } from '@/subprocess/sourceDevSharedDepsPreflight';

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

describe('createBundledActivationSourceResolver', () => {
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

  it('scopes source-dev shared-deps preflight to each bundled plugin source target', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async () => syncedPreflight);
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

    const firstLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load();
    const secondLoad = resolveActivationSource({
      pluginId: 'happier.scm.backend.sapling',
      daemonEntryPath: '@happier-dev/plugins-scm-sapling',
    })?.load();

    await Promise.all([firstLoad, secondLoad]);

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(2);
    expect(prepareSourceDevSharedDeps).toHaveBeenNthCalledWith(1, {
      packageName: '@happier-dev/plugins-scm-git',
      workspaceNames: ['plugins-scm-git'],
    });
    expect(prepareSourceDevSharedDeps).toHaveBeenNthCalledWith(2, {
      packageName: '@happier-dev/plugins-scm-sapling',
      workspaceNames: ['plugins-scm-sapling'],
    });
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('does not block one bundled plugin source load on an unrelated bundled plugin preflight failure', async () => {
    const importModule = vi.fn(async () => pluginModuleFixture);
    const prepareSourceDevSharedDeps = vi.fn(async (params: Readonly<{ packageName: string }>) => {
      if (params.packageName === '@happier-dev/plugins-scm-sapling') {
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

    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.git',
      daemonEntryPath: '@happier-dev/plugins-scm-git',
    })?.load()).resolves.toBe(pluginModuleFixture);
    await expect(resolveActivationSource({
      pluginId: 'happier.scm.backend.sapling',
      daemonEntryPath: '@happier-dev/plugins-scm-sapling',
    })?.load()).rejects.toThrow('sapling workspace is stale');

    expect(prepareSourceDevSharedDeps).toHaveBeenCalledTimes(2);
    expect(importModule).toHaveBeenCalledTimes(1);
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
