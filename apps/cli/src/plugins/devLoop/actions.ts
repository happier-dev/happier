import { PluginScaffoldUiModeSchema, PluginScaffoldTemplateSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext, PluginDevLoopActionIdV1 } from '@happier-dev/protocol';

import { installPluginFromLocator } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalog } from '@/plugins/projection/catalog/installed';
import { readInstalledPluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { controlDaemonPluginDevelopment, listDaemonPluginChanges, readDaemonPluginCatalog } from '@/daemon/controlClient';
import {
  describeUserPluginChangeFailure,
  decideUserPluginChange,
  readUserPluginChangeStatus,
  requestUserPluginChange,
} from '@/plugins/daemon/changeClient';
import { projectPluginCatalogEntrySnapshot } from '@/plugins/projection/introspection/catalogSnapshot';
import { runPluginAuthorToolchain, type PluginAuthorToolchainOperation } from '@/plugins/authoring/toolchain';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { configuration } from '@/configuration';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { requestExactMarketplaceInstall } from '@/plugins/store/marketplace/exactInstall';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { resolveArchiveExpectedIntegrity } from '@/plugins/distribution/archive/integrity';
import type { PluginChangeRequest } from '@/plugins/daemon/changeContract';
import { ManagedResourceDispositionV1Schema } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { PluginUpdatePolicyV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';
import { setCurrentAccountPluginEnabled } from '@/plugins/runtime/accountPluginActivationSource';
import type { StoredCredentials } from '@/persistence';

export type PluginDevLoopActionId = PluginDevLoopActionIdV1;

type PluginPendingReview = Extract<
  Awaited<ReturnType<typeof requestUserPluginChange>>,
  Readonly<{ kind: 'reviewRequired' }>
>;

export type PluginDevLoopActionServices = Readonly<{
  account?: Readonly<{ credentials: StoredCredentials; serverUrl: string }>;
  runPluginAuthorToolchain?: typeof runPluginAuthorToolchain;
  runPluginAuthorDoctor?: typeof runPluginAuthorDoctor;
  packLocalPlugin?: typeof packLocalPlugin;
  readUserPluginChangeStatus?: typeof readUserPluginChangeStatus;
  requestUserPluginChange?: typeof requestUserPluginChange;
  decideUserPluginChange?: typeof decideUserPluginChange;
  controlPluginDevelopment?: typeof controlDaemonPluginDevelopment;
  /** Exact daemon candidate retained in the approval Artifact being replayed. */
  approvedInstallReview?: PluginPendingReview;
  /** Host-only effect admission from the canonical Action executor, including a policy waiver. */
  installEffectAdmitted?: true;
  /** Captured Account reader supplied by the production Action composition. */
  marketplaceIndexService?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'queryExactListing'>;
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
  context?: Pick<ActionExecutorContext, 'actionCaller' | 'signal' | 'presentUserApproval' | 'actionRequestId'>;
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

function isPluginPendingReview(
  result: Awaited<ReturnType<typeof requestUserPluginChange>>,
): result is PluginPendingReview {
  return result.kind === 'reviewRequired';
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
    // authority. Reporting it does not admit an effect or add user evidence.
    pendingReview,
  };
}

function projectInstallChangeFailure(
  change: Exclude<Awaited<ReturnType<typeof requestUserPluginChange>>, Readonly<{ kind: 'committed' }>>,
  fallbackMessage: string,
) {
  const failure = describeUserPluginChangeFailure(change);
  return {
    ok: false,
    kind: 'plugins_install' as const,
    outcome: 'failed' as const,
    change,
    diagnostics: [{ code: failure.code, message: failure.message || fallbackMessage }],
  };
}

async function settleApprovedInstallReview(
  pendingReview: PluginPendingReview,
  params: ExecutePluginDevLoopActionParams,
  services: PluginDevLoopActionServices,
): Promise<unknown> {
  const proof = params.context?.presentUserApproval;
  if (proof?.actionId !== 'plugins.install' && services.installEffectAdmitted !== true) {
    return projectPendingReview('plugins_install', pendingReview);
  }
  const outcome = await (services.decideUserPluginChange ?? decideUserPluginChange)({
    pendingChangeId: pendingReview.pendingChangeId,
    decision: 'approve',
    ...(params.context?.signal ? { signal: params.context.signal } : {}),
  });
  const settled = outcome.kind === 'terminal' ? outcome.result : outcome;
  if (settled.kind === 'committed') {
    return { ok: true, kind: 'plugins_install', outcome: 'applied', change: settled };
  }
  const errorCode = outcome.kind === 'terminal' || outcome.kind === 'reviewRequired'
    ? 'plugin_change_superseded'
    : outcome.kind === 'daemonUnavailable'
      ? 'plugin_change_daemon_unavailable'
      : `plugin_change_${outcome.kind}`;
  return {
    ok: false,
    errorCode,
    error: errorCode,
    details: { change: outcome },
  };
}

async function runPluginDevelopmentAction(params: Readonly<{
  actionKind: 'plugins_dev_submit' | 'plugins_dev_unregister' | 'plugins_reload';
  projectRoot: string;
  pluginId?: string;
  sdkRegistryOrigin?: string;
  signal?: AbortSignal;
  services: PluginDevLoopActionServices;
}>): Promise<unknown> {
  const control = params.services.controlPluginDevelopment ?? controlDaemonPluginDevelopment;
  const result = await control(
    params.actionKind === 'plugins_reload'
      ? { kind: 'reload', rootPath: params.projectRoot }
      : params.actionKind === 'plugins_dev_unregister'
        ? { kind: 'unregisterExplicit', rootPath: params.projectRoot }
        : {
          kind: 'registerExplicit',
          rootPath: params.projectRoot,
          ...(params.sdkRegistryOrigin ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
        },
    params.signal ? { signal: params.signal } : {},
  );
  if (result.kind === 'failed') {
    return {
      ok: false,
      kind: params.actionKind,
      diagnostics: [{ code: result.code, message: result.message }],
    };
  }
  return {
    ok: true,
    kind: params.actionKind,
    status: result.status,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  };
}
export async function executePluginDevLoopAction(
  params: ExecutePluginDevLoopActionParams,
  services: PluginDevLoopActionServices = {},
): Promise<unknown> {
  const input = readInput(params.input);

  if ((params.actionId === 'plugins.enable' || params.actionId === 'plugins.disable') && input.scope === 'account') {
    if (!services.account) return { ok: false, errorCode: 'not_supported', error: 'not_supported' };
    const pluginId = readString(input, 'pluginId');
    const enabled = params.actionId === 'plugins.enable';
    const { intent } = await setCurrentAccountPluginEnabled({ ...services.account, pluginId, enabled,
      ...(Array.isArray(input.managedResourceDispositions)
        ? { managedResourceDispositions: input.managedResourceDispositions.map(value => ManagedResourceDispositionV1Schema.parse(value)) } : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
    });
    return { ok: true, kind: params.actionId.replaceAll('.', '_'), pluginId, scope: 'account', enabled: intent.enabled, intent };
  }

  if (params.actionId === 'plugins.enable' || params.actionId === 'plugins.disable'
    || params.actionId === 'plugins.rollback' || params.actionId === 'plugins.trust.forget'
    || params.actionId === 'plugins.update_policy.set'
    || params.actionId === 'plugins.uninstall') {
    const pluginId = readString(input, 'pluginId');
    const dispositions = Array.isArray(input.managedResourceDispositions)
      ? input.managedResourceDispositions.map(value => ManagedResourceDispositionV1Schema.parse(value)) : undefined;
    const request: PluginChangeRequest = params.actionId === 'plugins.update_policy.set'
      ? { kind: 'setUpdatePolicy', pluginId, policy: PluginUpdatePolicyV1Schema.parse(input.policy) }
      : params.actionId === 'plugins.disable' || params.actionId === 'plugins.uninstall'
        ? { kind: params.actionId === 'plugins.disable' ? 'disable' : readBoolean(input, 'deleteData') ? 'uninstallAndDeleteData' : 'uninstall',
          pluginId, ...(dispositions ? { managedResourceDispositions: dispositions } : {}) }
        : { kind: params.actionId === 'plugins.enable' ? 'enable' : params.actionId === 'plugins.rollback' ? 'rollback' : 'forgetTrust', pluginId };
    const change = await (services.requestUserPluginChange ?? requestUserPluginChange)({ request, approval: 'none',
      ...(params.context?.signal ? { signal: params.context.signal } : {}) });
    return { ok: change.kind === 'committed', kind: params.actionId.replaceAll('.', '_'),
      action: request.kind, pluginId, change };
  }

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

  if (params.actionId === 'plugins.dev.submit' || params.actionId === 'plugins.dev.unregister') {
    const projectRoot = readString(input, 'projectRoot');
    const sdkRegistryOrigin = readString(input, 'sdkRegistryOrigin');
    return await runPluginDevelopmentAction({
      actionKind: params.actionId === 'plugins.dev.submit' ? 'plugins_dev_submit' : 'plugins_dev_unregister',
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
      invokerName: resolveInvokerName() ?? 'happier',
      ...(() => {
        // One vocabulary: the scaffold UI mode is resolved through the schema
        // the `plugins.scaffold` action input already validates against.
        const ui = PluginScaffoldUiModeSchema.safeParse(readString(input, 'ui'));
        return ui.success ? { ui: ui.data } : {};
      })(),
      ...(() => {
        const template = PluginScaffoldTemplateSchema.safeParse(readString(input, 'template'));
        return template.success ? { template: template.data } : {};
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
    if (params.context?.presentUserApproval && services.approvedInstallReview) {
      return await settleApprovedInstallReview(services.approvedInstallReview, params, services);
    }
    const source = readInput(input.source);
    if (readString(source, 'kind') === 'installed') {
      const change = await (services.requestUserPluginChange ?? requestUserPluginChange)({
        request: { kind: 'update', pluginId: readString(source, 'pluginId') }, approval: 'none',
        ...(params.context?.signal ? { signal: params.context.signal } : {}),
      });
      if (isPluginPendingReview(change)) return await settleApprovedInstallReview(change, params, services);
      return change.kind === 'committed'
        ? { ok: true, kind: 'plugins_install', outcome: 'applied', change }
        : projectInstallChangeFailure(change, 'The daemon did not apply the plugin update.');
    }
    if (readString(source, 'kind') === 'marketplace') {
      if (!services.marketplaceIndexService) return {
        ok: false, errorCode: 'account_credentials_unavailable', error: 'account_credentials_unavailable',
      };
      const result = await requestExactMarketplaceInstall({
        happyHomeDir: params.happyHomeDir ?? configuration.happyHomeDir,
        sourceId: readString(source, 'sourceId'),
        pluginId: readString(source, 'pluginId'),
        version: readString(source, 'version'),
        ...(readString(source, 'packageName') ? { packageName: readString(source, 'packageName') } : {}),
        // Preparation cannot answer the daemon-issued pending decision. The
        // admitted Action effect applies the user's approval policy below.
        approval: 'none',
      }, { requestChange: services.requestUserPluginChange, marketplaceIndexService: services.marketplaceIndexService });
      if (!result.ok) return {
        ok: false, kind: 'plugins_install', outcome: 'failed',
        diagnostics: [{ code: result.code, message: result.message }],
        change: result.code === 'registry_profile_required'
          ? { kind: 'registryProfileRequired', ...result.requirement }
          : { kind: 'failed', code: result.code, message: result.message },
      };
      if (isPluginPendingReview(result.change)) return await settleApprovedInstallReview(result.change, params, services);
      return result.change.kind === 'committed'
        ? { ok: true, kind: 'plugins_install', outcome: 'applied', change: result.change }
        : projectInstallChangeFailure(result.change, 'The daemon did not apply the plugin install.');
    }
    const locator = readString(input, 'path');
    const sourceKind = readString(input, 'kind');
    if (readString(input, 'selector') && sourceKind !== 'npm'
      || readString(input, 'integrity') && sourceKind !== 'archive') return {
      ok: false, kind: 'plugins_install', outcome: 'failed', diagnostics: [{
        code: 'plugin_source_kind_unsupported', message: 'Selectors require npm installs; integrity requires archive installs.',
      }],
    };
    if (sourceKind === 'archive' || sourceKind === 'npm') {
      if (readBoolean(input, 'dev')) return {
        ok: false, kind: 'plugins_install', outcome: 'failed',
        diagnostics: [{ code: 'plugin_source_kind_unsupported', message: 'Development installs require a local path.' }],
      };
      const request: PluginChangeRequest = sourceKind === 'npm'
        ? { kind: 'installNpm', packageName: locator,
          ...(readString(input, 'selector') ? { selector: readString(input, 'selector') } : {}) }
        : { kind: 'installArchive', locator,
          expectedIntegrity: await resolveArchiveExpectedIntegrity({ locator, explicitIntegrity: readString(input, 'integrity') || null }) };
      if (readBoolean(input, 'dryRun')) return { ok: true, kind: 'plugins_install', dryRun: true, request };
      const change = await (services.requestUserPluginChange ?? requestUserPluginChange)({ request, approval: 'none' });
      if (isPluginPendingReview(change)) return await settleApprovedInstallReview(change, params, services);
      return change.kind === 'committed'
        ? { ok: true, kind: 'plugins_install', outcome: 'applied', change }
        : projectInstallChangeFailure(change, 'The daemon did not apply the plugin install.');
    }
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
    if (readBoolean(input, 'dev') && !readBoolean(input, 'dryRun')) {
      const change = await (services.requestUserPluginChange ?? requestUserPluginChange)({
        request: {
          kind: 'development',
          sourceRootPath: locator,
          ...(readString(input, 'sdkRegistryOrigin')
            ? { sdkRegistryOrigin: readString(input, 'sdkRegistryOrigin') }
            : {}),
        },
        approval: 'none',
      });
      if (isPluginPendingReview(change)) return await settleApprovedInstallReview(change, params, services);
      return change.kind === 'committed'
        ? { ok: true, kind: 'plugins_install', outcome: 'applied', change }
        : projectInstallChangeFailure(change, 'The daemon did not apply the development plugin install.');
    }
    const result = await installPluginFromLocator({
      locator,
      happyHomeDir: params.happyHomeDir,
      skipIfInstalled: !readBoolean(input, 'force'),
      dryRun: readBoolean(input, 'dryRun'),
      workspaceRoot: params.workspaceRoot,
    });
    if (!result.ok) {
      if (
        result.change?.kind === 'reviewRequired'
      ) {
        return await settleApprovedInstallReview(result.change, params, services);
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
    const [catalog, pendingChanges] = await Promise.all([
      runTracedExternalActionStage(params.actionId, params.context?.actionRequestId,
        'plugins.catalog', () => readDaemonPluginCatalog()),
      runTracedExternalActionStage(params.actionId, params.context?.actionRequestId,
        'plugins.pending_changes', () => listDaemonPluginChanges()),
    ]);
    if (catalog.kind !== 'available') {
      return {
        ok: false,
        kind: 'plugins_list',
        diagnostics: [{
          code: catalog.code,
          message: catalog.code === 'plugin_catalog_runtime_unavailable'
            ? 'The daemon plugin runtime is unavailable.'
            : 'The active daemon plugin catalog is unavailable.',
        }],
      };
    }
    if (pendingChanges.kind !== 'available') {
      return {
        ok: false,
        kind: 'plugins_list',
        diagnostics: [{
          code: pendingChanges.code,
          message: 'The daemon pending plugin-change list is unavailable.',
        }],
      };
    }
    const entries = catalog.plugins;
    return {
      ok: true,
      kind: 'plugins_list',
      plugins: entries.map(summarizeCatalogEntry),
      // The daemon is the only pending-decision owner. Project its exact
      // listing beside installed inventory so an Agent can discover the id
      // it must rejoin through plugins.change.status without recreating work.
      pendingChanges: pendingChanges.changes,
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
