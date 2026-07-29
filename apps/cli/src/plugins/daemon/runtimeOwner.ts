import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import {
  createDaemonPluginChangeService,
  type DaemonPluginChangeOwner,
} from '@/plugins/daemon/changeService';
import { createDaemonNpmPluginChangePreparer } from '@/plugins/daemon/npmChangePreparer';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import type { SupervisedPluginActivationAttempt } from '@/plugins/runtime/lifecycle/manager';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { logger } from '@/ui/logger';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { cleanupStaleDaemonPluginCandidateRoots } from '@/plugins/daemon/candidateStorage';
import { resolveInstalledPluginUpdate } from '@/plugins/daemon/resolveInstalledUpdate';

export type DaemonPluginRuntimeOwner = Readonly<{
  changeService: DaemonPluginChangeOwner;
  initialize: () => Promise<void>;
  readCatalog: () => ReturnType<typeof readCurrentDaemonPluginCatalog>;
}>;

/**
 * The single daemon owner for plugin installation, durable currentness, and the
 * executable registry. Both the full daemon and its restricted packed-author
 * subprocess host this owner; neither caller reimplements G3 decisions.
 */
export function createDaemonPluginRuntimeOwner(params: Readonly<{
  happyHomeDir: string;
  staleCandidateCleanup: 'exclusiveHome' | 'disabled';
  daemonInstanceId: string;
  daemonUptimeMs: () => number;
  reloadController: PluginReloadController;
  connectedAccounts: StablePluginConnectedAccountsOwner;
  qualifiedConnectedAccountEstablishedRuntimeOwner?:
    Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
  reconcileConnectedAccountPurposePublication?: (input: Readonly<{
    previous: ResolvedContributionRegistry | null;
    candidate: ResolvedContributionRegistry;
    resolveOptionalAccess(pluginId: string): readonly PluginAccessSelection[];
    publish(): void;
  }>) => Promise<void>;
}>): DaemonPluginRuntimeOwner {
  const beforePublish = params.reconcileConnectedAccountPurposePublication
    ? async (
        registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
        publish: () => void,
      ) => {
        await params.reconcileConnectedAccountPurposePublication?.({
          previous: params.reloadController.getState().activeRegistry?.contributes ?? null,
          candidate: registry.contributes,
          resolveOptionalAccess: (pluginId) => (
            registry.resolveOptionalAccess?.(pluginId) ?? Object.freeze([])
          ),
          publish,
        });
      }
    : undefined;
  let observePluginActivationAttempt = (_attempt: SupervisedPluginActivationAttempt): void => undefined;
  const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
    happyHomeDir: params.happyHomeDir,
    reloadController: params.reloadController,
    connectedAccounts: params.connectedAccounts,
    ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
      ? {
          qualifiedConnectedAccountEstablishedRuntimeOwner:
            params.qualifiedConnectedAccountEstablishedRuntimeOwner,
        }
      : {}),
    ...(beforePublish ? { beforePublish } : {}),
    onActivationAttempt: (attempt) => observePluginActivationAttempt(attempt),
  });
  const preparePath = createDaemonPathPluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
  });
  const prepareNpm = createDaemonNpmPluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
  });
  const prepareArchive = createDaemonArchivePluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
  });
  const changeService = createDaemonPluginChangeService({
    prepare: async (request) => {
      if (request.kind === 'update') {
        const installed = (
          await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
        ).plugins[request.pluginId];
        const update = resolveInstalledPluginUpdate(request.pluginId, installed);
        if (update.kind === 'npm') {
          return await prepareNpm(update.request, {
            installedUpdate: {
              pluginId: request.pluginId,
              updatePolicy: update.updatePolicy,
            },
          });
        }
        if (update.kind === 'archive') return await prepareArchive(update.request);
        return await preparePath(update.request);
      }
      if (request.kind === 'installNpm') return await prepareNpm(request);
      if (request.kind === 'installArchive') return await prepareArchive(request);
      return await preparePath(request);
    },
    onCleanupFailure: (pluginId, error) => {
      logger.warn('[PLUGIN RUNTIME] Temporary plugin candidate cleanup failed', {
        pluginId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const stateStore = createPluginRegistryStateStore({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    runAutomaticCurrentnessChange: changeService.runAutomaticCurrentnessChange,
    onReconciliationPending: (diagnostic) => {
      logger.warn('[PLUGIN RUNTIME] Plugin registry reconciliation remains pending', diagnostic);
    },
    healthSupervisor: {
      daemonInstanceId: params.daemonInstanceId,
      daemonUptimeMs: params.daemonUptimeMs,
      schedule: (delayMs, task) => {
        const timer = setTimeout(() => {
          void task().catch((error) => {
            logger.warn('[PLUGIN RUNTIME] Plugin generation health observation failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, delayMs);
        timer.unref?.();
      },
    },
  });
  observePluginActivationAttempt = stateStore.observeActivationAttempt;

  return Object.freeze({
    changeService,
    async initialize() {
      if (params.staleCandidateCleanup === 'exclusiveHome') {
        await cleanupStaleDaemonPluginCandidateRoots(params.happyHomeDir);
      }
      await stateStore.initialize();
      const initialLease = await params.reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: params.happyHomeDir,
          generation: params.reloadController.getState().generation + 1,
          connectedAccounts: params.connectedAccounts,
          ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
            ? {
                qualifiedConnectedAccountEstablishedRuntimeOwner:
                  params.qualifiedConnectedAccountEstablishedRuntimeOwner,
              }
            : {}),
          onActivationAttempt: stateStore.observeActivationAttempt,
        }),
        ...(beforePublish ? { beforePublish } : {}),
      });
      try {
        await stateStore.settleCurrentNonExecutableHealthAfterRuntimePublication();
      } finally {
        await initialLease.release();
      }
    },
    readCatalog: async () => await readCurrentDaemonPluginCatalog({
      happyHomeDir: params.happyHomeDir,
      reloadController: params.reloadController,
    }),
  });
}
