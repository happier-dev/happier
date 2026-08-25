import {
  PluginScaffoldUiModeSchema,
  type ActionExecutorContext,
  type PluginDevLoopActionIdV1,
} from '@happier-dev/protocol';

import { installPluginFromLocator } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { uninstallPluginFromCatalog } from '@/plugins/projection/catalog/installed';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import {
  readUserPluginChangeStatus,
  requestUserPluginChange,
} from '@/plugins/daemon/changeClient';
import { projectPluginCatalogEntrySnapshot } from '@/plugins/projection/introspection/catalogSnapshot';
import { runPluginDevelopmentCycle } from '@/plugins/authoring/developmentCycle';
import { inspectPluginDevelopmentSource } from '@/plugins/authoring/sourceObserver';
import { runPluginAuthorToolchain, type PluginAuthorToolchainOperation } from '@/plugins/authoring/toolchain';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import { packLocalPlugin } from '@/plugins/packaging/pack';

export type PluginDevLoopActionId = PluginDevLoopActionIdV1;

export type PluginDevLoopActionServices = Readonly<{
  runPluginAuthorToolchain?: typeof runPluginAuthorToolchain;
  runPluginAuthorDoctor?: typeof runPluginAuthorDoctor;
  packLocalPlugin?: typeof packLocalPlugin;
  readUserPluginChangeStatus?: typeof readUserPluginChangeStatus;
  inspectPluginDevelopmentSource?: typeof inspectPluginDevelopmentSource;
  requestUserPluginChange?: typeof requestUserPluginChange;
}>;

type PluginDevLoopActionInput = Readonly<Record<string, unknown>>;

export type ExecutePluginDevLoopActionParams = Readonly<{
  actionId: PluginDevLoopActionId;
  input: unknown;
  happyHomeDir?: string;
  workspaceRoot?: string;
  /**
   * Narrow canonical Action context. The executor remains the sole caller
   * policy owner; the development cycle consumes only its cancellation signal.
   */
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'signal'>;
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
>, actionKind: 'plugins_dev_submit' | 'plugins_reload') {
  const code = result.kind === 'failed' || result.kind === 'unavailable'
    ? result.code
    : `plugin_change_${result.kind}`;
  return {
    ok: false,
    kind: actionKind,
    diagnostics: [{
      code,
      // A preparation failure only stays diagnosable when its cause travels with
      // the typed result. The daemon already redacted and byte-bounded that text
      // before it left the change service, so it is reported verbatim here.
      message: (result.kind === 'failed' ? result.message : undefined)
        ?? `The daemon rejected the development ${actionKind === 'plugins_reload' ? 'reload' : 'update'} (${result.kind}).`,
    }],
  };
}

type PluginPendingReview = Extract<
  Awaited<ReturnType<typeof requestUserPluginChange>>,
  Readonly<{ kind: 'sourceRootReviewRequired' | 'reviewRequired' }>
>;

function isPluginPendingReview(
  result: Awaited<ReturnType<typeof requestUserPluginChange>>,
): result is PluginPendingReview {
  return result.kind === 'sourceRootReviewRequired' || result.kind === 'reviewRequired';
}

function projectPendingReview(
  actionKind: 'plugins_dev_submit' | 'plugins_install' | 'plugins_reload',
  pendingReview: PluginPendingReview,
) {
  return {
    ok: false,
    kind: actionKind,
    outcome: 'reviewRequired' as const,
    // The exact daemon-issued union remains the only pending-decision
    // authority. An Action can report it but cannot decide it or add user
    // evidence.
    pendingReview,
  };
}

async function runPluginDevelopmentAction(params: Readonly<{
  actionKind: 'plugins_dev_submit' | 'plugins_reload';
  projectRoot: string;
  pluginId?: string;
  sdkRegistryOrigin?: string;
  signal?: AbortSignal;
  services: PluginDevLoopActionServices;
}>): Promise<unknown> {
  const inspect = params.services.inspectPluginDevelopmentSource ?? inspectPluginDevelopmentSource;
  const sourceInspection = await inspect({
    projectRoot: params.projectRoot,
    ...(params.sdkRegistryOrigin ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
  });
  if (!sourceInspection.ok) {
    return {
      ok: false,
      kind: params.actionKind,
      diagnostics: sourceInspection.diagnostics,
    };
  }

  const submit = params.services.requestUserPluginChange ?? requestUserPluginChange;
  const cycle = await runPluginDevelopmentCycle<Awaited<ReturnType<typeof requestUserPluginChange>>>({
    observation: Object.freeze({
      ...sourceInspection,
      request: Object.freeze({
        ...sourceInspection.request,
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
      }),
    }),
    submit: async (request, options) => await submit({
      request: {
        kind: 'development',
        ...(request.pluginId ? { pluginId: request.pluginId } : {}),
        sourceRootPath: request.projectRoot,
        ...(request.changedPaths ? { changedPaths: request.changedPaths } : {}),
        ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
      },
      approval: 'none',
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (cycle.kind !== 'submitted') {
    return {
      ok: false,
      kind: params.actionKind,
      diagnostics: cycle.kind === 'cancelled'
        ? [{
            code: 'plugin_dev_cancelled',
            message: 'Plugin development was cancelled before the candidate was applied.',
          }]
        : cycle.diagnostics,
    };
  }

  const result = cycle.submission;
  if (isPluginPendingReview(result)) return projectPendingReview(params.actionKind, result);
  if (result.kind !== 'committed') return summarizePluginChangeFailure(result, params.actionKind);
  return {
    ok: result.desiredGeneration === result.appliedGeneration,
    kind: params.actionKind,
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

export async function executePluginDevLoopAction(
  params: ExecutePluginDevLoopActionParams,
  services: PluginDevLoopActionServices = {},
): Promise<unknown> {
  const input = readInput(params.input);

  if (
    params.actionId === 'plugins.dev.install'
    || params.actionId === 'plugins.dev.typecheck'
    || params.actionId === 'plugins.dev.build'
    || params.actionId === 'plugins.dev.test'
  ) {
    const operation: PluginAuthorToolchainOperation = params.actionId === 'plugins.dev.install'
      ? 'install'
      : params.actionId === 'plugins.dev.typecheck'
        ? 'typecheck'
        : params.actionId === 'plugins.dev.build'
          ? 'build'
          : 'test';
    const sdkRegistryOrigin = readString(input, 'sdkRegistryOrigin');
    const result = await (services.runPluginAuthorToolchain ?? runPluginAuthorToolchain)({
      operation,
      projectRoot: readString(input, 'projectRoot'),
      ...(sdkRegistryOrigin
        ? { sdkRegistryOrigin }
        : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
    });
    return result.ok
      ? {
          ok: true,
          kind: `plugins_dev_${operation}`,
          operation: result.operation,
          projectRoot: result.projectRoot,
        }
      : {
          ok: false,
          kind: `plugins_dev_${operation}`,
          diagnostics: result.diagnostics,
        };
  }

  if (params.actionId === 'plugins.doctor') {
    const result = await (services.runPluginAuthorDoctor ?? runPluginAuthorDoctor)({
      locator: readString(input, 'locator'),
    });
    return result.ok
      ? {
          ok: true,
          kind: 'plugins_doctor',
          pluginId: result.pluginId,
          version: result.version,
          entryPath: result.entryPath,
          evaluationMs: result.evaluationMs,
          diagnostics: result.diagnostics,
        }
      : {
          ok: false,
          kind: 'plugins_doctor',
          diagnostics: result.diagnostics,
        };
  }

  if (params.actionId === 'plugins.pack') {
    const result = await (services.packLocalPlugin ?? packLocalPlugin)({
      locator: readString(input, 'locator'),
      ...(readString(input, 'outPath') ? { outPath: readString(input, 'outPath') } : {}),
      ...(readString(input, 'sdkRegistryOrigin')
        ? { sdkRegistryOrigin: readString(input, 'sdkRegistryOrigin') }
        : {}),
    });
    return result.ok
      ? {
          ok: true,
          kind: 'plugins_pack',
          plugin: {
            pluginId: result.pluginId,
            title: result.title,
            version: result.version,
          },
          package: {
            packageRootPath: result.packageRootPath,
            manifestPath: result.manifestPath,
            archivePath: result.archivePath,
            archiveDigest: result.archiveDigest,
            archiveIntegrity: result.archiveIntegrity,
            digestPath: result.digestPath,
            archiveSizeBytes: result.archiveSizeBytes,
          },
        }
      : {
          ok: false,
          kind: 'plugins_pack',
          diagnostics: result.diagnostics,
        };
  }

  if (params.actionId === 'plugins.change.status') {
    const status = await (services.readUserPluginChangeStatus ?? readUserPluginChangeStatus)({
      pendingChangeId: readString(input, 'pendingChangeId'),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
    });
    return {
      ok: true,
      kind: 'plugins_change_status',
      status,
    };
  }

  if (params.actionId === 'plugins.dev.submit') {
    const projectRoot = readString(input, 'projectRoot');
    const sdkRegistryOrigin = readString(input, 'sdkRegistryOrigin');
    return await runPluginDevelopmentAction({
      actionKind: 'plugins_dev_submit',
      projectRoot,
      ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
      services,
    });
  }

  if (params.actionId === 'plugins.scaffold') {
    const result = await scaffoldLocalPlugin({
      targetDir: readString(input, 'targetDir'),
      baseDir: params.workspaceRoot,
      pluginId: readString(input, 'id'),
      displayName: readString(input, 'name'),
      ...(() => {
        // One vocabulary: the scaffold UI mode is resolved through the schema
        // the `plugins.scaffold` action input already validates against.
        const ui = PluginScaffoldUiModeSchema.safeParse(readString(input, 'ui'));
        return ui.success ? { ui: ui.data } : {};
      })(),
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
        outcome: 'failed',
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
      if (
        result.change?.kind === 'sourceRootReviewRequired'
        || result.change?.kind === 'reviewRequired'
      ) {
        return projectPendingReview('plugins_install', result.change);
      }
      return {
        ok: false,
        kind: 'plugins_install',
        outcome: 'failed',
        diagnostics: result.diagnostics,
      };
    }
    return {
      ok: true,
      kind: 'plugins_install',
      outcome: 'applied',
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
    return await runPluginDevelopmentAction({
      actionKind: 'plugins_reload',
      projectRoot: entry.source.locator,
      pluginId,
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
      services,
    });
  }

  if (params.actionId === 'plugins.list') {
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

  return {
    ok: false,
    kind: 'plugins_unknown',
    diagnostics: [{
      code: 'plugin_action_unsupported',
      message: `Unsupported plugin development Action: ${params.actionId}`,
    }],
  };
}
