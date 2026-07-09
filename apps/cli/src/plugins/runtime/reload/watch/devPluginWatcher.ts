import { dirname, resolve } from 'node:path';

import type { PluginSourceInstallPolicyV1, PluginSourceKindV1, PluginSourceTrustPolicyV1 } from '@happier-dev/protocol';

import { startFileWatcher, type StartFileWatcherOptions } from '@/integrations/watcher/startFileWatcher';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { isTrustPolicyLocallyTrusted } from '@/plugins/install/ui/trustedSource';
import { logger } from '@/ui/logger';

import type { PluginReloadController } from '../controller';
import { pluginReloadController } from '../singleton';

const DEFAULT_PLUGIN_DEV_RELOAD_DEBOUNCE_MS = 250;

type PluginDevWatchSourceSpec = Readonly<{
  kind: PluginSourceKindV1;
  locator?: string;
  trustPolicy?: PluginSourceTrustPolicyV1;
  installPolicy?: PluginSourceInstallPolicyV1;
  devWatch?: boolean;
}>;

export type PluginDevWatchInputPlugin = Readonly<{
  pluginId: string;
  pluginRootPath: string;
  manifestPath: string;
  daemonEntryPath: string | null;
  devDaemonEntryPath?: string | null;
  sourceSpec: PluginDevWatchSourceSpec;
}>;

export type PluginDevWatchEntry = Readonly<{
  pluginId: string;
  watchPaths: readonly string[];
}>;

export type PluginDevReloadWatcherHandle = Readonly<{
  readonly watchedPluginIds: readonly string[];
  readonly watchedPathsByPluginId: Readonly<Record<string, readonly string[]>>;
  stop: () => void;
  /**
   * Resyncs the watched-plugin set. Call this whenever the installed/active dev-plugin
   * set may have changed (install, uninstall, enable/disable, reload) so plugins
   * installed after the watcher started begin (or stop) being watched. Diffs against
   * the currently watched paths so unaffected plugins keep their live fs watchers.
   */
  refresh: (params?: Readonly<{ plugins?: readonly PluginDevWatchInputPlugin[] }>) => Promise<void>;
}>;

type StartWatchingPath = (
  path: string,
  onPathChanged: (path: string) => void,
  options?: StartFileWatcherOptions,
) => () => void;

type ReloadPlugin = (params: Readonly<{ pluginId: string }>) => Promise<unknown>;

export function resolvePluginDevWatchEnabled(settings: Readonly<{
  plugins?: Readonly<{
    devWatch?: boolean;
  }>;
}> | null | undefined): boolean {
  return settings?.plugins?.devWatch !== false;
}

function uniqueResolvedPaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = resolve(path);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return Object.freeze(result);
}

function isDevWatchSourceEnabled(sourceSpec: PluginDevWatchSourceSpec): boolean {
  return sourceSpec.kind === 'path'
    && sourceSpec.installPolicy === 'link'
    && isTrustPolicyLocallyTrusted(sourceSpec.trustPolicy)
    && sourceSpec.devWatch === true;
}

export function resolvePluginDevWatchEntries(
  plugins: readonly PluginDevWatchInputPlugin[],
  options?: Readonly<{ globalEnabled?: boolean }>,
): readonly PluginDevWatchEntry[] {
  if (options?.globalEnabled === false) {
    return Object.freeze([]);
  }

  const entries: PluginDevWatchEntry[] = [];
  for (const plugin of plugins) {
    if (!isDevWatchSourceEnabled(plugin.sourceSpec)) {
      continue;
    }

    const watchedEntrypoint = plugin.devDaemonEntryPath ?? plugin.daemonEntryPath;
    entries.push({
      pluginId: plugin.pluginId,
      watchPaths: uniqueResolvedPaths([
        plugin.pluginRootPath,
        dirname(plugin.manifestPath),
        ...(watchedEntrypoint ? [dirname(watchedEntrypoint)] : []),
      ]),
    });
  }
  return Object.freeze(entries);
}

function normalizeDebounceMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PLUGIN_DEV_RELOAD_DEBOUNCE_MS;
  }
  return Math.max(0, Math.trunc(value));
}

type PluginWatchState = Readonly<{
  paths: readonly string[];
  stopFnsByPath: ReadonlyMap<string, () => void>;
}>;

export async function startPluginDevReloadWatcher(params?: Readonly<{
  happyHomeDir?: string;
  plugins?: readonly PluginDevWatchInputPlugin[];
  globalEnabled?: boolean;
  debounceMs?: number;
  startWatchingPath?: StartWatchingPath;
  reload?: ReloadPlugin;
}>): Promise<PluginDevReloadWatcherHandle> {
  const startWatchingPath = params?.startWatchingPath ?? startFileWatcher;
  const reload = params?.reload ?? pluginReloadController.reload.bind(pluginReloadController) as PluginReloadController['reload'];
  const debounceMs = normalizeDebounceMs(params?.debounceMs);
  const pendingReloads = new Map<string, ReturnType<typeof setTimeout>>();
  const watchStateByPluginId = new Map<string, PluginWatchState>();
  let stopped = false;
  let refreshChain: Promise<void> = Promise.resolve();

  const scheduleReload = (pluginId: string): void => {
    if (stopped) {
      return;
    }
    const existingTimer = pendingReloads.get(pluginId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      pendingReloads.delete(pluginId);
      if (stopped) {
        return;
      }
      void reload({ pluginId }).catch((error) => {
        logger.debug(`[PLUGIN DEV WATCH] Reload failed for ${pluginId}`, error);
      });
    }, debounceMs);
    timer.unref?.();
    pendingReloads.set(pluginId, timer);
  };

  const cancelPendingReload = (pluginId: string): void => {
    const timer = pendingReloads.get(pluginId);
    if (timer) {
      clearTimeout(timer);
      pendingReloads.delete(pluginId);
    }
  };

  const startWatchesForEntry = (entry: PluginDevWatchEntry): Map<string, () => void> => {
    const stopFnsByPath = new Map<string, () => void>();
    for (const path of entry.watchPaths) {
      stopFnsByPath.set(path, startWatchingPath(path, () => {
        scheduleReload(entry.pluginId);
      }, { emitInitial: false }));
    }
    return stopFnsByPath;
  };

  const applyEntries = (nextEntries: readonly PluginDevWatchEntry[]): void => {
    if (stopped) {
      return;
    }
    const nextPluginIds = new Set(nextEntries.map((entry) => entry.pluginId));

    for (const [pluginId, state] of [...watchStateByPluginId]) {
      if (nextPluginIds.has(pluginId)) {
        continue;
      }
      for (const stop of state.stopFnsByPath.values()) {
        stop();
      }
      watchStateByPluginId.delete(pluginId);
      cancelPendingReload(pluginId);
    }

    for (const entry of nextEntries) {
      const existing = watchStateByPluginId.get(entry.pluginId);
      if (!existing) {
        watchStateByPluginId.set(entry.pluginId, {
          paths: entry.watchPaths,
          stopFnsByPath: startWatchesForEntry(entry),
        });
        continue;
      }

      const nextPathSet = new Set(entry.watchPaths);
      const nextStopFnsByPath = new Map(existing.stopFnsByPath);
      for (const [path, stop] of existing.stopFnsByPath) {
        if (!nextPathSet.has(path)) {
          stop();
          nextStopFnsByPath.delete(path);
        }
      }
      for (const path of entry.watchPaths) {
        if (nextStopFnsByPath.has(path)) {
          continue;
        }
        nextStopFnsByPath.set(path, startWatchingPath(path, () => {
          scheduleReload(entry.pluginId);
        }, { emitInitial: false }));
      }
      watchStateByPluginId.set(entry.pluginId, {
        paths: entry.watchPaths,
        stopFnsByPath: nextStopFnsByPath,
      });
    }
  };

  const resolveNextEntries = async (
    plugins?: readonly PluginDevWatchInputPlugin[],
  ): Promise<readonly PluginDevWatchEntry[]> => {
    const resolvedPlugins = plugins ?? (await loadInstalledPlugins({
      happyHomeDir: params?.happyHomeDir,
    })).loadedPlugins;
    return resolvePluginDevWatchEntries(resolvedPlugins, {
      globalEnabled: params?.globalEnabled,
    });
  };

  const initialEntries = await resolveNextEntries(params?.plugins);
  applyEntries(initialEntries);

  const refresh = (refreshParams?: Readonly<{ plugins?: readonly PluginDevWatchInputPlugin[] }>): Promise<void> => {
    refreshChain = refreshChain
      .then(async () => {
        if (stopped) {
          return;
        }
        const nextEntries = await resolveNextEntries(refreshParams?.plugins);
        applyEntries(nextEntries);
      })
      .catch((error) => {
        logger.debug('[PLUGIN DEV WATCH] Failed to resync dev watch entries', error);
      });
    return refreshChain;
  };

  return {
    get watchedPluginIds() {
      return Object.freeze([...watchStateByPluginId.keys()]);
    },
    get watchedPathsByPluginId() {
      const result: Record<string, readonly string[]> = {};
      for (const [pluginId, state] of watchStateByPluginId) {
        result[pluginId] = state.paths;
      }
      return Object.freeze(result);
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const timer of pendingReloads.values()) {
        clearTimeout(timer);
      }
      pendingReloads.clear();
      for (const state of watchStateByPluginId.values()) {
        for (const stop of state.stopFnsByPath.values()) {
          stop();
        }
      }
      watchStateByPluginId.clear();
    },
    refresh,
  };
}
