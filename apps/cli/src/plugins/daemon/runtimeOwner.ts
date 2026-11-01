import { realpath } from 'node:fs/promises';
import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import { isPluginError } from '@happier-dev/plugin-sdk';
import {
  createDaemonPluginChangeService,
  type DaemonPluginChangeOwner,
  type DaemonPluginChangeService,
} from '@/plugins/daemon/changeService';
import { createDaemonNpmPluginChangePreparer } from '@/plugins/daemon/npmChangePreparer';
import type { MarketplaceRegistrySourcesReaderV1 } from '@/plugins/store/marketplace/service';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { readServerPluginManagedResources, type PluginManagedResourcePreflightBinding } from '@/plugins/availability/serverPublisher';
import { readCurrentDaemonPluginCatalog } from '@/plugins/daemon/currentCatalog';
import { projectPluginInstalledAvailabilityInventory } from '@/plugins/availability/releaseLessDeclarations';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { shouldActivateTargetAtStartup } from '@/plugins/runtime/lifecycle/activation/targets';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import {
  activatePluginRuntimeForReadiness,
  bootstrapPrimaryAgentRuntimesForReadiness,
} from '@/plugins/runtime/reload/readiness';
import {
  resolveExecutablePluginRuntimeRegistry,
  type PluginRuntimeMachineAdmissionTransport,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry, readCurrentBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/snapshot';
import {
  createPluginRegistryStateStore,
  type PluginRegistryAvailabilityInventory,
} from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import { logger } from '@/ui/logger';
import { seedPluginMcpServerDefaults } from '@/mcp/runtime/seedPluginMcpServerDefaults';
import { seedPluginSkillDefaults } from '@/prompts/skills/library/seedPluginSkillDefaults';
import { readPluginSkills } from '@/prompts/skills/library/readPluginSkills';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliMcpServerStore, type CliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { readCredentials } from '@/persistence';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
  ManagedServiceSessionBaseUrlResolver,
  ManagedServiceSessionClientAccessResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
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
import { updateSelectedPluginOptionalAccess } from '@/plugins/daemon/optionalAccessSelections';
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
import { subscribePluginAccountAvailabilityChanges } from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { ClientContributedActionExecutor } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import type { ResolveSessionResourceAccess } from '@/plugins/runtime/invocation/services/resources';
import type { PluginGenerationCustodyRetirementRemoteDependencies } from '@/plugins/store/registry/generationCustodyRetirement';
import {
  createDaemonPluginDevelopmentRootsOwner,
  type DaemonPluginDevelopmentRootsOwner,
} from '@/plugins/daemon/developmentRoots';

/** One author-readable reason per cold-start readiness step a plugin can fail. */
const COLD_START_READINESS_STAGE_REASONS = Object.freeze({
  activation: 'cold-start activation failed',
  daemonDatabases: 'cold-start daemon database preparation failed',
  primaryAgentRuntime: 'cold-start primary Agent runtime construction failed',
});

/** Bind plugin file materialization to the current daemon's transfer owner. */
export function createDaemonPluginTransferRpcResolver(
  resolveMachine: () => Pick<ApiMachineClient, 'getHostLocalTransferRpcHandler'> | null,
): () => RpcHandlerInvoker | null {
  return () => {
    const machine = resolveMachine();
    // The public Machine table serves prepared data-plane envelopes after startup.
    // Session/filesystem admission still belongs to the same upload lifecycle.
    return machine?.getHostLocalTransferRpcHandler() ?? null;
  };
}

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
  signal?: AbortSignal;
  readSpawnFailureLimits?: import('@/processes/spawnFailure/classifySpawnFailure').SpawnFailureLimitsReader;
  happyHomeDir: string;
  /** Captured daemon Account source owner, shared by staging and review revalidation. */
  readRegistrySources?: MarketplaceRegistrySourcesReaderV1;
  mcpServerStore?: Pick<CliMcpServerStore, 'readCatalogForOperation' | 'mutate'>;
  managedResourcePreflight?: PluginManagedResourcePreflightBinding;
  /** Daemon-owned live machine identity for host-stamped nested Action callers. */
  resolveCurrentMachineId?: () => string | null;
  readDaemonRequesterWorkAttribution?: () => RequesterWorkAttributionV1 | null;
  executeClientAction?: ClientContributedActionExecutor;
  /** Existing authenticated Machine admission authority for protected Session input. */
  machineAdmissionTransport?: PluginRuntimeMachineAdmissionTransport;
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
  /** Ordinary Inbox approval producer; candidate custody stays in changeService. */
  publishDevelopmentReview?: (input: Readonly<{
    sourceRootPath: string;
    changeService: DaemonPluginChangeService;
  }>) => Promise<void>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointReadHost;
  resolveManagedServiceSessionBaseUrl?: ManagedServiceSessionBaseUrlResolver;
  resolveManagedServiceSessionClientAccess?: ManagedServiceSessionClientAccessResolver;
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
  /** Authenticated server boundary used by registry generation retirement. */
  generationCustodyRetirement?: PluginGenerationCustodyRetirementRemoteDependencies;
}>): DaemonPluginRuntimeOwner {
  // A registry reload changes executable occurrences, not this host's prior
  // Account declaration admissions. All replacement Data hosts use this map.
  const accountStorageDependencies: AccountPluginDataStorageHostDependencies = {
    ...params.accountStorageDependencies,
    writerClaims: params.accountStorageDependencies?.writerClaims ?? new Map(),
  };
  // The controller owns this stable target-local observer across cold startup
  // and prepared registry replacement. Runtime construction only consumes it.
  const targetedContributions =
    params.reloadController.getTargetedContributionsOwner();
  const onTerminalActivationFailure = (): void => {
    params.reloadController.invalidateRuntimeProjection();
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
    || params.signal
  )
    ? async (
        registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>,
        publish: () => void,
      ) => {
        const publishCurrent = () => {
          params.signal?.throwIfAborted();
          publish();
        };
        if (beforePublish) await beforePublish(registry, publishCurrent);
        else publishCurrent();
        params.onInitialRegistryPublished?.();
        await params.awaitInitialRuntimeActivation?.();
      }
    : beforePublish;
  let stableEventsBroker: StablePluginEventsBroker | null = null;
  let developmentRoots: DaemonPluginDevelopmentRootsOwner | null = null;
  let unsubscribeAccountAvailability: (() => void) | null = null;
  const resolveDevelopmentSourceAuthority: DaemonPluginDevelopmentRootsOwner['resolveDevelopmentSourceAuthority'] = (
    input,
  ) => developmentRoots?.resolveDevelopmentSourceAuthority(input) ?? null;
  const runtimeLifecycle = createDaemonPluginRegistryRuntimeLifecycle({
    ...(params.signal ? { signal: params.signal } : {}),
    beforeInstallPublish: async (registry, pluginIds, firstInstallPluginIds) => {
      const declarations = (registry.contributes.mcpServers ?? []).filter(entry => entry.pluginId && pluginIds.includes(entry.pluginId));
      const skillDeclarations = (registry.contributes.skills ?? []).filter(entry => firstInstallPluginIds.includes(entry.pluginId));
      if (declarations.length === 0 && skillDeclarations.length === 0) return;
      const credentials = !params.mcpServerStore || skillDeclarations.length > 0 ? await readCredentials() : null;
      if (declarations.length > 0) {
        const store = params.mcpServerStore ?? (credentials ? createCliMcpServerStore({ credentials }) : null);
        if (!store) throw new Error('mcp_plugin_defaults_account_unavailable');
        await seedPluginMcpServerDefaults({ declarations, store });
      }
      if (skillDeclarations.length > 0) {
        if (!credentials) throw new Error('skill_plugin_defaults_account_unavailable');
        const skills = await readPluginSkills(undefined, undefined, { ...registry.contributes, skills: skillDeclarations });
        const port = createCliApprovalsArtifactStore({ credentials }).skillRules;
        await seedPluginSkillDefaults({ skills, port: { ...port, listSkills: (signal, skillIds) =>
          readSkillLibraryCatalog({ ...createCredentialedAccountArtifactStore(credentials), readPluginSkills: async () => skills }, signal, skillIds) } });
      }
    },
    readSpawnFailureLimits: params.readSpawnFailureLimits,
    happyHomeDir: params.happyHomeDir,
    ...(params.executeClientAction ? { executeClientAction: params.executeClientAction } : {}),
    ...(params.resolveCurrentMachineId
      ? { resolveCurrentMachineId: params.resolveCurrentMachineId }
      : {}),
    ...(params.readDaemonRequesterWorkAttribution
      ? { readDaemonRequesterWorkAttribution: params.readDaemonRequesterWorkAttribution }
      : {}),
    ...(params.machineAdmissionTransport
      ? { machineAdmissionTransport: params.machineAdmissionTransport }
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
    accountStorageDependencies,
    ...(params.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
      : {}),
    reloadController: params.reloadController,
    resolveDevelopmentSourceAuthority,
    isDevelopmentSourceRegistered: (registeredRootId) => (
      developmentRoots?.isDevelopmentSourceRegistered(registeredRootId) === true
    ),
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
    ...(params.managedResourcePreflight ? { readManagedResources: (pluginId, dispositions) =>
      readServerPluginManagedResources(params.managedResourcePreflight!, pluginId, dispositions) } : {}),
    ...(params.generationCustodyRetirement
      ? { generationCustodyRetirement: params.generationCustodyRetirement }
      : {}),
  });
  const prepareNpm = createDaemonNpmPluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    readRegistrySources: params.readRegistrySources,
    runtimeLifecycle,
    onRegistryApplied,
    ...(params.generationCustodyRetirement
      ? { generationCustodyRetirement: params.generationCustodyRetirement }
      : {}),
  });
  const prepareArchive = createDaemonArchivePluginChangePreparer({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    onRegistryApplied,
    ...(params.generationCustodyRetirement
      ? { generationCustodyRetirement: params.generationCustodyRetirement }
      : {}),
  });
  const baseChangeService = createDaemonPluginChangeService({
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
        if (update.kind === 'archive') {
          return await prepareArchive(update.request, {
            installedUpdate: { pluginId: request.pluginId },
          });
        }
        return await preparePath(update.request, {
          installedUpdate: { pluginId: request.pluginId },
        });
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
    applyDevelopment: async (candidate, decision) => {
      if (!runtimeLifecycle.prepareDevelopment) {
        throw new Error('Plugin development runtime lifecycle is unavailable');
      }
      const prepared = await runtimeLifecycle.prepareDevelopment(candidate);
      try {
        {
          if (
            candidate.registryRevision === undefined
            || !candidate.priorOptionalAccess
            || !candidate.installReviewPrincipal
          ) {
            throw new Error('Plugin development authority candidate is incomplete');
          }
          const optionalAccess = decision
            ? updateSelectedPluginOptionalAccess({
                pluginId: candidate.pluginId,
                manifest: candidate.manifest,
                existing: candidate.priorOptionalAccess,
                decisions: decision.optionalSelections,
                selectedAtMs: Date.now(),
              })
            : candidate.preservedOptionalAccess ?? null;
          if (!optionalAccess) throw new Error('Plugin development authority requires a fresh review');
          const principal = decision
            ? candidate.installReviewPrincipal
            : candidate.priorInstallReviewPrincipal;
          const authorityCommit = await createPluginRegistryStateStore({
            happyHomeDir: params.happyHomeDir,
            runtimeLifecycle,
          }).approveDevelopmentAuthorityWithResult({
            pluginId: candidate.pluginId,
            expectedRevision: candidate.registryRevision,
            approvedAuthorityManifest: candidate.manifest,
            catalogRecord: candidate.catalogRecord,
            trust: candidate.trust,
            updatePolicy: candidate.updatePolicy,
            optionalAccess,
            ...(principal
              ? {
                  installReviewPrincipalDigest: principal.digest,
                  installReviewPrincipalPresentation: principal.presentation,
                }
              : {}),
          });
          if (!authorityCommit) {
            await prepared.abort().catch(() => undefined);
            return Object.freeze({ kind: 'conflict' as const, pluginId: candidate.pluginId });
          }
        }
        await prepared.adopt();
        const occurrenceId = params.reloadController.readCurrentPluginOccurrenceId?.(candidate.pluginId);
        developmentRoots?.recordSourceCommit({
          sourceRootPath: candidate.sourceAuthority.registeredRootId,
          observedRevision: candidate.sourceAuthority.observedRevision,
          pluginId: candidate.pluginId,
          ...(occurrenceId ? { occurrenceId } : {}),
        });
        return Object.freeze({
          kind: 'committed' as const,
          pluginId: candidate.pluginId,
          desiredGeneration: null,
          appliedGeneration: null,
          pendingSurfaces: Object.freeze([]),
        });
      } catch (error) {
        await prepared.abort().catch(() => undefined);
        throw error;
      }
    },
  });
  developmentRoots = createDaemonPluginDevelopmentRootsOwner({
    happyHomeDir: params.happyHomeDir,
    hasPendingSourceChange: baseChangeService.hasPendingDevelopmentSourceChange,
    prepareSourceRemoval: async (input) => {
      const prepared = runtimeLifecycle.prepareDevelopmentRemoval
        ? await runtimeLifecycle.prepareDevelopmentRemoval(input)
        : null;
      return Object.freeze({
        abort: prepared?.abort ?? (async () => undefined),
        adopt: async () => {
          await prepared?.adopt();
          // The durable registry owner already owns source-code trust. Revoke
          // that exact development authority after its process-local
          // occurrence is gone so a deliberate unregister/re-admit may adopt
          // a changed manifest id without leaving the old path identity live.
          await createPluginRegistryStateStore({
            happyHomeDir: params.happyHomeDir,
            runtimeLifecycle,
          }).forgetTrustWithResult(input.pluginId, {
            expectedDevelopmentRootId: input.registeredRootId,
          });
        },
      });
    },
    submitObservation: async (observation) => {
      const request = {
        kind: 'development' as const,
        ...(observation.request.pluginId ? { pluginId: observation.request.pluginId } : {}),
        sourceRootPath: observation.request.projectRoot,
        observedRevision: observation.request.observedRevision,
        ...(observation.request.changedPaths
          ? { changedPaths: observation.request.changedPaths }
          : {}),
        ...(observation.request.sdkRegistryOrigin
          ? { sdkRegistryOrigin: observation.request.sdkRegistryOrigin }
          : {}),
      };
      const result = await baseChangeService.requestPluginChange(request);
      if (result.kind === 'reviewRequired') await publishDevelopmentReview(request.sourceRootPath);
      const status = result.kind === 'reviewRequired'
        ? await baseChangeService.statusPluginChange({ pendingChangeId: result.pendingChangeId }) : null;
      // A user-waived install can finish during ordinary Action admission.
      // Project that same owner's terminal result rather than a stale review.
      const outcome = status?.kind === 'terminal' ? status.result : result;
      const pluginId = observation.request.pluginId ?? ('pluginId' in outcome ? outcome.pluginId : undefined);
      const occurrenceId = outcome.kind === 'committed' && pluginId
        ? params.reloadController.readCurrentPluginOccurrenceId?.(pluginId) ?? null
        : null;
      return {
        ...outcome,
        ...(pluginId ? { pluginId } : {}),
        ...(occurrenceId ? { occurrenceId } : {}),
      };
    },
  });
  const projectPendingWorkspaceTrust = (
    pending: ReturnType<DaemonPluginDevelopmentRootsOwner['readPendingProjectTrusts']>[number],
  ) => Object.freeze({
    kind: 'reviewRequired' as const,
    reviewKind: 'projectTrust' as const,
    pendingChangeId: pending.pendingChangeId,
    review: Object.freeze({
      source: Object.freeze({ kind: 'path' as const, locator: pending.projectRoot }),
    }),
  });
  const readPendingWorkspaceTrust = (pendingChangeId: string) => (
    developmentRoots?.readPendingProjectTrusts()
      .find((pending) => pending.pendingChangeId === pendingChangeId) ?? null
  );
  async function publishDevelopmentReview(sourceRootPath: string): Promise<void> {
    try {
      await params.publishDevelopmentReview?.({ sourceRootPath, changeService: baseChangeService });
    } catch (error) {
      // Retain the candidate on transport failure. Rejoining the root or the
      // public install Action republishes its same ordinary approval.
      logger.warnLocalFile('[plugins] Development approval publication failed', {
        sourceRootPath, error: projectPluginFailureText(error),
      });
    }
  }
  const changeService: DaemonPluginChangeOwner = Object.freeze({
    ...baseChangeService,
    async requestPluginChange(request, options) {
      if (request.kind === 'development' && request.observedRevision === undefined) {
        const registeredRootId = await realpath(request.sourceRootPath).catch(() => null);
        if (registeredRootId && !options?.signal?.aborted && !baseChangeService.isQuiescing()
          && !baseChangeService.hasPendingDevelopmentSourceChange(registeredRootId)) {
          // Re-adoption refreshes through the same observation owner as a
          // watched edit before capturing its revision. Preparing directly
          // against the previous observation races that edit's watcher.
          const registration = await developmentRoots!.control(
            developmentRoots!.resolveRegisteredSourceObservation(registeredRootId)
              ? { kind: 'reload', rootPath: registeredRootId }
              : { kind: 'registerExplicit', rootPath: registeredRootId,
                  ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}) },
          );
          if (baseChangeService.hasPendingDevelopmentSourceChange(registeredRootId)) {
            return await baseChangeService.requestPluginChange(request, options);
          }
          if (registration.kind === 'failed') {
            return Object.freeze({ kind: 'failed' as const, code: registration.code, message: registration.message });
          }
          const observation = developmentRoots!.resolveRegisteredSourceObservation(registeredRootId);
          if (observation) {
            return await baseChangeService.requestPluginChange({
              ...request,
              sourceRootPath: observation.registeredRootId,
              observedRevision: observation.observedRevision,
            }, options);
          }
        }
      }
      return await baseChangeService.requestPluginChange(request, options);
    },
    async controlPluginDevelopment(request) {
      const sourceRootPath = request.kind === 'registerExplicit' || request.kind === 'reload' || request.kind === 'invalidate'
        ? await realpath(request.rootPath).catch(() => null) : null;
      const rejoinsReview = sourceRootPath !== null && baseChangeService.hasPendingDevelopmentSourceChange(sourceRootPath);
      const result = await developmentRoots!.control(request);
      if (rejoinsReview && sourceRootPath && baseChangeService.hasPendingDevelopmentSourceChange(sourceRootPath)) {
        await publishDevelopmentReview(sourceRootPath);
      }
      return result;
    },
    async listPendingPluginChanges() {
      const base = await baseChangeService.listPendingPluginChanges();
      return Object.freeze({
        changes: Object.freeze([
          ...base.changes,
          ...developmentRoots!.readPendingProjectTrusts().map(projectPendingWorkspaceTrust),
        ]),
      });
    },
    async statusPluginChange(request) {
      const pending = readPendingWorkspaceTrust(request.pendingChangeId);
      return pending
        ? projectPendingWorkspaceTrust(pending)
        : await baseChangeService.statusPluginChange(request);
    },
    async decidePluginChange(decision) {
      const pending = readPendingWorkspaceTrust(decision.pendingChangeId);
      if (!pending) return await baseChangeService.decidePluginChange(decision);
      const result = await developmentRoots!.control({
        kind: 'registerWorkspace',
        projectRoot: pending.projectRoot,
        trust: decision.decision === 'cancel' ? 'deny' : 'accept',
      });
      if (result.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, code: result.code, message: result.message });
      }
      return decision.decision === 'cancel'
        ? Object.freeze({ kind: 'cancelled' as const })
        : Object.freeze({ kind: 'projectTrustAccepted' as const, projectRoot: pending.projectRoot });
    },
    async shutdown() {
      unsubscribeAccountAvailability?.();
      unsubscribeAccountAvailability = null;
      await developmentRoots.stop();
      await baseChangeService.shutdown();
    },
  });
  const stateStore = createPluginRegistryStateStore({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle,
    runHardRevocationCurrentnessChange: baseChangeService.runHardRevocationCurrentnessChange,
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
    const failures = error instanceof AggregateError
      ? error.errors.flatMap((failure: unknown) => {
        if (!isPluginError(failure) || !failure.details || typeof failure.details !== 'object'
          || Array.isArray(failure.details) || !('pluginId' in failure.details)
          || typeof failure.details.pluginId !== 'string') return [];
        return [{ pluginId: failure.details.pluginId, code: failure.code }];
      })
      : [];
    logger.debug('[PLUGIN RUNTIME] Plugin availability report failed (non-fatal)', {
      revision,
      error: projectPluginFailureText(error),
      ...(failures.length > 0 ? { failures } : {}),
    });
  };
  /**
   * The install registry reports what it records. Daemon-selected plugins with
   * a release-less declaration and no registry record (bundled first-party,
   * checkout development roots) are machine materializations only the live
   * runtime knows, so the one report adds them from the serving registry.
   */
  const reportAvailability = async (
    inventory: PluginRegistryAvailabilityInventory,
    reporter: DaemonPluginAvailabilityReporter,
  ): Promise<void> => {
    const lease = params.reloadController.tryAcquireRuntimeRegistry();
    if (!lease) {
      projectPluginInstalledAvailabilityInventory({ inventory, registry: null, registryRevision: null, runtimeMaterializations: [] });
      return;
    }
    try {
      const complete = projectPluginInstalledAvailabilityInventory({
        inventory,
        registry: lease.registry.contributes,
        registryRevision: lease.durableRevision,
        runtimeMaterializations: lease.registry.readReleaseLessMaterializations?.() ?? [],
      });
      await reporter.report(complete);
      // Native provisioners need declaration admission before Save/acquire,
      // even when they declare no Account storage capability or Collections.
      // Startup, reload and reconnect reuse this same publication lifecycle.
      await lease.registry.claimReleaseLessDeclarations();
    } finally {
      await lease.release();
    }
  };
  reportAvailabilityAfterApplied = (record) => {
    const reporter = params.availabilityReporter;
    if (!reporter) return;
    // Runtime application is already durable. Availability is a best-effort
    // consumer: transport failure never changes the local transaction.
    void stateStore.readAvailabilityInventoryForCommit(record)
      .then(async (inventory) => await reportAvailability(inventory, reporter))
      .catch((error: unknown) => reportAvailabilityFailure(error, record.revision));
  };
  const reportCurrentAvailability = (): void => {
    const reporter = params.availabilityReporter;
    if (!reporter) return;
    void stateStore.readAvailabilityInventory()
      .then(async (inventory) => await reportAvailability(inventory, reporter))
      .catch((error: unknown) => reportAvailabilityFailure(error, -1));
  };

  return Object.freeze({
    changeService,
    async initialize() {
      params.signal?.throwIfAborted();
      if (params.staleCandidateCleanup === 'exclusiveHome') {
        await cleanupStaleDaemonPluginCandidateRoots(params.happyHomeDir);
      }
      await stateStore.initialize();
      params.signal?.throwIfAborted();
      const initialLease = await params.reloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: async () => {
          const registry = await resolveExecutablePluginRuntimeRegistry({
            ...(params.signal ? { signal: params.signal } : {}),
            readSpawnFailureLimits: params.readSpawnFailureLimits,
            happyHomeDir: params.happyHomeDir,
            ...(params.executeClientAction ? { executeClientAction: params.executeClientAction } : {}),
            generation: params.reloadController.getState().generation + 1,
            ...(params.resolveCurrentMachineId
              ? { resolveCurrentMachineId: params.resolveCurrentMachineId }
              : {}),
            ...(params.readDaemonRequesterWorkAttribution
              ? { readDaemonRequesterWorkAttribution: params.readDaemonRequesterWorkAttribution }
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
            accountStorageDependencies,
            ...(params.resolveServerFeaturesSnapshot
              ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
              : {}),
            resolveDevelopmentSourceAuthority,
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
              ? { contributes: getResolvedContributionRegistry({ pluginEnablementById: await readCurrentBundledPluginEnablement({
                  happyHomeDir: params.happyHomeDir, accountStorageDependencies: params.accountStorageDependencies,
                }) }) }
              : {}),
          });
          // Cold start has no serving incumbent to preserve, so isolate a rejected
          // participant at the canonical activation owner and publish the healthy
          // remainder without advertising the failed plugin. Isolation is keyed on
          // the structural failure, never its provenance: a bundled participant is
          // fenced exactly like an external one. The reload path deliberately keeps
          // the opposite contract — there the changed candidate is discarded whole
          // because the incumbent is still serving.
          const isolateReadinessParticipant = async (
            pluginId: string,
            stage: keyof typeof COLD_START_READINESS_STAGE_REASONS,
            run: () => Promise<void>,
          ): Promise<void> => {
            try {
              params.signal?.throwIfAborted();
              await run();
            } catch (error) {
              params.signal?.throwIfAborted();
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
            params.signal?.throwIfAborted();
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
            await Promise.all(readinessPluginIds.map(async (pluginId) => {
              // A plugin an earlier readiness step already fenced is retired.
              // Constructing its runtime against that retired generation would
              // only fail again and record a second reason for one rejection.
              if (!registry.activatedPluginIds.has(pluginId)) return;
              await isolateReadinessParticipant(pluginId, 'primaryAgentRuntime', async () => {
                await bootstrapPrimaryAgentRuntimesForReadiness({
                  registry,
                  pluginIds: [pluginId],
                });
              });
            }));
            params.signal?.throwIfAborted();
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
      // A process-local development reload replaces the serving registry
      // without a registry commit; its runtime-only materializations follow
      // it. Identical bodies are deduplicated by the reporter.
      params.reloadController.subscribe(() => reportCurrentAvailability());
      unsubscribeAccountAvailability = subscribePluginAccountAvailabilityChanges((accountScopeKey, pluginIds) => {
        const currentScopeKey = params.accountStorageDependencies?.resolveAccountScopeKey
          ? params.accountStorageDependencies.resolveAccountScopeKey()
          : getActiveAccountSettingsSnapshot()?.scopeKey;
        if (accountScopeKey !== currentScopeKey) return;
        const contributes = params.reloadController.getState().activeRegistry?.contributes;
        const changedPluginIds = pluginIds ?? [...new Set([
          ...Object.keys(contributes?.pluginEnablementById ?? {}),
          ...(contributes?.pluginDeclarations ?? []).map(declaration => declaration.pluginId),
        ])];
        const relevantPluginIds = changedPluginIds.filter(pluginId => contributes?.pluginEnablementById?.[pluginId]
          || contributes?.pluginDeclarations?.some(declaration => declaration.pluginId === pluginId));
        if (relevantPluginIds.length === 0) return;
        void stateStore.refreshRuntime(relevantPluginIds).catch(error => {
          logger.warn('[PLUGIN RUNTIME] Account availability refresh failed', error);
        });
      });
      await reportCurrentAvailability();
      await developmentRoots.initialize();
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
