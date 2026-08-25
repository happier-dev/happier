import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import {
  createDaemonPluginChangeService,
  type DaemonPluginChangeOwner,
} from '@/plugins/daemon/changeService';
import { createDaemonNpmPluginChangePreparer } from '@/plugins/daemon/npmChangePreparer';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { shouldActivateTargetAtStartup } from '@/plugins/runtime/lifecycle/activation/targets';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import {
  activatePluginRuntimeForReadiness,
  bootstrapPrimaryAgentRuntimesForReadiness,
} from '@/plugins/runtime/reload/readiness';
import {
  resolveBundledImmutableGenerationRetentionIds,
} from '@/plugins/runtime/bundledActivationSource';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
} from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  createPluginRegistryStateStore,
  type PluginRegistryAvailabilityInventory,
} from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { logger } from '@/ui/logger';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { PluginProviderOperationsSource } from '@/plugins/runtime/invocation/services/types';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { cleanupStaleDaemonPluginCandidateRoots } from '@/plugins/daemon/candidateStorage';
import { resolveInstalledPluginUpdate } from '@/plugins/daemon/resolveInstalledUpdate';
import type { StablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
  AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type { ExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import type { PluginDaemonDatabaseLimitsPolicy } from '@/plugins/runtime/context/daemonDatabase';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import type { ResolveSessionResourceAccess } from '@/plugins/runtime/invocation/services/resources';

/** One author-readable reason per cold-start readiness step a plugin can fail. */
const COLD_START_READINESS_STAGE_REASONS = Object.freeze({
  activation: 'cold-start activation failed',
  daemonDatabases: 'cold-start daemon database preparation failed',
  primaryAgentRuntime: 'cold-start primary Agent runtime construction failed',
});

export type DaemonPluginRuntimeOwner = Readonly<{
  changeService: DaemonPluginChangeOwner;
  initialize: () => Promise<void>;
  /** Replays the exact current install-registry snapshot after transport recovery. */
  reportCurrentAvailability: () => void;
  readCatalog: () => ReturnType<typeof readCurrentDaemonPluginCatalog>;
  hardRevokeRunningSessionsForGenerationIntegrityFailure: (
    input: Readonly<{
      pluginId: string;
      immutableGenerationId: string;
    }>,
  ) => Promise<void>;
}>;

/**
 * The daemon edge adds live Machine/server facts and owns authenticated
 * Availability transport. This runtime owner supplies only exact persisted
 * install-registry facts.
 */
export type DaemonPluginAvailabilityReporter = Readonly<{
  report: (inventory: PluginRegistryAvailabilityInventory) => Promise<void>;
}>;

/**
 * The single daemon owner for plugin installation, durable currentness, and the
 * executable registry. Both the full daemon and its restricted packed-author
 * subprocess host this owner; neither caller reimplements G3 decisions.
 */
export function createDaemonPluginRuntimeOwner(params: Readonly<{
  happyHomeDir: string;
  /** Daemon-owned live machine identity for host-stamped nested Action callers. */
  resolveCurrentMachineId?: () => string | null;
  /** Existing daemon-local transfer carrier for host-authored Composer media. */
  resolveComposerMediaStageTransferRpcHandler?: () => RpcHandlerInvoker | null;
  /** Fresh server/machine identity; never the daemon feature cache. */
  resolveCurrentMachineExecutionOriginContext?: (
    signal?: AbortSignal,
  ) => Promise<CurrentMachineExecutionOriginContext | null>;
  /** Canonical Account-change exact Session-access proof for Resource admission. */
  resolveSessionResourceAccess?: ResolveSessionResourceAccess;
  /** Process-owned Account/system boundary dependencies for the canonical host. */
  accountStorageDependencies?: AccountPluginDataStorageHostDependencies;
  /**
   * The daemon's one retained server features snapshot. The resolved runtime fans
   * it out to Collection admission and to plugin-facing feature decisions, so the
   * host never grows a second features cache.
   */
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  staleCandidateCleanup: 'exclusiveHome' | 'disabled';
  reloadController: PluginReloadController;
  connectedAccounts: StablePluginConnectedAccountsOwner;
  actionFormConnectedAccounts?: Pick<
    ConnectedAccountPurposeBindingOwner,
    'resolveBindingIntent'
  > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>>;
  providers?: PluginProviderOperationsSource;
  onInitialRegistryPublished?: () => void;
  awaitInitialRuntimeActivation?: () => Promise<void>;
  /** Notifies the daemon projection after a registry is durably current. */
  onDurableRegistryApplied?: () => void;
  /** Publishes daemon-state currentness after a live runtime projection changes in place. */
  onRuntimeProjectionInvalidated?: () => void;
  managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
  qualifiedConnectedAccountEstablishedRuntimeOwner?:
    Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
  reconcileConnectedAccountPurposePublication?: (input: Readonly<{
    previous: ResolvedContributionRegistry | null;
    candidate: ResolvedContributionRegistry;
    candidateActivePluginIds?: ReadonlySet<string>;
    resolveOptionalAccess(pluginId: string): readonly PluginAccessSelection[];
    publish(): void;
  }>) => Promise<void>;
  runtimeActionExecute?: RuntimeActionExecute;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  resolveExternalSessionCurrentMachineId?: () => string | null;
  externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
  externalSessionsActiveServerDir?: string;
  externalSessionsActiveServerId?: string;
  /** Daemon startup injects the measured trusted-plugin policy. */
  daemonDatabaseLimits?: PluginDaemonDatabaseLimitsPolicy;
  availabilityReporter?: DaemonPluginAvailabilityReporter;
  /** Explicit operator recovery: external installed plugin code is not executed. */
  startupMode?: 'normal' | 'pluginRecovery';
}>): DaemonPluginRuntimeOwner {
  // The controller owns this stable target-local observer across cold startup
  // and prepared registry replacement. Runtime construction only consumes it.
  const targetedContributions =
    params.reloadController.getTargetedContributionsOwner?.();
  const onTerminalActivationFailure = (): void => {
    params.reloadController.invalidateRuntimeProjection?.();
    params.onRuntimeProjectionInvalidated?.();
  };
  const beforePublish = params.reconcileConnectedAccountPurposePublication
    ? async (
        registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
        publish: () => void,
      ) => {
        const candidateActivePluginIds = new Set(registry.activatedPluginIds);
        await params.reconcileConnectedAccountPurposePublication?.({
          previous: params.reloadController.getState().activeRegistry?.contributes ?? null,
          candidate: registry.contributes,
          candidateActivePluginIds,
          resolveOptionalAccess: (pluginId) => (
            registry.resolveOptionalAccess?.(pluginId) ?? Object.freeze([])
          ),
          publish,
        });
      }
    : undefined;
  const initialBeforePublish = (
    params.onInitialRegistryPublished
    || params.awaitInitialRuntimeActivation
    || params.onDurableRegistryApplied
  )
    ? async (
        registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
        publish: () => void,
      ) => {
        if (beforePublish) await beforePublish(registry, publish);
        else publish();
        params.onInitialRegistryPublished?.();
        await params.awaitInitialRuntimeActivation?.();
      }
    : beforePublish;
  let stableEventsBroker: StablePluginEventsBroker | null = null;
  const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
    happyHomeDir: params.happyHomeDir,
    ...(params.resolveCurrentMachineId
      ? { resolveCurrentMachineId: params.resolveCurrentMachineId }
      : {}),
    ...(params.resolveComposerMediaStageTransferRpcHandler
      ? { resolveComposerMediaStageTransferRpcHandler: params.resolveComposerMediaStageTransferRpcHandler }
      : {}),
    ...(params.resolveCurrentMachineExecutionOriginContext
      ? {
          resolveCurrentMachineExecutionOriginContext:
            params.resolveCurrentMachineExecutionOriginContext,
        }
      : {}),
    ...(params.resolveSessionResourceAccess
      ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
      : {}),
    ...(params.accountStorageDependencies
      ? { accountStorageDependencies: params.accountStorageDependencies }
      : {}),
    ...(params.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
      : {}),
    reloadController: params.reloadController,
    onTerminalActivationFailure,
    connectedAccounts: params.connectedAccounts,
    ...(params.actionFormConnectedAccounts
      ? { actionFormConnectedAccounts: params.actionFormConnectedAccounts }
      : {}),
    ...(params.providers ? { providers: params.providers } : {}),
    ...(params.managedProviderOperationAuthority
      ? {
          managedProviderOperationAuthority:
            params.managedProviderOperationAuthority,
        }
      : {}),
    ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
      ? {
          qualifiedConnectedAccountEstablishedRuntimeOwner:
            params.qualifiedConnectedAccountEstablishedRuntimeOwner,
        }
      : {}),
    ...(beforePublish ? { beforePublish } : {}),
    readStableEventsBroker: () => stableEventsBroker,
    ...(params.runtimeActionExecute
      ? { runtimeActionExecute: params.runtimeActionExecute }
      : {}),
    ...(params.managedEndpointRead
      ? { managedEndpointRead: params.managedEndpointRead }
      : {}),
    ...(params.externalSessionPluginAdmissionOwner
      ? {
          externalSessionPluginAdmissionOwner:
            params.externalSessionPluginAdmissionOwner,
        }
      : {}),
    ...(params.resolveExternalSessionCurrentMachineId
      ? {
          resolveExternalSessionCurrentMachineId:
            params.resolveExternalSessionCurrentMachineId,
        }
      : {}),
    ...(params.externalSessionHostOperationOwner
      ? {
          externalSessionHostOperationOwner:
            params.externalSessionHostOperationOwner,
        }
      : {}),
    ...(params.externalSessionsActiveServerDir
      ? { externalSessionsActiveServerDir: params.externalSessionsActiveServerDir }
      : {}),
    ...(params.externalSessionsActiveServerId
      ? { externalSessionsActiveServerId: params.externalSessionsActiveServerId }
      : {}),
    ...(params.daemonDatabaseLimits
      ? { daemonDatabaseLimits: params.daemonDatabaseLimits }
      : {}),
    ...(params.startupMode ? { startupMode: params.startupMode } : {}),
  });
  let reportAvailabilityAfterApplied = (_record: PluginRegistryCommitRecord): void => undefined;
  const onRegistryApplied = (record: PluginRegistryCommitRecord): void => {
    reportAvailabilityAfterApplied(record);
    params.onDurableRegistryApplied?.();
  };
  const preparePath = createDaemonPathPluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    onRegistryApplied,
  });
  const prepareNpm = createDaemonNpmPluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    onRegistryApplied,
  });
  const prepareArchive = createDaemonArchivePluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    onRegistryApplied,
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
        error: projectPluginFailureText(error),
      });
    },
  });
  const retainedCurrentHostGenerationIds =
    resolveBundledImmutableGenerationRetentionIds({
      artifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
    });
  const stateStore = createPluginRegistryStateStore({
    happyHomeDir: params.happyHomeDir,
    retainedCurrentHostGenerationIds,
    runtimeLifecycle,
    runHardRevocationCurrentnessChange: changeService.runHardRevocationCurrentnessChange,
    ...(params.startupMode === 'pluginRecovery' ? { pluginRecovery: true } : {}),
    onCommitRecordQuarantined: (info) => {
      logger.warn(
        '[PLUGIN RUNTIME] Recovery startup quarantined an unreadable plugin registry commit record; '
        + 'installed plugins must be reinstalled or the record restored after repair.',
        info,
      );
    },
    onApplied: onRegistryApplied,
    onReconciliationPending: (diagnostic) => {
      logger.warn('[PLUGIN RUNTIME] Plugin registry reconciliation remains pending', diagnostic);
    },
  });
  const reportAvailabilityFailure = (error: unknown, revision: number): void => {
    logger.debug('[PLUGIN RUNTIME] Plugin availability report failed (non-fatal)', {
      revision,
      error: projectPluginFailureText(error),
    });
  };
  reportAvailabilityAfterApplied = (record) => {
    const reporter = params.availabilityReporter;
    if (!reporter) return;
    // Runtime application is already durable. Availability is a best-effort
    // consumer: transport failure never changes the local transaction.
    void stateStore.readAvailabilityInventoryForCommit(record)
      .then(async (inventory) => await reporter.report(inventory))
      .catch((error: unknown) => reportAvailabilityFailure(error, record.revision));
  };
  const reportCurrentAvailability = (): void => {
    const reporter = params.availabilityReporter;
    if (!reporter) return;
    void stateStore.readAvailabilityInventory()
      .then(async (inventory) => await reporter.report(inventory))
      .catch((error: unknown) => reportAvailabilityFailure(error, -1));
  };

  return Object.freeze({
    changeService,
    async initialize() {
      if (params.staleCandidateCleanup === 'exclusiveHome') {
        await cleanupStaleDaemonPluginCandidateRoots(params.happyHomeDir);
      }
      await stateStore.initialize();
      const initialLease = await params.reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => {
          const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: params.happyHomeDir,
            generation: params.reloadController.getState().generation + 1,
            ...(params.resolveCurrentMachineId
              ? { resolveCurrentMachineId: params.resolveCurrentMachineId }
              : {}),
            ...(params.resolveComposerMediaStageTransferRpcHandler
              ? {
                  resolveComposerMediaStageTransferRpcHandler:
                    params.resolveComposerMediaStageTransferRpcHandler,
                }
              : {}),
            ...(params.resolveCurrentMachineExecutionOriginContext
              ? {
                  resolveCurrentMachineExecutionOriginContext:
                    params.resolveCurrentMachineExecutionOriginContext,
                }
              : {}),
            ...(params.resolveSessionResourceAccess
              ? { resolveSessionResourceAccess: params.resolveSessionResourceAccess }
              : {}),
            ...(params.accountStorageDependencies
              ? { accountStorageDependencies: params.accountStorageDependencies }
              : {}),
            ...(params.resolveServerFeaturesSnapshot
              ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
              : {}),
            connectedAccounts: params.connectedAccounts,
            ...(params.providers ? { providers: params.providers } : {}),
            ...(params.managedProviderOperationAuthority
              ? {
                  managedProviderOperationAuthority:
                    params.managedProviderOperationAuthority,
                }
              : {}),
            ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
              ? {
                  qualifiedConnectedAccountEstablishedRuntimeOwner:
                    params.qualifiedConnectedAccountEstablishedRuntimeOwner,
                }
              : {}),
            ...(params.runtimeActionExecute
              ? { runtimeActionExecute: params.runtimeActionExecute }
              : {}),
            ...(params.managedEndpointRead
              ? { managedEndpointRead: params.managedEndpointRead }
              : {}),
            ...(params.externalSessionPluginAdmissionOwner
              ? {
                  externalSessionPluginAdmissionOwner:
                    params.externalSessionPluginAdmissionOwner,
                }
              : {}),
            ...(params.resolveExternalSessionCurrentMachineId
              ? {
                  resolveExternalSessionCurrentMachineId:
                    params.resolveExternalSessionCurrentMachineId,
                }
              : {}),
            ...(params.externalSessionHostOperationOwner
              ? {
                  externalSessionHostOperationOwner:
                    params.externalSessionHostOperationOwner,
                }
              : {}),
            ...(params.externalSessionsActiveServerDir
              ? {
                  externalSessionsActiveServerDir:
                    params.externalSessionsActiveServerDir,
                }
              : {}),
            ...(params.externalSessionsActiveServerId
              ? {
                  externalSessionsActiveServerId:
                    params.externalSessionsActiveServerId,
                }
              : {}),
            ...(params.daemonDatabaseLimits
              ? { daemonDatabaseLimits: params.daemonDatabaseLimits }
              : {}),
            // Required on the controller contract, so this is unconditional.
            // The cold registry is exactly the generation whose long-lived
            // plugin contexts survive the first peer replacement; letting it
            // self-target would pin them to a retired predecessor.
            currentGlobalExternalSessionsRouter:
              params.reloadController.currentGlobalExternalSessions,
            onTerminalActivationFailure,
            ...(targetedContributions
              ? { targetedContributions }
              : {}),
            ...(params.startupMode === 'pluginRecovery'
              ? { contributes: getResolvedContributionRegistry() }
              : {}),
          });
          // Cold start has no serving incumbent to fall back to, so a rejected
          // projection exits the daemon instead of serving its healthy plugins.
          // A rejected participant is fenced at the canonical activation owner so
          // the published registry stops advertising it, keyed on the structural
          // fact that it failed and never on where it came from: a bundled
          // participant is fenced exactly like an external one. The reload path
          // deliberately keeps the opposite contract — there a rejected candidate
          // must be discarded whole because the incumbent is still serving.
          const isolateReadinessParticipant = async (
            pluginId: string,
            stage: keyof typeof COLD_START_READINESS_STAGE_REASONS,
            run: () => Promise<void>,
          ): Promise<void> => {
            try {
              await run();
            } catch (error) {
              const reason = `${COLD_START_READINESS_STAGE_REASONS[stage]}: ${
                projectPluginFailureText(error)
              }`;
              // Isolation alone would keep advertising the rejected plugin as
              // ready. A registry that cannot fence it has no way to publish a
              // truthful cold projection, so the whole startup fails closed.
              if (!registry.recordPluginActivationFailure) {
                throw new AggregateError(
                  [error],
                  'Prepared plugin runtime registry cannot fence a rejected cold-start readiness participant',
                );
              }
              await registry.recordPluginActivationFailure(pluginId, reason);
              logger.warn(
                '[PLUGIN RUNTIME] Cold startup fenced a failed plugin readiness participant',
                { pluginId, stage, error: projectPluginFailureText(error) },
              );
            }
          };
          try {
            const activationTargets = registry.contributes.activationTargets ?? [];
            // The lifecycle manager owns which targets must be live before the
            // daemon can serve. Its demand-ready targets remain dormant until
            // their consumer admits the exact demand; cold-start readiness must
            // not become a second activation policy that eagerly loads them.
            const coldStartActivationTargets = activationTargets.filter(
              shouldActivateTargetAtStartup,
            );
            const readinessPluginIds = [...new Set(
              coldStartActivationTargets.map((target) => target.pluginId),
            )].sort();
            // The lifecycle manager already records ordinary activation and trust
            // failures against the affected plugin; this isolates the exceptional
            // rejections it cannot absorb.
            await Promise.all(readinessPluginIds.map(async (pluginId) => {
              await isolateReadinessParticipant(pluginId, 'activation', async () => {
                await activatePluginRuntimeForReadiness({
                  registry,
                  pluginIds: [pluginId],
                });
              });
            }));
            if (registry.prepareDaemonDatabases) {
              const daemonDatabasePluginIds = [...new Set(
                coldStartActivationTargets
                  .filter((target) => (
                    registry.activatedPluginIds.has(target.pluginId)
                    && target.manifest.contributes.daemonDatabases.length > 0
                  ))
                  .map((target) => target.pluginId),
              )].sort();
              for (const pluginId of daemonDatabasePluginIds) {
                await isolateReadinessParticipant(pluginId, 'daemonDatabases', async () => {
                  await registry.prepareDaemonDatabases!({ pluginIds: [pluginId] });
                });
              }
            }
            for (const pluginId of readinessPluginIds) {
              // A plugin an earlier readiness step already fenced is retired.
              // Constructing its runtime against that retired generation would
              // only fail again and record a second reason for one rejection.
              if (!registry.activatedPluginIds.has(pluginId)) continue;
              await isolateReadinessParticipant(pluginId, 'primaryAgentRuntime', async () => {
                await bootstrapPrimaryAgentRuntimesForReadiness({
                  registry,
                  pluginIds: [pluginId],
                });
              });
            }
            return registry;
          } catch (error) {
            try {
              await registry.dispose();
            } catch (disposeError) {
              throw new AggregateError(
                [error, disposeError],
                'Initial plugin runtime readiness and registry cleanup failed',
              );
            }
            throw error;
          }
        },
        ...(initialBeforePublish ? { beforePublish: initialBeforePublish } : {}),
      });
      try {
        stableEventsBroker = initialLease.registry
          .stableEventsBroker ?? null;
      } finally {
        await initialLease.release();
      }
      params.onDurableRegistryApplied?.();
      reportCurrentAvailability();
    },
    reportCurrentAvailability,
    readCatalog: async () => await readCurrentDaemonPluginCatalog({
      happyHomeDir: params.happyHomeDir,
      reloadController: params.reloadController,
    }),
    hardRevokeRunningSessionsForGenerationIntegrityFailure:
      stateStore.hardRevokeRunningSessionsForGenerationIntegrityFailure,
  });
}
