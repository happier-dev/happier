import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolvePluginDevWatchEnabled,
  resolvePluginDevWatchEntries,
  startPluginDevReloadWatcher,
  type PluginDevWatchInputPlugin,
} from './devPluginWatcher';

function plugin(params: Readonly<{
  pluginId: string;
  root: string;
  trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
  kind?: 'path' | 'archive' | 'marketplace';
  devWatch?: boolean;
  devEntry?: string | null;
}>): PluginDevWatchInputPlugin {
  return {
    pluginId: params.pluginId,
    pluginRootPath: params.root,
    manifestPath: join(params.root, '.happier-plugin', 'plugin.json'),
    daemonEntryPath: join(params.root, 'dist', 'daemon.mjs'),
    devDaemonEntryPath: params.devEntry === undefined
      ? join(params.root, 'src', 'daemon.ts')
      : params.devEntry,
    sourceSpec: {
      kind: params.kind ?? 'path',
      locator: params.root,
      trustPolicy: params.trustPolicy ?? 'local_trusted',
      installPolicy: params.kind === 'archive' ? 'managed_install' : 'link',
      devWatch: params.devWatch,
    },
  };
}

describe('plugin dev reload watcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('selects source directories only for dev-watched local trusted path plugins', () => {
    const devRoot = '/workspace/plugins/acme-dev';
    const entries = resolvePluginDevWatchEntries([
      plugin({ pluginId: 'acme.dev', root: devRoot, devWatch: true }),
      plugin({ pluginId: 'acme.prompt', root: '/workspace/plugins/acme-prompt', trustPolicy: 'prompt', devWatch: true }),
      plugin({ pluginId: 'acme.archive', root: '/workspace/plugins/acme-archive', kind: 'archive', devWatch: true }),
      plugin({ pluginId: 'acme.disabled', root: '/workspace/plugins/acme-disabled', devWatch: false }),
    ], { globalEnabled: true });

    expect(entries).toEqual([
      {
        pluginId: 'acme.dev',
        watchPaths: [
          devRoot,
          join(devRoot, '.happier-plugin'),
          join(devRoot, 'src'),
        ],
      },
    ]);
  });

  it('does not watch any plugin when the daemon dev-watch setting is disabled', () => {
    expect(resolvePluginDevWatchEntries([
      plugin({ pluginId: 'acme.dev', root: '/workspace/plugins/acme-dev', devWatch: true }),
    ], { globalEnabled: false })).toEqual([]);
  });

  it('defaults daemon dev-watch on unless settings explicitly disable it', () => {
    expect(resolvePluginDevWatchEnabled(null)).toBe(true);
    expect(resolvePluginDevWatchEnabled({})).toBe(true);
    expect(resolvePluginDevWatchEnabled({ plugins: {} })).toBe(true);
    expect(resolvePluginDevWatchEnabled({ plugins: { devWatch: true } })).toBe(true);
    expect(resolvePluginDevWatchEnabled({ plugins: { devWatch: false } })).toBe(false);
  });

  it('debounces source changes into one reload per plugin id', async () => {
    vi.useFakeTimers();
    const root = '/workspace/plugins/acme-dev';
    const callbacks = new Map<string, (path: string) => void>();
    const stopFns: Array<ReturnType<typeof vi.fn>> = [];
    const reload = vi.fn(async () => ({
      ok: true as const,
      diagnostics: [],
    }));

    const handle = await startPluginDevReloadWatcher({
      plugins: [
        plugin({ pluginId: 'acme.dev', root, devWatch: true }),
      ],
      globalEnabled: true,
      debounceMs: 50,
      startWatchingPath: (path, onChange, options) => {
        expect(options).toEqual({ emitInitial: false });
        callbacks.set(path, onChange);
        const stop = vi.fn();
        stopFns.push(stop);
        return stop;
      },
      reload,
    });

    callbacks.get(root)?.(root);
    callbacks.get(join(root, 'src'))?.(join(root, 'src', 'daemon.ts'));

    await vi.advanceTimersByTimeAsync(49);
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith({ pluginId: 'acme.dev' });

    handle.stop();
    expect(stopFns).toHaveLength(3);
    expect(stopFns.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it('starts watching a plugin installed after the watcher started once refresh() is called', async () => {
    const existingRoot = '/workspace/plugins/existing-dev';
    const newRoot = '/workspace/plugins/late-dev';
    const stopFnsByPath = new Map<string, ReturnType<typeof vi.fn>>();
    const startedPaths: string[] = [];

    const handle = await startPluginDevReloadWatcher({
      plugins: [
        plugin({ pluginId: 'acme.existing', root: existingRoot, devWatch: true }),
      ],
      globalEnabled: true,
      startWatchingPath: (path) => {
        startedPaths.push(path);
        const stop = vi.fn();
        stopFnsByPath.set(path, stop);
        return stop;
      },
      reload: vi.fn(async () => ({ ok: true as const, diagnostics: [] })),
    });

    expect(handle.watchedPluginIds).toEqual(['acme.existing']);
    const startedCountBeforeRefresh = startedPaths.length;

    // Simulate a plugin installed with --dev while the daemon (and this watcher) is
    // already running: the newly installed plugin is not watched until refresh() runs.
    await handle.refresh({
      plugins: [
        plugin({ pluginId: 'acme.existing', root: existingRoot, devWatch: true }),
        plugin({ pluginId: 'acme.late', root: newRoot, devWatch: true }),
      ],
    });

    expect(handle.watchedPluginIds.slice().sort()).toEqual(['acme.existing', 'acme.late']);
    expect(handle.watchedPathsByPluginId['acme.late']).toEqual([
      newRoot,
      join(newRoot, '.happier-plugin'),
      join(newRoot, 'src'),
    ]);
    // The pre-existing plugin's live fs watchers were not torn down/restarted.
    expect(startedPaths.length).toBeGreaterThan(startedCountBeforeRefresh);
    for (const path of handle.watchedPathsByPluginId['acme.existing'] ?? []) {
      expect(stopFnsByPath.get(path)?.mock.calls.length ?? 0).toBe(0);
    }

    handle.stop();
  });

  it('stops watching a plugin uninstalled while the watcher is running once refresh() is called', async () => {
    const root = '/workspace/plugins/acme-dev';
    const stopFnsByPath = new Map<string, ReturnType<typeof vi.fn>>();

    const handle = await startPluginDevReloadWatcher({
      plugins: [
        plugin({ pluginId: 'acme.dev', root, devWatch: true }),
      ],
      globalEnabled: true,
      startWatchingPath: (path) => {
        const stop = vi.fn();
        stopFnsByPath.set(path, stop);
        return stop;
      },
      reload: vi.fn(async () => ({ ok: true as const, diagnostics: [] })),
    });

    expect(handle.watchedPluginIds).toEqual(['acme.dev']);
    const watchedPaths = handle.watchedPathsByPluginId['acme.dev'] ?? [];
    expect(watchedPaths.length).toBeGreaterThan(0);

    await handle.refresh({ plugins: [] });

    expect(handle.watchedPluginIds).toEqual([]);
    expect(handle.watchedPathsByPluginId['acme.dev']).toBeUndefined();
    for (const path of watchedPaths) {
      expect(stopFnsByPath.get(path)?.mock.calls.length).toBe(1);
    }

    handle.stop();
  });
});
