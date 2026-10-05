import {
  createMergedContributionRegistry,
  getResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  projectLoadedPluginContributes,
} from '@/plugins/projection/registry/resolvePluginContributions';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import {
  readPreparedImmutablePluginGeneration,
  type CurrentCommittedPluginGeneration,
} from '@/plugins/store/registry/generationStore';
import type {
  PluginDevelopmentRuntimeCandidate,
  PluginDevelopmentRuntimeRemoval,
  PluginRegistryRuntimeCandidate,
  PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  resolveExecutablePluginRuntimeRegistry,
  type PluginRuntimeGenerationAuthority,
  type PluginRuntimeMachineAdmissionTransport,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeActivationRegistryLease } from '@/plugins/runtime/composition/activationAssembly';
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
  ManagedServiceSessionBaseUrlResolver,
  ManagedServiceSessionClientAccessResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
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
import type { ClientContributedActionExecutor } from '../invocation/actions/executeContributedAction';
import type { ResolveSessionResourceAccess } from '@/plugins/runtime/invocation/services/resources';
import type { ResolvedContributionInputs, ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  DevelopmentPluginSourceCustody,
  PluginRuntimeSourceAuthority,
} from '@/plugins/runtime/sourceAuthority';

import {
  type PluginRuntimeRegistryBeforePublish,
  type PluginReloadController,
} from './controller';
import {
  activatePluginRuntimeForReadiness,
  assertPluginRuntimeReadiness,
  bootstrapPrimaryAgentRuntimesForReadiness,
} from './readiness';

function omitPluginFromContributionInputs(
  registry: ResolvedContributionRegistry,
  pluginId: string,
): ResolvedContributionInputs {
  const filtered = Object.fromEntries(Object.entries(registry).map(([key, value]) => {
    if (Array.isArray(value)) {
      return [key, Object.freeze(value.filter((entry: unknown) => (
        !entry || typeof entry !== 'object' || !('pluginId' in entry) || entry.pluginId !== pluginId
      )))];
    }
    if (
      value
      && typeof value === 'object'
      && (key === 'pluginDiagnosticsByPluginId'
        || key === 'materializationIdsByPluginId'
        || key === 'immutableGenerationIdsByPluginId'
        || key === 'occurrenceIdsByPluginId')
    ) {
      return [key, Object.freeze(Object.fromEntries(
        Object.entries(value).filter(([entryPluginId]) => entryPluginId !== pluginId),
      ))];
    }
    return [key, value];
  }));
  // createResolvedContributionRegistry consumes only ResolvedContributionInputs
  // fields; this boundary mechanically removes one plugin from that exact shape.
  return filtered as ResolvedContributionInputs;
}

function projectDevelopmentContributes(
  candidate: PluginDevelopmentRuntimeCandidate,
  active: ResolvedContributionRegistry,
): ResolvedContributionRegistry {
  const replacement = projectLoadedPluginContributes({
    loadResult: {
      loadedPlugins: [Object.freeze({
        pluginId: candidate.pluginId,
        pluginRootPath: candidate.preparedActivationGraph.rootPath,
        manifestPath: candidate.preparedActivationGraph.entryPath,
        daemonEntryPath: null,
        devDaemonEntryPath: candidate.preparedActivationGraph.entryPath,
        manifest: candidate.manifest,
        sourceSpec: Object.freeze({
          kind: 'path' as const,
          locator: candidate.preparedActivationGraph.rootPath,
          trustPolicy: 'local_trusted' as const,
          installPolicy: 'link' as const,
          resolvedVersion: candidate.manifest.version,
          devWatch: true,
        }),
      })],
      diagnosticsByPluginId: Object.freeze({}),
    },
    provenance: 'external',
    existingAgentIds: new Set(active.agents
      .filter((agent) => agent.pluginId !== candidate.pluginId)
      .map((agent) => agent.id)),
  });
  return createMergedContributionRegistry(
    replacement,
    omitPluginFromContributionInputs(active, candidate.pluginId),
  );
}

async function createCandidateGenerationAuthority(params: Readonly<{
  happyHomeDir: string;
  candidate: PluginRegistryRuntimeCandidate;
  isValid: () => boolean;
}>): Promise<PluginRuntimeGenerationAuthority> {
  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  const generations = new Map<string, CurrentCommittedPluginGeneration>();
  for (const [pluginId, reference] of Object.entries(params.candidate.pluginOccurrenceIds)) {
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
    isCurrent: async () => params.isValid(),
  });
}

async function resolveCandidateContributes(
  candidate: PluginRegistryRuntimeCandidate,
  startupMode: 'normal' | 'pluginRecovery',
) {
  const builtIn = getResolvedContributionRegistry();
  if (startupMode === 'pluginRecovery') return builtIn;
  const materializationIdsByPluginId = Object.freeze(Object.fromEntries(
    Object.entries(candidate.installationState.plugins).flatMap(([pluginId, installation]) => (
      installation.materializationId === undefined
        ? []
        : [[pluginId, installation.materializationId] as const]
    )),
  ));
  const loadResult = await loadPluginsFromState(
    candidate.runtimeCatalog,
    materializationIdsByPluginId,
  );
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
  executeClientAction?: ClientContributedActionExecutor;
  /** Existing authenticated Machine admission authority for protected Session input. */
  machineAdmissionTransport?: PluginRuntimeMachineAdmissionTransport;
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
  onTerminalActivationFailure?: (pluginId: string) => void;
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
  resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver;
  resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver;
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
  resolveDevelopmentSourceAuthority?: (input: Readonly<{
    pluginId: string;
    rootPath: string;
  }>) => Extract<PluginRuntimeSourceAuthority, DevelopmentPluginSourceCustody> | null;
  isDevelopmentSourceRegistered?: (registeredRootId: string) => boolean;
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

  async function assertDevelopmentPluginEnabled(pluginId: string): Promise<void> {
    const catalog = await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read();
    if (catalog.plugins[pluginId]?.state.enabled === false) {
      throw new Error(`Plugin '${pluginId}' is disabled`);
    }
  }

  async function prepareCandidate(
    candidate: PluginRegistryRuntimeCandidate | null,
    preparedActivationRegistryLeases: readonly PluginRuntimeActivationRegistryLease[] = Object.freeze([]),
    developmentCandidate?: PluginDevelopmentRuntimeCandidate,
    developmentRemoval?: PluginDevelopmentRuntimeRemoval,
  ): Promise<Omit<Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>>, 'adopt'> & Readonly<{
    adopt: (
      record?: Parameters<Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>>['adopt']>[0],
    ) => Promise<Readonly<Record<string, string | null>> | void>;
  }>> {
      if (!candidate && !developmentCandidate && !developmentRemoval) {
        throw new Error('Plugin runtime candidate is required');
      }
      if (developmentCandidate) {
        await assertDevelopmentPluginEnabled(developmentCandidate.pluginId);
      }
      let valid = true;
      let disposed = false;
      let adopted = false;
      let appliedGenerationsByPluginId:
        Readonly<Record<string, string | null>> | undefined;
      const activeRegistry = params.reloadController.getState().activeRegistry;
      const contributes = developmentCandidate
        ? projectDevelopmentContributes(
            developmentCandidate,
            activeRegistry?.contributes ?? getResolvedContributionRegistry(),
          )
        : developmentRemoval
          ? createMergedContributionRegistry(
              Object.freeze({}),
              omitPluginFromContributionInputs(
                activeRegistry?.contributes ?? getResolvedContributionRegistry(),
                developmentRemoval.pluginId,
              ),
            )
          : await resolveCandidateContributes(candidate!, params.startupMode ?? 'normal');
      const generationAuthority = developmentCandidate || developmentRemoval
        ? Object.freeze({
            commit: null,
            generations: new Map(),
            rejectedGenerations: new Map(),
            isCurrent: async () => valid,
          })
        : await createCandidateGenerationAuthority({
            happyHomeDir: params.happyHomeDir,
            candidate: candidate!,
            isValid: () => valid,
          });
      const changedPluginIdList = developmentCandidate
        ? Object.freeze([developmentCandidate.pluginId])
        : developmentRemoval
          ? Object.freeze([developmentRemoval.pluginId])
        : candidate!.changedPluginIds;
      const changedPluginIds = new Set(changedPluginIdList);
      const candidatePluginGenerations: PluginRegistryRuntimeCandidate['pluginOccurrenceIds'] =
        candidate?.pluginOccurrenceIds ?? Object.freeze({});
      const retainedPreparedPeerActivationLeases: PluginRuntimeActivationRegistryLease[] = [];
      const retainedPreparedPeerPluginIds = new Set<string>();
      for (const [pluginId, reference] of Object.entries(candidatePluginGenerations)) {
        if (changedPluginIds.has(pluginId)) continue;
        const custody = committedPreparedActivationCustodyByPluginId.get(pluginId);
        if (
          !custody
          || custody.immutableGenerationId !== reference.immutableGenerationId
          || candidate?.installationState.plugins[pluginId]?.enabled !== true
          || candidate?.runtimeCatalog.plugins[pluginId]?.state.enabled !== true
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
      // Unchanged serving slots keep their activation components. An active
      // plugin whose component cannot serve a successor (fenced by a durable
      // commit whose publication failed) is prepared again on its own; its
      // peers are never re-activated for it.
      const servingSlots = (activeRegistry
        ? params.reloadController.retainServingSlots?.(replacedPluginIds)
        : undefined)
        ?? Object.freeze({
          occurrencesByPluginId: new Map(),
          leases: Object.freeze([]),
          unretainedActivePluginIds: Object.freeze([]),
        });
      const canPrepareOnlyChangedPlugins = Boolean(
        preparedActivationRegistryLeases.length > 0
        || retainedPreparedPeerActivationLeases.length > 0
        || activeRegistry
        || Object.keys(candidatePluginGenerations).every((pluginId) => changedPluginIdList.includes(pluginId))
      );
      const activationOccurrenceId = typeof activeRegistry?.generation === 'number'
        ? activeRegistry.generation
        : params.reloadController.getState().generation + 1;
      const retainedActivationRegistryLeases = [
        ...servingSlots.leases,
        ...retainedPreparedPeerActivationLeases,
        ...preparedActivationRegistryLeases,
      ];
      let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
      try {
        const stableEventsBroker =
          params.readStableEventsBroker?.() ?? null;
        const targetedContributions =
          params.reloadController.getTargetedContributionsOwner();
        registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: params.happyHomeDir,
            contributes,
            generation: activationOccurrenceId,
          ...(params.executeClientAction ? { executeClientAction: params.executeClientAction } : {}),
          ...(params.resolveCurrentMachineId
            ? { resolveCurrentMachineId: params.resolveCurrentMachineId }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
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
          ...(params.resolveDevelopmentSourceAuthority
            ? { resolveDevelopmentSourceAuthority: params.resolveDevelopmentSourceAuthority }
            : {}),
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
          ...(params.resolveManagedServiceSessionBaseUrl
            ? { resolveManagedServiceSessionBaseUrl: params.resolveManagedServiceSessionBaseUrl }
            : {}),
          ...(params.resolveManagedServiceSessionClientAccess
            ? { resolveManagedServiceSessionClientAccess: params.resolveManagedServiceSessionClientAccess }
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
          // Required on the controller contract, so this is unconditional: a
          // registry that silently self-targeted would reintroduce predecessor
          // routing for every long-lived plugin context it builds.
          currentGlobalExternalSessionsRouter:
            params.reloadController.currentGlobalExternalSessions,
          ...(params.onTerminalActivationFailure
            ? { onTerminalActivationFailure: params.onTerminalActivationFailure }
            : {}),
          ...(candidate?.preparedActivationGraphsByPluginId
            ? {
                preparedActivationGraphsByPluginId:
                  candidate.preparedActivationGraphsByPluginId,
              }
            : {}),
          ...(developmentCandidate
            ? {
                preparedDevelopmentActivationGraphsByPluginId: new Map([
                  [developmentCandidate.pluginId, developmentCandidate.preparedActivationGraph],
                ]),
              }
            : {}),
          ...(params.daemonDatabaseLimits
            ? { daemonDatabaseLimits: params.daemonDatabaseLimits }
            : {}),
          ...(canPrepareOnlyChangedPlugins ? {
            pluginIds: preparedActivationRegistryLeases.length > 0
              ? Object.freeze([])
              : Object.freeze([...new Set([...changedPluginIdList, ...servingSlots.unretainedActivePluginIds])]),
          } : {}),
          ...(retainedActivationRegistryLeases.length > 0
            ? {
                retainedActivationRegistryLeases:
                  Object.freeze(retainedActivationRegistryLeases),
              }
            : {}),
          ...(servingSlots.occurrencesByPluginId.size > 0
            ? { servingPluginOccurrences: servingSlots.occurrencesByPluginId }
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
          pluginIds: changedPluginIdList,
        });
        const candidateDaemonDatabasePluginIds = changedPluginIdList.filter((pluginId) => (
          registry.contributes.activationTargets.some((target) => (
            target.pluginId === pluginId
            && target.manifest.contributes.daemonDatabases.length > 0
          ))
        ));
        // A disable, uninstall, or declaration removal has no candidate
        // declaration to select, but its incumbent can still own native SQLite
        // handles. Read the active host's prepared contracts as the one
        // authoritative proof that it must be quiesced before adoption.
        const incumbentDaemonDatabasePluginIds = changedPluginIdList.filter((pluginId) => (
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
        const executableChangedPluginIds = developmentCandidate
          ? changedPluginIdList
          : developmentRemoval
            ? Object.freeze([])
          : changedPluginIdList.filter((pluginId) => (
              candidate!.runtimeCatalog.plugins[pluginId]?.state.enabled === true
            ));
        assertPluginRuntimeReadiness({
          registry,
          executablePluginIds: executableChangedPluginIds,
        });
        await bootstrapPrimaryAgentRuntimesForReadiness({
          registry,
          pluginIds: changedPluginIdList,
        });
      } catch (error) {
        await disposeOnce();
        throw error;
      }

      if (developmentCandidate || developmentRemoval) {
        const candidateToAdopt = developmentCandidate;
        return Object.freeze({
          abort: disposeOnce,
          async adopt() {
            if (adopted) return;
            if (candidateToAdopt) {
              try {
                await assertDevelopmentPluginEnabled(candidateToAdopt.pluginId);
              } catch (error) {
                await disposeOnce();
                throw error;
              }
            }
            const adoption = await params.reloadController.adoptPreparedRuntimeRegistry({
              registry,
              changedPluginIds: changedPluginIdList,
              runningSessionDisposition: 'retainRunningSessions',
              isDevelopmentCandidateCurrent: () => {
                if (!valid) return false;
                if (developmentRemoval) {
                  return params.isDevelopmentSourceRegistered?.(
                    developmentRemoval.registeredRootId,
                  ) === false;
                }
                const current = params.resolveDevelopmentSourceAuthority?.({
                  pluginId: candidateToAdopt!.pluginId,
                  rootPath: candidateToAdopt!.sourceAuthority.registeredRootId,
                });
                return current?.registeredRootId === candidateToAdopt!.sourceAuthority.registeredRootId
                  && current.canonicalRoot === candidateToAdopt!.sourceAuthority.canonicalRoot
                  && current.observedRevision === candidateToAdopt!.sourceAuthority.observedRevision;
              },
              ...(params.beforePublish ? { beforePublish: params.beforePublish } : {}),
            });
            if (!adoption.ok || !adoption.registry) {
              throw new Error('Prepared plugin development runtime adoption did not publish');
            }
            adopted = true;
          },
        });
      }

      const durableCandidate = candidate!;

      return Object.freeze({
        abort: disposeOnce,
        notifyDurableRunningSessionDisposition(record: PluginRegistryCommitRecord) {
          // The durable commit is the point after which the predecessor can
          // never become current again, even when publication reconciliation
          // later fails. Fence only the changed plugin occurrences here;
          // lease-safe resource retirement remains owned by adoption.
          params.reloadController.getState().activeRegistry
            ?.fencePluginConsumers?.(durableCandidate.changedPluginIds);
          params.reloadController.publishDurableRunningSessionDisposition({
            durableRevision: record.revision,
            changedPluginIds: durableCandidate.changedPluginIds,
            runningSessionDisposition:
              durableCandidate.runningSessionDisposition,
            ...(durableCandidate.runningSessionRevocationScope
              ? {
                  runningSessionRevocationScope:
                    durableCandidate.runningSessionRevocationScope,
                }
              : {}),
          });
        },
        async rebase(nextCandidate: PluginRegistryRuntimeCandidate) {
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
        async adopt(record?: PluginRegistryCommitRecord) {
          if (adopted) return appliedGenerationsByPluginId;
          if (!record) throw new Error('Durable plugin runtime adoption requires a commit record');
          if (JSON.stringify(record.pluginOccurrenceIds) !== JSON.stringify(durableCandidate.pluginOccurrenceIds)) {
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
                ? durableCandidate.pluginOccurrenceIds[pluginId]?.immutableGenerationId
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
              changedPluginIds: durableCandidate.changedPluginIds,
              durableRevision: record.revision,
              runningSessionDisposition: durableCandidate.runningSessionDisposition,
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
              Object.fromEntries(durableCandidate.changedPluginIds.map((pluginId) => {
                const current = adoption.registry
                  .pluginFinalPolicyCurrentRuntimesById
                  ?.get(pluginId);
                return [
                  pluginId,
                  current?.applied === true
                    && current.sourceCustody.kind === 'managed'
                    ? current.sourceCustody.immutableGenerationId
                    : null,
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

  return Object.freeze({
    prepare: async (candidate) => await prepareCandidate(candidate),
    async prepareDevelopment(candidate) {
      const prepared = await prepareCandidate(null, Object.freeze([]), candidate);
      return Object.freeze({
        abort: prepared.abort,
        adopt: async () => { await prepared.adopt(); },
      });
    },
    async prepareDevelopmentRemoval(removal) {
      const custody = params.reloadController.readCurrentPluginSourceCustody?.(removal.pluginId);
      if (
        custody?.kind !== 'development'
        || custody.registeredRootId !== removal.registeredRootId
      ) return null;
      const prepared = await prepareCandidate(
        null,
        Object.freeze([]),
        undefined,
        removal,
      );
      return Object.freeze({
        abort: prepared.abort,
        adopt: async () => { await prepared.adopt(); },
      });
    },
  });
}
