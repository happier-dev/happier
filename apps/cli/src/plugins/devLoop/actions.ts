import type { ActionId } from '@happier-dev/protocol';

import { installPluginFromLocator } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { uninstallPluginFromCatalog } from '@/plugins/projection/catalog/installed';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { requestUserPluginChange } from '@/plugins/daemon/changeClient';
import { projectPluginCatalogEntrySnapshot } from '@/plugins/projection/introspection/catalogSnapshot';

export type PluginDevLoopActionId = Extract<ActionId, 'plugins.scaffold' | 'plugins.install' | 'plugins.uninstall' | 'plugins.reload' | 'plugins.list'>;

type PluginDevLoopActionInput = Readonly<Record<string, unknown>>;

export type ExecutePluginDevLoopActionParams = Readonly<{
  actionId: PluginDevLoopActionId;
  input: unknown;
  happyHomeDir?: string;
  workspaceRoot?: string;
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
  return projectPluginCatalogEntrySnapshot(entry);
}

function summarizePluginChangeFailure(result: Exclude<
  Awaited<ReturnType<typeof requestUserPluginChange>>,
  { kind: 'committed' }
>) {
  const code = result.kind === 'failed' || result.kind === 'unavailable'
    ? result.code
    : `plugin_change_${result.kind}`;
  return {
    ok: false,
    kind: 'plugins_reload',
    diagnostics: [{
      code,
      message: `The daemon rejected the development reload (${result.kind}).`,
    }],
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
    if (!readBoolean(input, 'dryRun')) {
      return {
        ok: false,
        kind: 'plugins_install',
        diagnostics: [{
          code: 'plugin_install_review_unavailable',
          message: 'This ActionSpec cannot display and decide the daemon package review. Preview with dryRun, then use the CLI Install & Trust flow to install.',
        }],
      };
    }

    const result = await installPluginFromLocator({
      locator,
      happyHomeDir: params.happyHomeDir,
      skipIfInstalled: !readBoolean(input, 'force'),
      dryRun: true,
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

    return {
      ok: true,
      kind: 'plugins_uninstall',
      plugin: summarizeCatalogEntry(result.entry),
      removedInstalledPath: result.removedInstalledPath,
      change: result.change,
    };
  }

  if (params.actionId === 'plugins.reload') {
    const pluginId = readString(input, 'pluginId');
    if (!pluginId) {
      return {
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{
          code: 'plugin_manifest_semantic_invalid',
          message: 'plugins.reload requires a non-empty pluginId',
        }],
      };
    }
    const entry = await readInstalledPluginCatalogEntry({
      pluginId,
      happyHomeDir: params.happyHomeDir,
    });
    if (!entry) {
      return {
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{
          code: 'plugin_source_missing',
          message: `Installed plugin '${pluginId}' was not found`,
        }],
      };
    }
    if (entry.source.kind !== 'path') {
      return {
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{
          code: 'plugin_source_kind_unsupported',
          message: `Plugin '${pluginId}' is not installed from a local development path`,
        }],
      };
    }
    const result = await requestUserPluginChange({
      request: {
        kind: 'development',
        pluginId,
        sourceRootPath: entry.source.locator,
      },
      approval: 'none',
    });
    if (result.kind !== 'committed') return summarizePluginChangeFailure(result);
    return {
      ok: result.desiredGeneration === result.appliedGeneration,
      kind: 'plugins_reload',
      desiredGeneration: result.desiredGeneration,
      appliedGeneration: result.appliedGeneration,
      pendingSurfaces: result.pendingSurfaces,
      ...(result.desiredGeneration === result.appliedGeneration
        ? {}
        : {
            diagnostics: [{
              code: 'plugin_dev_adoption_pending',
              message: 'The daemon committed the development generation but has not applied it yet.',
            }],
          }),
    };
  }

  const catalog = await readDaemonPluginCatalog();
  if (catalog.kind !== 'available') {
    return {
      ok: false,
      kind: 'plugins_list',
      diagnostics: [{
        code: catalog.code,
        message: 'The active daemon plugin catalog is unavailable.',
      }],
    };
  }
  const entries = catalog.plugins;
  return {
    ok: true,
    kind: 'plugins_list',
    plugins: entries.map(summarizeCatalogEntry),
  };
}
