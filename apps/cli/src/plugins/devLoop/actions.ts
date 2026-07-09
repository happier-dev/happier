import type { ActionId } from '@happier-dev/protocol';

import { installPluginFromLocator } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { uninstallPluginFromCatalog } from '@/plugins/projection/catalog/installed';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

export type PluginDevLoopActionId = Extract<ActionId, 'plugins.scaffold' | 'plugins.install' | 'plugins.uninstall' | 'plugins.reload' | 'plugins.list'>;

type ReloadPlugin = PluginReloadController['reload'];

type PluginDevLoopActionInput = Readonly<Record<string, unknown>>;

export type ExecutePluginDevLoopActionParams = Readonly<{
  actionId: PluginDevLoopActionId;
  input: unknown;
  happyHomeDir?: string;
  workspaceRoot?: string;
  reload?: ReloadPlugin;
}>;

function readInput(input: unknown): PluginDevLoopActionInput {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as PluginDevLoopActionInput
    : {};
}

function readString(input: PluginDevLoopActionInput, key: string): string {
  return typeof input[key] === 'string' ? input[key].trim() : '';
}

function readBoolean(input: PluginDevLoopActionInput, key: string): boolean {
  return input[key] === true;
}

function isRemotePluginInstallLocator(locator: string): boolean {
  try {
    const parsed = new URL(locator);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function summarizeCatalogEntry(entry: Awaited<ReturnType<typeof readInstalledPluginCatalog>>[number]) {
  return {
    id: entry.pluginId,
    pluginId: entry.pluginId,
    version: entry.version,
    title: entry.title,
    state: entry.enabled ? 'enabled' : 'disabled',
    sourceKind: entry.source.kind,
    source: entry.source,
    install: entry.install,
    compatibility: entry.compatibility,
    manifestPath: entry.manifestPath,
    manifestDigest: entry.manifestDigest,
    contributions: entry.contributionIds,
    diagnostics: entry.diagnostics,
  };
}

function summarizeReloadResult(result: Awaited<ReturnType<ReloadPlugin>>) {
  return {
    ok: result.ok,
    generation: result.generation,
    attemptedGeneration: result.attemptedGeneration,
    requestedPluginIds: result.requestedPluginIds,
    changedPluginIds: result.changedPluginIds,
    affectedPluginIds: result.affectedPluginIds,
    activeGenerationId: result.activeGenerationId,
    registryStatus: result.registryStatus,
    diagnostics: result.diagnostics,
    diagnosticsByPluginId: result.diagnosticsByPluginId,
  };
}

export async function executePluginDevLoopAction(params: ExecutePluginDevLoopActionParams): Promise<unknown> {
  const input = readInput(params.input);

  if (params.actionId === 'plugins.scaffold') {
    const result = await scaffoldLocalPlugin({
      targetDir: readString(input, 'targetDir'),
      baseDir: params.workspaceRoot,
      pluginId: readString(input, 'id'),
      displayName: readString(input, 'name'),
      ...(readString(input, 'ui') ? { ui: readString(input, 'ui') as 'hostedWeb' } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: 'plugins_scaffold',
        diagnostics: result.diagnostics,
      };
    }
    return {
      ok: true,
      kind: 'plugins_scaffold',
      plugin: {
        pluginId: result.pluginId,
        title: result.title,
        version: result.version,
      },
      createdPaths: {
        targetDir: result.targetDir,
        manifestPath: result.manifestPath,
        packageJsonPath: result.packageJsonPath,
        sourceEntryPath: result.sourceEntryPath,
        ...(result.uiEntryPath ? { uiEntryPath: result.uiEntryPath } : {}),
      },
    };
  }

  if (params.actionId === 'plugins.install') {
    const locator = readString(input, 'path');
    if (isRemotePluginInstallLocator(locator)) {
      return {
        ok: false,
        kind: 'plugins_install',
        diagnostics: [
          {
            code: 'plugin_source_missing',
            message: 'plugins.install accepts a local plugin path. Install remote plugin archives through the CLI or marketplace flow.',
          },
        ],
      };
    }

    const result = await installPluginFromLocator({
      locator,
      happyHomeDir: params.happyHomeDir,
      skipIfInstalled: !readBoolean(input, 'force'),
      dryRun: readBoolean(input, 'dryRun'),
      dev: readBoolean(input, 'dev'),
      workspaceRoot: params.workspaceRoot,
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: 'plugins_install',
        diagnostics: result.diagnostics,
      };
    }
    return {
      ok: true,
      kind: 'plugins_install',
      alreadyInstalled: result.alreadyInstalled,
      plugin: summarizeCatalogEntry(result.entry),
    };
  }

  if (params.actionId === 'plugins.uninstall') {
    const pluginId = readString(input, 'pluginId');
    const result = await uninstallPluginFromCatalog({
      pluginId,
      happyHomeDir: params.happyHomeDir,
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: 'plugins_uninstall',
        diagnostics: result.diagnostics,
      };
    }

    const reload = params.reload ?? pluginReloadController.reload.bind(pluginReloadController);
    try {
      const reloadResult = await reload({ pluginId: result.pluginId });
      return {
        ok: reloadResult.ok,
        kind: 'plugins_uninstall',
        plugin: summarizeCatalogEntry(result.entry),
        removedInstalledPath: result.removedInstalledPath,
        reload: summarizeReloadResult(reloadResult),
        diagnostics: reloadResult.diagnostics,
        diagnosticsByPluginId: reloadResult.diagnosticsByPluginId,
      };
    } catch (error) {
      const diagnostics = [
        {
          code: 'plugin_reload_failed',
          message: error instanceof Error ? error.message : 'Plugin reload failed after uninstall',
        },
      ];
      return {
        ok: false,
        kind: 'plugins_uninstall',
        plugin: summarizeCatalogEntry(result.entry),
        removedInstalledPath: result.removedInstalledPath,
        reload: {
          ok: false,
          registryStatus: 'unavailable',
          diagnostics,
        },
        diagnostics,
        diagnosticsByPluginId: {},
      };
    }
  }

  if (params.actionId === 'plugins.reload') {
    const reload = params.reload ?? pluginReloadController.reload.bind(pluginReloadController);
    const pluginId = readString(input, 'pluginId');
    const result = await reload(pluginId ? { pluginId } : undefined);
    return {
      kind: 'plugins_reload',
      ...summarizeReloadResult(result),
    };
  }

  const entries = await readInstalledPluginCatalog({
    happyHomeDir: params.happyHomeDir,
  });
  return {
    ok: true,
    kind: 'plugins_list',
    plugins: entries.map(summarizeCatalogEntry),
  };
}
