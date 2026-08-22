import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => ({
  readEntry: vi.fn(),
}));
const sourceObserver = vi.hoisted(() => ({
  inspect: vi.fn(),
}));
const developmentCycle = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('@/plugins/projection/catalog/installed', () => ({
  installPluginFromLocator: vi.fn(),
  readInstalledPluginCatalog: vi.fn(),
  readInstalledPluginCatalogEntry: catalog.readEntry,
  uninstallPluginFromCatalog: vi.fn(),
}));
vi.mock('@/plugins/authoring/sourceObserver', () => ({
  inspectPluginDevelopmentSource: sourceObserver.inspect,
}));
vi.mock('@/plugins/authoring/developmentCycle', () => ({
  runPluginDevelopmentCycle: developmentCycle.run,
}));

import { executePluginDevLoopAction } from './actions';

describe('executePluginDevLoopAction cancellation', () => {
  beforeEach(() => {
    catalog.readEntry.mockReset();
    sourceObserver.inspect.mockReset();
    developmentCycle.run.mockReset();
  });

  it('forwards the canonical Action cancellation signal into the reload cycle', async () => {
    const controller = new AbortController();
    catalog.readEntry.mockResolvedValue({
      source: { kind: 'path', locator: '/plugins/acme.author' },
    });
    sourceObserver.inspect.mockResolvedValue({
      ok: true,
      sourceKind: 'packageRoot',
      authoringKind: 'code',
      sourceRootPath: '/plugins/acme.author',
      developmentEntryPath: '/plugins/acme.author/src/index.ts',
      observedRelativePaths: ['package.json', 'src/index.ts'],
      observedDirectoryPaths: ['/plugins/acme.author', '/plugins/acme.author/src'],
      declaredDependencies: {},
      request: {
        kind: 'development',
        pluginId: 'acme.author',
        projectRoot: '/plugins/acme.author',
      },
    });
    developmentCycle.run.mockResolvedValue({ kind: 'cancelled' });

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.reload',
      input: { pluginId: 'acme.author' },
      context: { signal: controller.signal },
    })).resolves.toMatchObject({
      ok: false,
      kind: 'plugins_reload',
      diagnostics: [{ code: 'plugin_dev_cancelled' }],
    });

    expect(developmentCycle.run).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
