import { describe, expect, it, vi } from 'vitest';

const installedBoundary = vi.hoisted(() => ({
  readInstalledPluginCatalog: vi.fn(async () => []),
}));

vi.mock('@/plugins/projection/catalog/installed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/projection/catalog/installed')>();
  return {
    ...actual,
    readInstalledPluginCatalog: installedBoundary.readInstalledPluginCatalog,
  };
});

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

describe('readCurrentDaemonPluginCatalogSnapshot', () => {
  it('fails tool projection closed when no current runtime lease is available', async () => {
    const reloadController = {
      tryAcquireRuntimeRegistry: () => null,
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({
      reloadController,
      happyHomeDir: '/test/home',
    })).resolves.toEqual({
      plugins: [],
      tools: [],
    });
    expect(installedBoundary.readInstalledPluginCatalog).toHaveBeenCalledWith({
      happyHomeDir: '/test/home',
    });
  });

  it('releases the exact runtime lease after projecting the catalog', async () => {
    const release = vi.fn(async () => {});
    const registry = {
      contributes: {
        tools: [],
        actionsById: new Map(),
      },
    };
    const reloadController = {
      tryAcquireRuntimeRegistry: () => ({
        registry,
        source: 'active',
        release,
      }),
    } as unknown as PluginReloadController;

    await expect(readCurrentDaemonPluginCatalogSnapshot({
      reloadController,
    })).resolves.toEqual({
      plugins: [],
      tools: [],
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
