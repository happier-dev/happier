import {
  createMergedContributionRegistry,
  getResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  projectLoadedPluginContributes,
} from '@/plugins/projection/registry/resolvePluginContributions';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import {
  readCurrentCommittedPluginGenerations,
  readPreparedImmutablePluginGeneration,
  type CurrentCommittedPluginGeneration,
} from '@/plugins/store/registry/generationStore';
import type {
  PluginRegistryRuntimeCandidate,
  PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  resolveExecutablePluginRuntimeRegistry,
  type PluginRuntimeActivationRegistryLease,
  type PluginRuntimeGenerationAuthority,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  prepareBundledExecutableGenerationAdmission,
  selectBundledExecutableImmutableArtifacts,
} from '@/plugins/runtime/bundledActivationSource';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { PluginProviderOperationsSource } from '@/plugins/runtime/invocation/services/types';
import type { ManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { logger } from '@/ui/logger';
import { projectPluginFailureText } from '../lifecycle/utils';
import type { StablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type {
  AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type { ExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import type {
  PluginDaemonDatabaseLimitsPolicy,
  PluginDaemonDatabaseQuiescence,
} from '@/plugins/runtime/context/daemonDatabase';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import type { ResolveSessionResourceAccess } from '@/plugins/runtime/invocation/services/resources';

import {
  type PluginRuntimeRegistryBeforePublish,
  type PluginReloadController,
} from './controller';
import {
  activatePluginRuntimeForReadiness,
  assertPluginRuntimeReadiness,
  bootstrapPrimaryAgentRuntimesForReadiness,
} from './readiness';

async function createCandidateGenerationAuthority(params: Readonly<{
  happyHomeDir: string;
  candidate: PluginRegistryRuntimeCandidate;
  activationTargets: readonly Readonly<{
    pluginId: string;
    daemonEntryPath: string | null;
    sourceSpec: Readonly<{ kind: string }>;
  }>[];
  isValid: () => boolean;
}>): Promise<PluginRuntimeGenerationAuthority> {
  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  const bundledExecutableImmutableArtifacts = selectBundledExecutableImmutableArtifacts({
    artifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
    activationTargets: params.activationTargets,
  });
  await prepareBundledExecutableGenerationAdmission({
    artifacts: bundledExecutableImmutableArtifacts,
  });
  const bundled = await readCurrentCommittedPluginGenerations(paths, {
    bundledArtifacts: bundledExecutableImmutableArtifacts,
    isolateInvalidInstalledGenerations: true,
  });
  const generations = new Map<string, CurrentCommittedPluginGeneration>();
  const unavailableBundledPackageNames = new Set(bundled?.unavailableBundledPackageNames ?? []);
  for (const [pluginId, generation] of bundled?.generations ?? []) {
    if (!generation.installation) generations.set(pluginId, generation);
  }
  for (const [pluginId, reference] of Object.entries(params.candidate.pluginGenerations)) {
    const installation = params.candidate.installationState.plugins[pluginId];
    if (!installation) {
      throw new Error(`Prepared plugin generation is missing installation authority for '${pluginId}'`);
    }
    if (
      !installation.enabled
      || params.candidate.runtimeCatalog.plugins[pluginId]?.state.enabled === false
    ) continue;
    const prepared = await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: reference.immutableGenerationId,
    });
    if (JSON.stringify(prepared.reference) !== JSON.stringify(reference)) {
      throw new Error(`Prepared plugin generation reference changed for '${pluginId}'`);
    }
    const catalogTrust = params.candidate.runtimeCatalog.plugins[pluginId]?.install.trust;
    if (!installation.trust || !catalogTrust) continue;
    if (JSON.stringify(installation.trust) !== JSON.stringify(catalogTrust)) {
      throw new Error(`Prepared plugin generation catalog trust identity mismatch for '${pluginId}'`);
    }
    generations.set(pluginId, Object.freeze({
      pluginId,
      immutableGenerationId: prepared.record.immutableGenerationId,
      rootPath: prepared.rootPath,
      record: prepared.record,
      installation,
    }));
  }
  return Object.freeze({
    commit: null,
    generations,
    rejectedGenerations: new Map(),
    unavailableBundledPackageNames,
    isCurrent: async () => params.isValid(),
  });
}

async function resolveCandidateContributes(
  candidate: PluginRegistryRuntimeCandidate,
  startupMode: 'normal' | 'pluginRecovery',
) {
  const builtIn = getResolvedContributionRegistry();
  if (startupMode === 'pluginRecovery') return builtIn;
  const loadResult = await loadPluginsFromState(candidate.runtimeCatalog);
  const plugin = projectLoadedPluginContributes({
    loadResult,
    provenance: 'external',
    existingAgentIds: new Set(builtIn.agents.map((agent) => agent.id)),
  });
  return createMergedContributionRegistry(plugin);
}

export function createDaemonPluginRegistryRuntimeLifecycle(params: Readonly<{
  happyHomeDir: string;
  /** Daemon-owned live machine identity for host-stamped nested Action callers. */
  resolveCurrentMachineId?: () => string | null;
  /** Existing daemon-local transfer carrier for host-authored Composer media. */
  resolveComposerMediaStageTransferRpcHandler?: () => RpcHandlerInvoker | null;
  /** Fresh server/machine identity; never a retained feature snapshot. */
  resolveCurrentMachineExecutionOriginContext?: (
    signal?: AbortSignal,
  ) => Promise<CurrentMachineExecutionOriginContext | null>;
  resolveSessionResourceAccess?: ResolveSessionResourceAccess;
  /** Process-owned Account/system boundary dependencies for the canonical host. */
  accountStorageDependencies?: AccountPluginDataStorageHostDependencies;
  /** The daemon's one retained server features snapshot, forwarded unchanged. */
  resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  reloadController: PluginReloadController;
  connectedAccounts?: StablePluginConnectedAccountsOwner;
  actionFormConnectedAccounts?: Pick<
    ConnectedAccountPurposeBindingOwner,
    'resolveBindingIntent'
  > & Partial<Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>>;
  providers?: PluginProviderOperationsSource;
  managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
  qualifiedConnectedAccountEstablishedRuntimeOwner?:
    Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
  readStableEventsBroker?: () => StablePluginEventsBroker | null;
  runtimeActionExecute?: RuntimeActionExecute;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  resolveExternalSessionCurrentMachineId?: () => string | null;
  externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
  externalSessionsActiveServerDir?: string;
  externalSessionsActiveServerId?: string;
  /** Injected only after Data's measured per-plugin and protocol limits exist. */
  daemonDatabaseLimits?: PluginDaemonDatabaseLimitsPolicy;
  /** Explicit operator mode: retain daemon administration while external plugin code is skipped. */
  startupMode?: 'normal' | 'pluginRecovery';
  beforePublish?: PluginRuntimeRegistryBeforePublish;
}>): PluginRegistryRuntimeLifecycle {
  type PreparedActivationCustody = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    lease: PluginRuntimeActivationRegistryLease;
  }>;
  // A committed candidate remains desired while its short publication is in
  // flight. Keep only its already-prepared per-plugin component so a newer
  // desired graph can retain that exact activation instead of executing it
  // again; durable currentness remains owned by the registry commit.
  const committedPreparedActivationCustodyByPluginId =
    new Map<string, PreparedActivationCustody>();

  async function prepareCandidate(
    candidate: PluginRegistryRuntimeCandidate,
    preparedActivationRegistryLeases: readonly PluginRuntimeActivationRegistryLease[] = Object.freeze([]),
  ): Promise<Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>>> {
      let valid = true;
      let disposed = false;
      let adopted = false;
      let appliedGenerationsByPluginId:
        Readonly<Record<string, string | null>> | undefined;
      const contributes = await resolveCandidateContributes(
        candidate,
        params.startupMode ?? 'normal',
      );
      const generationAuthority = await createCandidateGenerationAuthority({
        happyHomeDir: params.happyHomeDir,
        candidate,
        activationTargets: contributes.activationTargets,
        isValid: () => valid,
      });
      const activeRegistry = params.reloadController.getState().activeRegistry;
      const activePluginIds = activeRegistry?.activatedPluginIds ?? new Set<string>();
      const changedPluginIds = new Set(candidate.changedPluginIds);
      const retainedPreparedPeerActivationLeases: PluginRuntimeActivationRegistryLease[] = [];
      const retainedPreparedPeerPluginIds = new Set<string>();
      for (const [pluginId, reference] of Object.entries(candidate.pluginGenerations)) {
        if (changedPluginIds.has(pluginId)) continue;
        const custody = committedPreparedActivationCustodyByPluginId.get(pluginId);
        if (
          !custody
          || custody.immutableGenerationId !== reference.immutableGenerationId
          || candidate.installationState.plugins[pluginId]?.enabled !== true
          || candidate.runtimeCatalog.plugins[pluginId]?.state.enabled !== true
        ) {
          continue;
        }
        retainedPreparedPeerActivationLeases.push(custody.lease.retain());
        retainedPreparedPeerPluginIds.add(pluginId);
      }
      const replacedPluginIds = new Set([
        ...changedPluginIds,
        ...retainedPreparedPeerPluginIds,
      ]);
      const unchangedActivePluginIds = new Set(
        [...activePluginIds].filter((pluginId) => !replacedPluginIds.has(pluginId)),
      );
      const activeActivationRegistryLeases = [
        ...(activeRegistry?.retainActivationRegistryComponentsExcluding?.(replacedPluginIds) ?? []),
      ];
      const retainedActivePluginIds = new Set(
        activeActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds]),
      );
      const canReuseActiveRegistry = Boolean(
        activeRegistry
        && [...unchangedActivePluginIds].every((pluginId) => retainedActivePluginIds.has(pluginId)),
      );
      if (!canReuseActiveRegistry) {
        await Promise.all(
          activeActivationRegistryLeases.map((lease) => lease.release()),
        );
        activeActivationRegistryLeases.length = 0;
      }
      const canPrepareOnlyChangedPlugins = Boolean(
        preparedActivationRegistryLeases.length > 0
        || retainedPreparedPeerActivationLeases.length > 0
        || canReuseActiveRegistry
        || (
          !activeRegistry
          && Object.keys(candidate.pluginGenerations).every((pluginId) => candidate.changedPluginIds.includes(pluginId))
        )
      );
      const activationGeneration = canReuseActiveRegistry && typeof activeRegistry?.generation === 'number'
        ? activeRegistry.generation
        : params.reloadController.getState().generation + 1;
      const retainedActivationRegistryLeases = [
        ...activeActivationRegistryLeases,
        ...retainedPreparedPeerActivationLeases,
        ...preparedActivationRegistryLeases,
      ];
      let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
      try {
        const stableEventsBroker =
          params.readStableEventsBroker?.() ?? null;
        const targetedContributions =
          params.reloadController.getTargetedContributionsOwner?.();
        registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: params.happyHomeDir,
            contributes,
            generation: activationGeneration,
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
          generationAuthority,
          ...(stableEventsBroker
            ? { stableEventsBroker }
            : {}),
          ...(targetedContributions
            ? { targetedContributions }
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
          ...(candidate.preparedActivationGraphsByPluginId
            ? {
                preparedActivationGraphsByPluginId:
                  candidate.preparedActivationGraphsByPluginId,
              }
            : {}),
          ...(params.daemonDatabaseLimits
            ? { daemonDatabaseLimits: params.daemonDatabaseLimits }
            : {}),
          ...(canPrepareOnlyChangedPlugins ? {
            pluginIds: preparedActivationRegistryLeases.length > 0
              ? Object.freeze([])
              : candidate.changedPluginIds,
          } : {}),
          ...(retainedActivationRegistryLeases.length > 0
            ? {
                retainedActivationRegistryLeases:
                  Object.freeze(retainedActivationRegistryLeases),
              }
            : {}),
          ...(preparedActivationRegistryLeases.length > 0
            ? { preparedActivationRegistryLeases }
            : {}),
          ...(params.connectedAccounts ? { connectedAccounts: params.connectedAccounts } : {}),
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
        });
      } catch (error) {
        const cleanup = await Promise.allSettled(
          retainedActivationRegistryLeases.map(async (lease) => await lease.release()),
        );
        const cleanupFailures = cleanup.flatMap((result) => (
          result.status === 'rejected' ? [result.reason] : []
        ));
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [error, ...cleanupFailures],
            'Plugin runtime candidate construction and retained component cleanup failed',
          );
        }
        throw error;
      }
      let incumbentDatabaseQuiescence: PluginDaemonDatabaseQuiescence | null = null;
      const resumeIncumbentDatabases = async (): Promise<void> => {
        const quiescence = incumbentDatabaseQuiescence;
        incumbentDatabaseQuiescence = null;
        await quiescence?.resume();
      };
      const disposeOnce = async () => {
        if (disposed) return;
        disposed = true;
        valid = false;
        try {
          await registry.dispose();
        } finally {
          if (!adopted) await resumeIncumbentDatabases();
        }
      };
      try {
        await activatePluginRuntimeForReadiness({
          registry,
          pluginIds: candidate.changedPluginIds,
        });
        const candidateDaemonDatabasePluginIds = candidate.changedPluginIds.filter((pluginId) => (
          registry.contributes.activationTargets.some((target) => (
            target.pluginId === pluginId
            && target.manifest.contributes.daemonDatabases.length > 0
          ))
        ));
        // A disable, uninstall, or declaration removal has no candidate
        // declaration to select, but its incumbent can still own native SQLite
        // handles. Read the active host's prepared contracts as the one
        // authoritative proof that it must be quiesced before adoption.
        const incumbentDaemonDatabasePluginIds = candidate.changedPluginIds.filter((pluginId) => (
          (activeRegistry?.readPreparedDaemonDatabaseContracts?.(pluginId)?.length ?? 0) > 0
        ));
        const daemonDatabasePluginIds = [...new Set([
          ...candidateDaemonDatabasePluginIds,
          ...incumbentDaemonDatabasePluginIds,
        ])].sort();
        if (daemonDatabasePluginIds.length > 0) {
          if (candidateDaemonDatabasePluginIds.length > 0 && !registry.prepareDaemonDatabases) {
            throw new Error('Prepared plugin runtime registry cannot prepare daemon databases');
          }
          if (incumbentDaemonDatabasePluginIds.length > 0 && !activeRegistry?.quiesceDaemonDatabases) {
            throw new Error('Active plugin runtime registry cannot quiesce daemon databases');
          }
          const incumbentContractsByPluginId = new Map(
            candidateDaemonDatabasePluginIds.map((pluginId) => [
              pluginId,
              activeRegistry?.readPreparedDaemonDatabaseContracts?.(pluginId) ?? Object.freeze([]),
            ]),
          );
          if (incumbentDaemonDatabasePluginIds.length > 0) {
            incumbentDatabaseQuiescence = await activeRegistry?.quiesceDaemonDatabases?.(
              incumbentDaemonDatabasePluginIds,
            ) ?? null;
          }
          if (candidateDaemonDatabasePluginIds.length > 0) {
            await registry.prepareDaemonDatabases!({
              pluginIds: candidateDaemonDatabasePluginIds,
              incumbentContractsByPluginId,
            });
          }
        }
        const executableChangedPluginIds = candidate.changedPluginIds.filter((pluginId) => (
          candidate.runtimeCatalog.plugins[pluginId]?.state.enabled === true
        ));
        assertPluginRuntimeReadiness({
          registry,
          executablePluginIds: executableChangedPluginIds,
        });
        await bootstrapPrimaryAgentRuntimesForReadiness({
          registry,
          pluginIds: candidate.changedPluginIds,
        });
      } catch (error) {
        await disposeOnce();
        throw error;
      }

      return Object.freeze({
        abort: disposeOnce,
        notifyDurableRunningSessionDisposition(record) {
          params.reloadController.publishDurableRunningSessionDisposition({
            durableRevision: record.revision,
            changedPluginIds: candidate.changedPluginIds,
            runningSessionDisposition:
              candidate.runningSessionDisposition,
            ...(candidate.runningSessionRevocationScope
              ? {
                  runningSessionRevocationScope:
                    candidate.runningSessionRevocationScope,
                }
              : {}),
          });
        },
        async rebase(nextCandidate) {
          const retainedPreparedActivations = registry.retainPreparedActivationRegistryComponents?.() ?? [];
          if (retainedPreparedActivations.length === 0) {
            throw new Error('Prepared plugin activation cannot be retained across a registry base retry');
          }
          try {
            const rebased = await prepareCandidate(nextCandidate, retainedPreparedActivations);
            await disposeOnce();
            return rebased;
          } catch (error) {
            await Promise.all(retainedPreparedActivations.map((lease) => (
              lease.release().catch(() => undefined)
            )));
            throw error;
          }
        },
        async adopt(record) {
          if (adopted) return appliedGenerationsByPluginId;
          if (JSON.stringify(record.pluginGenerations) !== JSON.stringify(candidate.pluginGenerations)) {
            await disposeOnce();
            throw new Error('Committed plugin generations differ from the prepared runtime candidate');
          }
          const custodyEntries: PreparedActivationCustody[] = [];
          const releasePreparedCustody = async (): Promise<void> => {
            for (const custody of custodyEntries) {
              if (committedPreparedActivationCustodyByPluginId.get(custody.pluginId) === custody) {
                committedPreparedActivationCustodyByPluginId.delete(custody.pluginId);
              }
            }
            await Promise.all(custodyEntries.map(async (custody) => await custody.lease.release()));
          };
          try {
            for (const lease of registry.retainPreparedActivationRegistryComponents?.() ?? []) {
              const pluginIds = [...lease.pluginIds];
              const pluginId = pluginIds.length === 1 ? pluginIds[0] : undefined;
              const immutableGenerationId = pluginId
                ? candidate.pluginGenerations[pluginId]?.immutableGenerationId
                : undefined;
              if (
                !pluginId
                || !immutableGenerationId
                || !changedPluginIds.has(pluginId)
              ) {
                await lease.release();
                continue;
              }
              if (committedPreparedActivationCustodyByPluginId.has(pluginId)) {
                await lease.release();
                throw new Error(
                  `Committed plugin activation custody already exists for '${pluginId}'`,
                );
              }
              const custody = Object.freeze({
                pluginId,
                immutableGenerationId,
                lease,
              });
              committedPreparedActivationCustodyByPluginId.set(pluginId, custody);
              custodyEntries.push(custody);
            }
            const adoption = await params.reloadController.adoptPreparedRuntimeRegistry({
              registry,
              changedPluginIds: candidate.changedPluginIds,
              durableRevision: record.revision,
              runningSessionDisposition: candidate.runningSessionDisposition,
              ...(params.beforePublish ? { beforePublish: params.beforePublish } : {}),
            });
            if (!adoption.ok || !adoption.registry) {
              throw new Error('Prepared plugin runtime registry adoption did not publish');
            }
            adopted = true;
            await releasePreparedCustody().catch((error) => {
              logger.warn('[PLUGIN RUNTIME] Adopted plugin activation custody release failed', {
                error: projectPluginFailureText(error),
              });
            });
            appliedGenerationsByPluginId = Object.freeze(
              Object.fromEntries(candidate.changedPluginIds.map((pluginId) => {
                const current = adoption.registry
                  .pluginFinalPolicyCurrentGenerationsById
                  ?.get(pluginId);
                return [
                  pluginId,
                  current?.applied === true ? current.immutableGenerationId : null,
                ];
              })),
            );
            return appliedGenerationsByPluginId;
          } catch (error) {
            await releasePreparedCustody().catch(() => undefined);
            await disposeOnce();
            throw error;
          }
        },
      });
  }

  return Object.freeze({ prepare: prepareCandidate });
}
