import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
  createProviderErrorV1,
  qualifiedPurposeKey,
  registerSensitiveDiagnosticValues,
  sameQualifiedConnectedAccountRef,
  type ProviderErrorV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { prepareDirectProviderLaunch } from '@/providers/lifecycle/prepareDirectLaunch';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import {
  ForegroundProfileSecretRecoveryRequiredError,
  readForegroundProfileRequiredSecretNamesMissingBinding,
  resolveForegroundProfileSavedSecretEnvironment,
} from './resolveForegroundProfileSavedSecretEnvironment';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  attachExactRunnerRetainedPluginGenerations,
} from '@/plugins/store/registry/generationCustodyRetirement';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import {
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
  serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { bindAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { prepareForegroundAgentRuntimeBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { logger } from '@/ui/logger';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import {
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import {
  publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
} from './sessionBridgeAuthorization';
import {
  activateConnectedAccountRequestAuthForSpawn,
  resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
  resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
  resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
  type AgentSpawnQualifiedPurposeBindingSnapshot,
} from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  resolveFirstPartyConnectedAccountServiceId,
} from '@/daemon/connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter';
import {
  scopeConnectedAccountSessionPurposeBindingLease,
  type ConnectedAccountPurposeAuthorizationScope,
  type ConnectedAccountPurposeBindingOwner,
  type ConnectedAccountSessionPurposeBindingLease,
  type ConnectedAccountSessionPurposeBindingSnapshot,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
  ConnectedAccountRequestAuthSubjectRegistry,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
  createProviderLaunchResourceScope,
  type ProviderLaunchCleanup,
} from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { ensurePrivateConnectedServiceMaterializedRoot } from '@/daemon/connectedServices/materialize/privateMaterializedRoot';
import { normalizeMaterializationKeyForPath } from '@/daemon/connectedServices/materialize/normalizeMaterializationKeyForPath';
import { createBestEffortCleanupDirectory } from '@/daemon/connectedServices/materialization/materializer';
import { isLegacyServiceKeyedCompatibilityCatalogAgent } from '@/agent/catalog/registry';
import {
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  applyConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceNativeHomeRoot,
} from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { resolveNativeAgentSessionStateSharingPolicy } from '@/agent/runtime/registry/engineRegistry/stateSharingPolicy';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { materializeConnectedServiceNativeHomeCredentials } from '@/daemon/connectedServices/stateSharing/materializeConnectedServiceNativeHomeCredentials';
import { materializeQualifiedConnectedAccountLaunchUses } from '@/daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses';

import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeAdmissionResponseV1,
} from './foregroundAdmissionContract';
import type { PreparedForegroundAgentRuntimeAdmission } from './foregroundAdmission';

function refusal(
  error: ProviderErrorV1,
): Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }> {
  return { ok: false, error };
}

export type PrepareForegroundAgentRuntimeAdmissionDependencies = Readonly<{
  activateSessionPurposeBindings?:
    ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings'];
  /**
   * Host-private qualified-selection bridge for manifest-qualified external Agents. The
   * released service-keyed adapter remains outside this path.
   */
  resolveExternalAgentSessionPurposeBindingSnapshot?: (input: Readonly<{
    agentId: string;
    authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
    signal: AbortSignal;
  }>) => Promise<ConnectedAccountSessionPurposeBindingSnapshot | null>;
  resolveConnectedServiceAuthForSpawn?: (
    input: Omit<Pick<
      Parameters<typeof resolveConnectedServiceAuthForSpawn>[0],
      | 'connectedServicesBindingsRaw'
      | 'materializationKey'
      | 'sessionDirectory'
      | 'sessionId'
      | 'vendorResumeId'
      | 'resumeReachabilityRequired'
      | 'resolveQualifiedPurposeBindingSnapshot'
    >, 'agentId'> & Readonly<{ agentId: string }>,
  ) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;
  resolveDaemonSpawnHooks?: (
    agentId: string,
  ) => Promise<DaemonSpawnHooks | null>;
  connectedAccountRequestAuthRegistry?: Pick<
    ConnectedAccountRequestAuthSubjectRegistry,
    'activate' | 'retire'
  >;
  resolveConnectedAccountRequestAuthHttpPort?: () => number;
  connectedServicesMaterializationBaseDir?: string;
}>;

function mergeForegroundAdmissionEnvironment(input: Readonly<{
  profile: Readonly<Record<string, string>>;
  connectedService: Readonly<Record<string, string>>;
  provider: Readonly<Record<string, string>>;
  connectedServiceUnset: readonly string[];
  providerUnset: readonly string[];
}>): Readonly<{
  environment: Readonly<Record<string, string>>;
  unsetEnvironmentVariableNames: readonly string[];
}> {
  const environment: Record<string, string> = Object.assign(
    Object.create(null),
    input.profile,
    input.connectedService,
  );
  const unsetByIdentity = new Map<string, string>();
  const applyUnset = (name: string) => {
    const identity = name.toLowerCase();
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === identity) delete environment[existingName];
    }
    unsetByIdentity.set(identity, name);
  };
  const applyValue = (name: string, value: string) => {
    const identity = name.toLowerCase();
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === identity) delete environment[existingName];
    }
    unsetByIdentity.delete(identity);
    environment[name] = value;
  };
  for (const name of input.connectedServiceUnset) applyUnset(name);
  for (const [name, value] of Object.entries(input.provider)) {
    applyValue(name, value);
  }
  for (const name of input.providerUnset) applyUnset(name);
  return Object.freeze({
    environment: Object.freeze(environment),
    unsetEnvironmentVariableNames: Object.freeze([
      ...unsetByIdentity.values(),
    ]),
  });
}

export async function resolveForegroundFinalPluginPrerequisites(params: Readonly<{
  happyHomeDir: string;
  pluginRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
  resolvedAgentId: string;
  directory: string;
  backendTarget: ForegroundAgentRuntimeAdmissionOwnerRequestV1['backendTarget'];
  environment: Readonly<Record<string, string>>;
}>): Promise<Awaited<ReturnType<typeof resolveSpawnChildEnvironment>>> {
  return await resolveSpawnChildEnvironment({
    happyHomeDir: params.happyHomeDir,
    pluginRuntimeRegistry: params.pluginRuntimeRegistry,
    resolvedAgentId: params.resolvedAgentId,
    options: {
      directory: params.directory,
      backendTarget: params.backendTarget,
    },
    profileEnvironmentVariables: { ...params.environment },
    daemonSpawnHooks: null,
    processEnv: process.env,
    logDebug: (message) => logger.debug(message),
    logInfo: (message) => logger.info(message),
    logWarn: (message) => logger.warn(message),
    connectedServiceAuth: null,
    providerBindingPrerequisitesOnly: true,
  });
}

function hasCompleteConnectedServiceProjection(
  connectedServices: NonNullable<
    ForegroundAgentRuntimeAdmissionOwnerRequestV1['connectedServices']
  >,
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot,
): boolean {
  const projectedConnectedServiceIds = new Set<string>(
    snapshot.bindings.flatMap((binding) => {
      const service = binding.target.kind === 'account'
        ? binding.target.account.service
        : binding.target.service;
      const serviceId = resolveFirstPartyConnectedAccountServiceId(service);
      return serviceId ? [serviceId] : [];
    }),
  );
  return Object.entries(connectedServices.bindingsByServiceId).every(
    ([serviceId, binding]) =>
      binding.source !== 'connected'
      || projectedConnectedServiceIds.has(serviceId),
  );
}

function hasExactQualifiedPurposeSnapshot(
  snapshot: ConnectedAccountSessionPurposeBindingSnapshot,
  authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[],
): boolean {
  const scopesByPurposeKey = new Map(
    authorizedPurposes.map((scope) => [
      qualifiedPurposeKey(scope.purpose),
      scope,
    ]),
  );
  if (scopesByPurposeKey.size !== authorizedPurposes.length) return false;
  const snapshotPurposeKeys = new Set<string>();
  for (const purpose of snapshot.purposes) {
    const key = qualifiedPurposeKey(purpose);
    if (!scopesByPurposeKey.has(key) || snapshotPurposeKeys.has(key)) {
      return false;
    }
    snapshotPurposeKeys.add(key);
  }
  if (snapshotPurposeKeys.size !== scopesByPurposeKey.size) return false;
  const boundPurposeKeys = new Set<string>();
  for (const binding of snapshot.bindings) {
    const key = qualifiedPurposeKey(binding.purpose);
    const scope = scopesByPurposeKey.get(key);
    const service = binding.target.kind === 'account'
      ? binding.target.account.service
      : binding.target.service;
    if (
      !scope
      || !snapshotPurposeKeys.has(key)
      || boundPurposeKeys.has(key)
      || !scope.serviceRefs.some((candidate) => (
        candidate.pluginId === service.pluginId
        && candidate.localId === service.localId
      ))
    ) {
      return false;
    }
    boundPurposeKeys.add(key);
  }
  return true;
}

async function prepareForegroundProviderLaunch(input: Readonly<{
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1;
  lease: Awaited<ReturnType<
    typeof acquireAuthoritativePluginRuntimeRegistryLease
  >>;
}>): Promise<Awaited<ReturnType<typeof prepareDirectProviderLaunch>> | null> {
  const { request, lease } = input;
  // Only an explicitly native request without a prior Provider binding may
  // bypass the canonical launch owner. An orphaned binding must reach
  // `prepareProviderLaunch`, which owns the typed continuity refusal before
  // any foreground bootstrap side effect is created.
  if (!request.selection && !request.previousBinding) return null;
  const featureEnabled = (
    await resolveCliFeatureDecisionForServer({
      featureId: 'providers',
      env: process.env,
      serverUrl: configuration.serverUrl,
      timeoutMs: 1_500,
    })
  ).decision.state === 'enabled';
  return await prepareDirectProviderLaunch({
    selection: request.selection,
    backendTarget: request.backendTarget,
    machineId: request.machineId,
    agentId: request.agentId,
    sessionId: request.sessionId,
    previousBinding: request.previousBinding ?? null,
    confirmation: null,
    connectedServices: request.connectedServices ?? null,
    featureEnabled,
  }, {
    resolvePrerequisites: async (providerBindingContext) => {
      const result = await resolveSpawnChildEnvironment({
        happyHomeDir: configuration.happyHomeDir,
        pluginRuntimeRegistry: lease.registry,
        resolvedAgentId: request.agentId,
        options: {
          directory: request.directory,
          backendTarget: request.backendTarget,
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: process.env,
        logDebug: (message) => logger.debug(message),
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        connectedServiceAuth: null,
        providerBindingContext: {
          v: 1,
          ...providerBindingContext,
        },
        providerBindingPrerequisitesOnly: true,
      });
      return result.ok
        ? {
            ok: true as const,
            cleanupOnFailure: result.cleanupOnFailure,
            cleanupOnExit: result.cleanupOnExit,
          }
        : {
            ok: false as const,
            error: createProviderErrorV1(
              'provider_agent_runtime_unsupported',
              {
                connectionId: providerBindingContext.connectionId,
                machineId: request.machineId,
              },
            ),
            cleanupOnFailure: result.cleanupOnFailure,
            cleanupOnExit: result.cleanupOnExit,
          };
    },
    createAuthorizationAttempt: async ({
      selection,
      machineId,
      agentTargetKey,
      agentId,
    }) => createRuntimeProviderSpawnAuthorizationAttempt({
      selection,
      machineId,
      agentTargetKey,
      agentId,
      lease,
      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
      subscribeAccountSettingsSnapshot: (listener) =>
        subscribeActiveAccountSettingsSnapshot(() => listener()),
      runtimeStateStore: createProviderRuntimeStateStore({
        happyHomeDir: configuration.happyHomeDir,
        machineId,
      }),
      materializationBaseDir: join(
        configuration.happyHomeDir,
        'providers',
        'materialized',
      ),
      sessionId: request.sessionId,
    }),
  });
}

export async function prepareForegroundAgentRuntimeAdmission(
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  dependencies: PrepareForegroundAgentRuntimeAdmissionDependencies = {},
): Promise<
  | Readonly<{ ok: true; prepared: PreparedForegroundAgentRuntimeAdmission }>
  | Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>
> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: configuration.happyHomeDir,
  });
  let transferred = false;
  let cleanupPromise: Promise<void> | null = null;
  let providerCleanup: (() => void | Promise<void>) | null = null;
  let transferProviderLaunchMaterializationCleanupOwnership:
    (() => void) | null = null;
  let profileRedactionCleanup: (() => void) | null = null;
  let tokenCleanup: (() => Promise<void>) | null = null;
  let publishedAuthority: Readonly<{
    path: string;
    capabilityDigest: string;
  }> | null = null;
  let sessionPurposeBindingLease:
    ConnectedAccountSessionPurposeBindingLease | null = null;
  let connectedAccountLaunchCurrent = true;
  let connectedAccountLaunchCommitted = false;
  const connectedServiceLaunchScope = createProviderLaunchResourceScope({
    onCleanupError: (message) => {
      logger.warn(
        '[foreground admission] Connected-service cleanup failed',
        { error: message },
      );
    },
  });
  let connectedServiceCleanupOnExit: ProviderLaunchCleanup | null = null;
  let connectedServiceEnvironment: Readonly<Record<string, string>> =
    Object.freeze({});
  let connectedServiceUnsetEnvironmentVariableNames: readonly string[] =
    Object.freeze([]);
  let requestAuthMaterializedRoot: string | null = null;
  let connectedServiceRedactionLease:
    ReturnType<typeof createProviderRedactionLease> | null = null;
  let runnerManagedDependencyRetentionReservation:
    Awaited<ReturnType<NonNullable<
      typeof lease.registry.reserveManagedDependencyRetention
    >>> | null = null;
  const cleanup = async () => {
    if (cleanupPromise) return await cleanupPromise;
    cleanupPromise = (async () => {
      let firstError: unknown = null;
      for (const release of [
        providerCleanup,
        profileRedactionCleanup,
        connectedServiceCleanupOnExit
          ?? (() => connectedServiceLaunchScope.release()),
        sessionPurposeBindingLease
          ? () => {
              sessionPurposeBindingLease?.dispose();
              sessionPurposeBindingLease = null;
            }
          : null,
        runnerManagedDependencyRetentionReservation
          ? () => {
              runnerManagedDependencyRetentionReservation
                ?.release();
              runnerManagedDependencyRetentionReservation =
                null;
            }
          : null,
        publishedAuthority
          ? async () => {
              await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
                happyHomeDir: configuration.happyHomeDir,
                publicReleaseRing: configuration.publicReleaseRing,
                path: publishedAuthority!.path,
                capabilityDigest:
                  publishedAuthority!.capabilityDigest,
              });
            }
          : null,
        tokenCleanup,
        lease.release,
      ]) {
        if (!release) continue;
        try {
          await release();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    })();
    await cleanupPromise;
  };

  try {
    // The Provider decision runs before any runner bootstrap material is
    // written. Cleanup removes those files, but it cannot un-activate an Agent
    // runtime contribution, so every Provider refusal this owner can already
    // establish is established first.
    const providerLaunch = await prepareForegroundProviderLaunch({
      request,
      lease,
    });
    if (providerLaunch && !providerLaunch.ok) {
      return refusal(providerLaunch.error);
    }
    if (providerLaunch?.ok && providerLaunch.kind !== 'provider') {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        {
          connectionId:
            request.selection?.ref.providerConnectionId ?? undefined,
          machineId: request.machineId,
        },
      ));
    }
    const activeProviderLaunch =
      providerLaunch?.ok && providerLaunch.kind === 'provider'
        ? providerLaunch
        : null;
    if (activeProviderLaunch) {
      providerCleanup = activeProviderLaunch.cleanupOnExit;
      transferProviderLaunchMaterializationCleanupOwnership =
        activeProviderLaunch.transferLaunchMaterializationCleanupOwnership;
    }
    const bridge = await prepareForegroundAgentRuntimeBootstrapForLease({
      target: request.backendTarget,
      lease,
    });
    if (
      !bridge
      || bridge.authorization.descriptor.agentId !== request.agentId
      || bridge.authorization.descriptor.backendId
        !== request.backendTarget.backendId
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        request.selection
          ? {
              connectionId:
                request.selection.ref.providerConnectionId ?? undefined,
              machineId: request.machineId,
            }
          : { machineId: request.machineId },
      ));
    }
    tokenCleanup = bridge.cleanupBootstrapFiles;
    const registration = lease.registry.agentRuntimesByAgentId.get(
      request.agentId,
    );
    if (
      !registration?.hasPrimaryRuntime
      || registration.pluginId !== bridge.authorization.descriptor.pluginId
      || registration.generation !== bridge.authorization.descriptor.generation
      || !registration.isCurrent()
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: request.machineId },
      ));
    }
    const requirements = readLeasedAgentProviderRequirements({
      lease,
      agentId: request.agentId,
    });
    const providerEnvironment: Readonly<Record<string, string>> =
      activeProviderLaunch
        ? Object.freeze({
            ...activeProviderLaunch.environment,
            [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
              serializeProviderBindingLaunchHandoffForEnv(
                activeProviderLaunch.launchMaterialization,
                activeProviderLaunch.bindingMetadata,
              ),
          })
        : Object.freeze({});
    const providerUnsetEnvironmentVariableNames =
      activeProviderLaunch?.unsetEnvKeys ?? Object.freeze([]);
    const effectiveConnectedServices =
      activeProviderLaunch
        ? activeProviderLaunch.connectedServices
        : request.connectedServices ?? null;
    const legacyConnectedServiceCatalogAgent =
      isLegacyServiceKeyedCompatibilityCatalogAgent(
        lease.registry.contributes.catalogEntriesById[request.agentId],
      );
    const externalPurposeDeclarations = !legacyConnectedServiceCatalogAgent
      ? resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
          agentId: request.agentId,
          contributions: lease.registry.contributes,
        })
      : null;
    let sessionPurposeBindingSnapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null =
      legacyConnectedServiceCatalogAgent && effectiveConnectedServices
      ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId: request.agentId,
          bindings: effectiveConnectedServices,
          contributions: lease.registry.contributes,
        })
      : null;
    if (!legacyConnectedServiceCatalogAgent && effectiveConnectedServices) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: request.machineId },
      ));
    }
    if (externalPurposeDeclarations?.authorizedPurposes.length) {
      if (
        !dependencies.activateSessionPurposeBindings
        || !dependencies.resolveExternalAgentSessionPurposeBindingSnapshot
      ) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      const externalSnapshot =
        await dependencies.resolveExternalAgentSessionPurposeBindingSnapshot({
          agentId: request.agentId,
          authorizedPurposes:
            externalPurposeDeclarations.authorizedPurposes,
          signal: registration.retirementSignal,
        });
      if (
        registration.retirementSignal.aborted
        || !registration.isCurrent()
        || !externalSnapshot
        || !hasExactQualifiedPurposeSnapshot(
          externalSnapshot,
          externalPurposeDeclarations.authorizedPurposes,
        )
      ) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      sessionPurposeBindingSnapshot = Object.freeze({
        purposes: externalSnapshot.purposes,
        bindings: externalSnapshot.bindings,
        authorizedPurposes:
          externalPurposeDeclarations.authorizedPurposes,
        fileMaterializationPurposes:
          externalPurposeDeclarations.fileMaterializationPurposes,
        ...(externalPurposeDeclarations.requestAuthUses
          ? { requestAuthUses: externalPurposeDeclarations.requestAuthUses }
          : {}),
        ...(externalPurposeDeclarations.fileEnvironmentUses
          ? { fileEnvironmentUses: externalPurposeDeclarations.fileEnvironmentUses }
          : {}),
        ...(externalPurposeDeclarations.environmentUses
          ? { environmentUses: externalPurposeDeclarations.environmentUses }
          : {}),
      });
    }
    if (
      legacyConnectedServiceCatalogAgent
      && effectiveConnectedServices
      && (
        !sessionPurposeBindingSnapshot
        || !hasCompleteConnectedServiceProjection(
          effectiveConnectedServices,
          sessionPurposeBindingSnapshot,
        )
        || !dependencies.activateSessionPurposeBindings
        || !dependencies.resolveConnectedServiceAuthForSpawn
        || !dependencies.resolveDaemonSpawnHooks
      )
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: request.machineId },
      ));
    }
    if (legacyConnectedServiceCatalogAgent && effectiveConnectedServices) {
      connectedServiceRedactionLease = createProviderRedactionLease({
        values: [],
      });
      connectedServiceLaunchScope.register(
        connectedServiceRedactionLease.close,
      );
      connectedServiceLaunchScope.setSanitizer(
        connectedServiceRedactionLease.redact,
      );
      const connectedServiceAuth =
        await dependencies.resolveConnectedServiceAuthForSpawn!({
          agentId: request.agentId,
          connectedServicesBindingsRaw: effectiveConnectedServices,
          materializationKey: request.sessionId,
          sessionDirectory: request.directory,
          sessionId: request.existingSessionId,
          vendorResumeId: request.vendorResumeId ?? null,
          resumeReachabilityRequired: Boolean(request.vendorResumeId),
          resolveQualifiedPurposeBindingSnapshot: (bindings) =>
            resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
              agentId: request.agentId,
              bindings,
              contributions: lease.registry.contributes,
            }),
        });
      const daemonSpawnHooks =
        await dependencies.resolveDaemonSpawnHooks!(request.agentId);
      const childEnvironment = await resolveSpawnChildEnvironment({
        happyHomeDir: configuration.happyHomeDir,
        pluginRuntimeRegistry: lease.registry,
        resolvedAgentId: request.agentId,
        options: {
          directory: request.directory,
          backendTarget: request.backendTarget,
          connectedServices:
            connectedServiceAuth?.connectedServicesBindings
            ?? effectiveConnectedServices,
          ...(request.vendorResumeId
            ? {
                existingSessionId: request.sessionId,
                resume: request.vendorResumeId,
              }
            : {}),
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks,
        processEnv: process.env,
        logDebug: (message) => logger.debug(message),
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        connectedServiceAuth,
      });
      connectedServiceLaunchScope.register({
        onFailure: childEnvironment.cleanupOnFailure ?? (() => {}),
        onExit: childEnvironment.cleanupOnExit ?? (() => {}),
      });
      if (!childEnvironment.ok) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      connectedServiceEnvironment = Object.freeze({
        ...childEnvironment.extraEnvForChild,
      });
      connectedServiceUnsetEnvironmentVariableNames = Object.freeze([
        ...(childEnvironment.unsetEnvKeys ?? []),
      ]);
      if (
        connectedServiceAuth?.ongoingRuntimeRegistrationAllowed === false
      ) {
        sessionPurposeBindingSnapshot = null;
      } else if (
        connectedServiceAuth
        && !connectedServiceAuth.qualifiedPurposeBindingSnapshot
      ) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      if (
        connectedServiceAuth?.ongoingRuntimeRegistrationAllowed !== false
        && connectedServiceAuth?.qualifiedPurposeBindingSnapshot
      ) {
        sessionPurposeBindingSnapshot =
          connectedServiceAuth.qualifiedPurposeBindingSnapshot;
        if (!hasCompleteConnectedServiceProjection(
          connectedServiceAuth.connectedServicesBindings,
          sessionPurposeBindingSnapshot,
        )) {
          return refusal(createProviderErrorV1(
            'provider_agent_runtime_unsupported',
            { machineId: request.machineId },
          ));
        }
      }
      if (connectedServiceAuth?.requestAuthPurposeBindings?.length) {
        if (
          !sessionPurposeBindingSnapshot?.requestAuthUses?.length
          || !connectedServiceAuth.requestAuthMaterializedRoot
          || !dependencies.connectedAccountRequestAuthRegistry
          || !dependencies.resolveConnectedAccountRequestAuthHttpPort
        ) {
          return refusal(createProviderErrorV1(
            'provider_agent_runtime_unsupported',
            { machineId: request.machineId },
          ));
        }
        requestAuthMaterializedRoot =
          connectedServiceAuth.requestAuthMaterializedRoot;
      }
    }
    if (
      !legacyConnectedServiceCatalogAgent
      && resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
        sessionPurposeBindingSnapshot,
      ).length > 0
    ) {
      if (
        !dependencies.connectedServicesMaterializationBaseDir
        || !dependencies.connectedAccountRequestAuthRegistry
        || !dependencies.resolveConnectedAccountRequestAuthHttpPort
      ) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      connectedServiceRedactionLease = createProviderRedactionLease({
        values: [],
      });
      connectedServiceLaunchScope.register(
        connectedServiceRedactionLease.close,
      );
      connectedServiceLaunchScope.setSanitizer(
        connectedServiceRedactionLease.redact,
      );
      const materializationSessionRoot = join(
        dependencies.connectedServicesMaterializationBaseDir,
        normalizeMaterializationKeyForPath(request.sessionId),
      );
      requestAuthMaterializedRoot = join(
        materializationSessionRoot,
        'qualified-request-auth',
      );
      await ensurePrivateConnectedServiceMaterializedRoot(
        requestAuthMaterializedRoot,
      );
      connectedServiceLaunchScope.register(
        createBestEffortCleanupDirectory(materializationSessionRoot),
      );
      connectedServiceEnvironment = Object.freeze({
        ...connectedServiceEnvironment,
        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
          resolveConnectedAccountRequestAuthCapabilityPath(
            requestAuthMaterializedRoot,
          ),
      });
    }
    let ownsConnectedServiceLaunchScope = Boolean(
      effectiveConnectedServices || requestAuthMaterializedRoot,
    );
    const readExactProfileSnapshot = () => {
      if (!request.profileId) return null;
      const settingsSnapshot = getActiveAccountSettingsSnapshot();
      if (
        !settingsSnapshot
        || typeof settingsSnapshot.scopeKey !== 'string'
        || settingsSnapshot.scopeKey.length === 0
        || settingsSnapshot.scopeKey !== request.accountSettingsScopeKey
        || settingsSnapshot.settingsVersion !== request.accountSettingsVersion
      ) {
        return null;
      }
      const profile = readProfilesFromAccountSettings(
        settingsSnapshot.settings,
      ).visibleProfiles.find(
        (candidate) => candidate.id === request.profileId,
      );
      return profile
        ? Object.freeze({ settingsSnapshot, profile })
        : null;
    };
    const initialExactProfileSnapshot = readExactProfileSnapshot();
    if (request.profileId && !initialExactProfileSnapshot) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        {
          machineId: request.machineId,
          sourceProfileId: request.profileId,
        },
      ));
    }
    const stateSharingCatalogEntry = lease.registry.acquireAgentCatalogEntry
      ? await lease.registry.acquireAgentCatalogEntry(request.agentId)
      : lease.registry.contributes.catalogEntriesById[request.agentId] ?? null;
    const stateSharingDescriptor = await stateSharingCatalogEntry
      ?.getConnectedServiceStateSharingDescriptor?.();

    transferred = true;
    return {
      ok: true,
      prepared: {
        authorization: bridge.authorization,
        reservedEnvironmentVariableNames:
          requirements?.authIsolation.ownedEnvKeys ?? [],
        profileSecretRequirementNamesMissingBinding:
          initialExactProfileSnapshot
            ? readForegroundProfileRequiredSecretNamesMissingBinding({
                profile: initialExactProfileSnapshot.profile,
                accountSettings:
                  initialExactProfileSnapshot.settingsSnapshot.settings,
              })
            : Object.freeze([]),
        ...(stateSharingDescriptor?.providerSupportStatus === 'supported'
          && stateSharingDescriptor.nativeHome
          ? {
              nativeHomeSourceEnvironmentKey:
                stateSharingDescriptor.nativeHome.environmentKey,
            }
          : {}),
        retirementSignal: registration.retirementSignal,
        isCurrent: () => (
          registration.isCurrent() && connectedAccountLaunchCurrent
        ),
        claim: async ({
          canonicalSessionId,
          httpPort,
          foregroundSatisfiedProfileSecretRequirementNames,
          nativeHomeSourceEnvironmentValue,
        }) => {
          let connectedServiceClaimSucceeded = false;
          try {
            if (activeProviderLaunch) {
              const current =
                await activeProviderLaunch.revalidateBeforeCommit();
              if (!current.ok) {
                return { ok: false as const, error: current.error };
              }
            }

            let savedProfileEnvironment: Readonly<Record<string, string>> =
              Object.freeze({});
            let sensitiveEnvironmentVariableNames: readonly string[] =
              Object.freeze([]);
            if (request.profileId) {
              const exactProfileSnapshot = readExactProfileSnapshot();
              if (!exactProfileSnapshot) {
                return {
                  ok: false as const,
                  error: createProviderErrorV1(
                    'provider_authorization_changed',
                    {
                      connectionId:
                        request.selection?.ref.providerConnectionId
                        ?? undefined,
                      machineId: request.machineId,
                      sourceProfileId: request.profileId,
                    },
                  ),
                };
              }
              savedProfileEnvironment =
                resolveForegroundProfileSavedSecretEnvironment({
                  profile: exactProfileSnapshot.profile,
                  accountSettings:
                    exactProfileSnapshot.settingsSnapshot.settings,
                  settingsSecretsReadKeys:
                    exactProfileSnapshot.settingsSnapshot
                      .settingsSecretsReadKeys,
                  foregroundSatisfiedSecretRequirementNames:
                    foregroundSatisfiedProfileSecretRequirementNames,
                });
              profileRedactionCleanup =
                registerSensitiveDiagnosticValues(
                  Object.values(savedProfileEnvironment),
                ).close;
              sensitiveEnvironmentVariableNames = Object.freeze([
                ...new Set([
                  ...Object.keys(savedProfileEnvironment),
                  ...foregroundSatisfiedProfileSecretRequirementNames,
                ]),
              ]);
            }

            if (sessionPurposeBindingSnapshot) {
              sessionPurposeBindingLease =
                dependencies.activateSessionPurposeBindings!({
                  sessionId: canonicalSessionId,
                  purposes: sessionPurposeBindingSnapshot.purposes,
                  bindings: sessionPurposeBindingSnapshot.bindings,
                });
            }
            const expectedConnectedAccountByPurposeKey =
              new Map<string, QualifiedConnectedAccountRef>();
            const connectedAccountsOwner =
              lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
            const assertExpectedConnectedAccountsCurrent = async (): Promise<void> => {
              if (!connectedAccountLaunchCurrent) {
                throw new Error(
                  'Foreground Connected Account binding changed during preparation',
                );
              }
              if (
                !sessionPurposeBindingSnapshot?.authorizedPurposes?.length
                || expectedConnectedAccountByPurposeKey.size === 0
              ) return;
              if (!connectedAccountsOwner) {
                throw new Error(
                  'Foreground Connected Account invalidation authority is unavailable',
                );
              }
              for (const authorized of sessionPurposeBindingSnapshot.authorizedPurposes) {
                const expectedAccount = expectedConnectedAccountByPurposeKey.get(
                  qualifiedPurposeKey(authorized.purpose),
                );
                if (!expectedAccount) continue;
                const currentBinding = await connectedAccountsOwner.getBinding({
                  purpose: authorized.purpose,
                  serviceRefs: authorized.serviceRefs,
                  signal: registration.retirementSignal,
                });
                if (
                  !currentBinding
                  || !sameQualifiedConnectedAccountRef(
                    expectedAccount,
                    currentBinding.account,
                  )
                ) {
                  throw new Error(
                    'Foreground Connected Account binding changed during preparation',
                  );
                }
              }
            };
            if (
              sessionPurposeBindingLease
              && sessionPurposeBindingSnapshot?.authorizedPurposes?.length
            ) {
              for (const authorized of sessionPurposeBindingSnapshot.authorizedPurposes) {
                if (!sessionPurposeBindingLease.resolvePurposeBinding(authorized.purpose)) continue;
                if (!connectedAccountsOwner) {
                  throw new Error(
                    'Foreground Connected Account invalidation authority is unavailable',
                  );
                }
                const [exactBinding, currentBinding] = await Promise.all([
                  connectedAccountsOwner.getBinding({
                    purpose: authorized.purpose,
                    serviceRefs: authorized.serviceRefs,
                    exactPurposeBindingSubjectId:
                      sessionPurposeBindingLease.subjectId,
                    sessionId: canonicalSessionId,
                    signal: registration.retirementSignal,
                  }),
                  connectedAccountsOwner.getBinding({
                    purpose: authorized.purpose,
                    serviceRefs: authorized.serviceRefs,
                    signal: registration.retirementSignal,
                  }),
                ]);
                if (
                  !exactBinding
                  || !currentBinding
                  || !sameQualifiedConnectedAccountRef(
                    exactBinding.account,
                    currentBinding.account,
                  )
                ) {
                  throw new Error(
                    'Foreground Connected Account binding changed before materialization',
                  );
                }
                expectedConnectedAccountByPurposeKey.set(
                  qualifiedPurposeKey(authorized.purpose),
                  Object.freeze({
                    service: Object.freeze({ ...exactBinding.account.service }),
                    accountId: exactBinding.account.accountId,
                  }),
                );
              }
            }
            if (
              sessionPurposeBindingLease
              && sessionPurposeBindingSnapshot?.authorizedPurposes?.length
            ) {
              for (const authorized of sessionPurposeBindingSnapshot.authorizedPurposes) {
                if (!sessionPurposeBindingLease.resolvePurposeBinding(authorized.purpose)) continue;
                if (!connectedAccountsOwner) {
                  throw new Error(
                    'Foreground Connected Account invalidation authority is unavailable',
                  );
                }
                const subscription = connectedAccountsOwner.watch({
                  purpose: authorized.purpose,
                  serviceRefs: authorized.serviceRefs,
                  exactPurposeBindingSubjectId:
                    sessionPurposeBindingLease.subjectId,
                  sessionId: canonicalSessionId,
                  async listener() {
                    connectedAccountLaunchCurrent = false;
                    if (connectedAccountLaunchCommitted) {
                      void connectedServiceLaunchScope.retire().catch((error) => {
                        logger.warn(
                          '[foreground admission] Connected Account invalidation cleanup failed',
                          { error: connectedServiceLaunchScope.sanitize(error) },
                        );
                      });
                    }
                  },
                });
                connectedServiceLaunchScope.register({
                  onFailure: () => subscription.dispose(),
                  onExit: () => subscription.dispose(),
                });
                ownsConnectedServiceLaunchScope = true;
              }
            }
            if (
              sessionPurposeBindingSnapshot
              && sessionPurposeBindingLease
              && (
                (sessionPurposeBindingSnapshot.environmentUses?.length ?? 0) > 0
                || (sessionPurposeBindingSnapshot.fileEnvironmentUses?.length ?? 0) > 0
              )
            ) {
              if (!connectedAccountsOwner) {
                throw new Error(
                  'Foreground Connected Account launch authority is unavailable',
                );
              }
              const launchEnvironment =
                await materializeQualifiedConnectedAccountLaunchUses({
                  connectedAccountsOwner,
                  credentialFileOwner:
                    lease.registry.resolveManagedServiceCredentialFileOwner?.(),
                  snapshot: sessionPurposeBindingSnapshot,
                  exactPurposeBindingSubjectId:
                    sessionPurposeBindingLease.subjectId,
                  sessionId: canonicalSessionId,
                  signal: registration.retirementSignal,
                  isPurposeBound: (purpose) => (
                    sessionPurposeBindingLease?.resolvePurposeBinding(purpose) !== null
                  ),
                  expectedAccountsByPurposeKey:
                    expectedConnectedAccountByPurposeKey,
                  credentialFileScope: Object.freeze({
                    generation: registration.generation,
                    pluginId: registration.pluginId,
                    contributionQualifiedId:
                      `${registration.pluginId}/agents/${registration.localAgentId}`,
                    sessionId: canonicalSessionId,
                  }),
                  retainCredentialFileCleanup(cleanup) {
                    connectedServiceLaunchScope.register({
                      onFailure: () => cleanup.dispose(),
                      onExit: () => cleanup.dispose(),
                    });
                  },
                });
              if (Object.keys(launchEnvironment).length > 0) {
                const redaction = registerSensitiveDiagnosticValues(
                  Object.values(launchEnvironment),
                );
                connectedServiceLaunchScope.register({
                  onFailure: () => redaction.close(),
                  onExit: () => redaction.close(),
                });
                connectedServiceEnvironment = Object.freeze({
                  ...connectedServiceEnvironment,
                  ...launchEnvironment,
                });
                sensitiveEnvironmentVariableNames = Object.freeze([
                  ...new Set([
                    ...sensitiveEnvironmentVariableNames,
                    ...Object.keys(launchEnvironment),
                  ]),
                ]);
                ownsConnectedServiceLaunchScope = true;
              }
            }
            const existingMaterializedRoot =
              connectedServiceEnvironment[
                HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY
              ];
            const boundNativeHomeFilePurposes = sessionPurposeBindingLease
              ? (sessionPurposeBindingSnapshot?.fileMaterializationPurposes ?? [])
                  .filter((scope) => (
                    sessionPurposeBindingLease?.resolvePurposeBinding(scope.purpose) !== null
                  ))
              : [];
            if (
              stateSharingDescriptor?.providerSupportStatus === 'supported'
              && stateSharingDescriptor.nativeHome
              && (
                Boolean(existingMaterializedRoot)
                || boundNativeHomeFilePurposes.length > 0
                || Boolean(activeProviderLaunch)
              )
            ) {
              if (
                !existingMaterializedRoot
                && !dependencies.connectedServicesMaterializationBaseDir
              ) {
                throw new Error(
                  'Foreground Connected Account state-sharing root authority is unavailable',
                );
              }
              const targetRoot = existingMaterializedRoot
                ?? resolveConnectedServiceMaterializedRootDir({
                  baseDir: dependencies.connectedServicesMaterializationBaseDir!,
                  agentId: request.agentId,
                  materializationKey: request.sessionId,
                });
              await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);
              if (!existingMaterializedRoot) {
                connectedServiceLaunchScope.register(async () => {
                  await rm(targetRoot, { recursive: true, force: true });
                });
              }
              let stateSharingEnvironment: Readonly<Record<string, string>> =
                Object.freeze({});
              if (!existingMaterializedRoot) {
                const policy = resolveNativeAgentSessionStateSharingPolicy(
                  request.agentId,
                );
                const nativeSourceEnvironment = Object.fromEntries(
                  Object.entries({
                    ...process.env,
                    ...savedProfileEnvironment,
                    ...(typeof nativeHomeSourceEnvironmentValue !== 'string'
                      ? {}
                      : {
                          [stateSharingDescriptor.nativeHome.environmentKey]:
                            nativeHomeSourceEnvironmentValue,
                        }),
                  }).filter((entry): entry is [string, string] => (
                    typeof entry[1] === 'string'
                  )),
                );
                if (nativeHomeSourceEnvironmentValue === null) {
                  delete nativeSourceEnvironment[
                    stateSharingDescriptor.nativeHome.environmentKey
                  ];
                }
                Object.freeze(nativeSourceEnvironment);
                stateSharingEnvironment = (
                  await applyConnectedServiceStateSharingDescriptor({
                    descriptor: stateSharingDescriptor,
                    nativeSourceContext: {
                      sourceRoot: resolveConnectedServiceNativeHomeRoot({
                        nativeHome: stateSharingDescriptor.nativeHome,
                        sourceEnvironment: nativeSourceEnvironment,
                        homeDir: homedir(),
                      }),
                      sourceEnv: nativeSourceEnvironment,
                    },
                    target: {
                      targetMaterializedRoot: targetRoot,
                      targetMaterializedEnv: {},
                    },
                    configMode: policy.configMode,
                    requestedStateMode: policy.stateMode,
                    effectiveStateMode: policy.stateMode,
                    cwd: request.directory,
                    providerLabel: request.agentId,
                  })
                ).envOverrides;
              }
              connectedServiceEnvironment = Object.freeze({
                ...connectedServiceEnvironment,
                ...stateSharingEnvironment,
                [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: targetRoot,
                [stateSharingDescriptor.nativeHome.environmentKey]: targetRoot,
              });
              const boundFilePurposes = existingMaterializedRoot
                ? []
                : boundNativeHomeFilePurposes;
              if (boundFilePurposes.length > 0) {
                const connectedAccountsOwner =
                  lease.registry.resolveConnectedAccountPurposeBindingOwner?.();
                if (!sessionPurposeBindingLease || !connectedAccountsOwner) {
                  throw new Error(
                    'Foreground Connected Account native-home credential authority is unavailable',
                  );
                }
                const files = Object.create(null) as Record<string, Uint8Array>;
                for (const scope of boundFilePurposes) {
                  const expectedAccount = expectedConnectedAccountByPurposeKey.get(
                    qualifiedPurposeKey(scope.purpose),
                  );
                  if (!expectedAccount) {
                    throw new Error(
                      'Foreground Connected Account expected account is unavailable',
                    );
                  }
                  const materialization = await connectedAccountsOwner.materialize({
                    purpose: scope.purpose,
                    serviceRefs: scope.serviceRefs,
                    exactPurposeBindingSubjectId: sessionPurposeBindingLease.subjectId,
                    sessionId: canonicalSessionId,
                    expectedAccount,
                    request: Object.freeze({
                      kind: 'files' as const,
                      fileIds: Object.freeze([
                        ...stateSharingDescriptor.authIsolation.secretEntries,
                      ]),
                    }),
                    signal: registration.retirementSignal,
                  });
                  if (materialization.kind !== 'files') {
                    throw new Error(
                      'Connected Account native-home credential returned the wrong materialization kind',
                    );
                  }
                  for (const [fileId, contents] of Object.entries(materialization.files)) {
                    if (Object.prototype.hasOwnProperty.call(files, fileId)) {
                      throw new Error(
                        `Connected Account native-home credential '${fileId}' has multiple owners`,
                      );
                    }
                    files[fileId] = contents;
                  }
                }
                if (Object.keys(files).length > 0) {
                  await materializeConnectedServiceNativeHomeCredentials({
                    targetRoot,
                    declaredSecretEntries:
                      stateSharingDescriptor.authIsolation.secretEntries,
                    files: Object.freeze(files),
                  });
                }
              }
              ownsConnectedServiceLaunchScope = true;
            }

            const mergedEnvironment = mergeForegroundAdmissionEnvironment({
              profile: savedProfileEnvironment,
              connectedService: connectedServiceEnvironment,
              provider: providerEnvironment,
              connectedServiceUnset:
                connectedServiceUnsetEnvironmentVariableNames,
              providerUnset: providerUnsetEnvironmentVariableNames,
            });
            const finalSpawnEnvironment = await resolveForegroundFinalPluginPrerequisites({
              happyHomeDir: configuration.happyHomeDir,
              pluginRuntimeRegistry: lease.registry,
              resolvedAgentId: request.agentId,
              directory: request.directory,
              backendTarget: request.backendTarget,
              environment: {
                ...mergedEnvironment.environment,
              },
            });
            if (
              finalSpawnEnvironment.cleanupOnFailure
              || finalSpawnEnvironment.cleanupOnExit
            ) {
              connectedServiceLaunchScope.register({
                onFailure:
                  finalSpawnEnvironment.cleanupOnFailure ?? (() => {}),
                onExit: finalSpawnEnvironment.cleanupOnExit ?? (() => {}),
              });
              ownsConnectedServiceLaunchScope = true;
            }
            if (!finalSpawnEnvironment.ok) {
              return {
                ok: false as const,
                error: createProviderErrorV1(
                  'provider_agent_runtime_unsupported',
                  {
                    connectionId:
                      request.selection?.ref.providerConnectionId
                      ?? undefined,
                    machineId: request.machineId,
                  },
                ),
              };
            }

            const currentIdentity =
              await readProcessIdentityByPid(request.foregroundPid);
            const processStartTimeMs =
              currentIdentity?.processStartTimeMs;
            const snapshot = currentIdentity
              ? resolveSessionRunnerEntrypointIdentityFromProcessCommand(
                  currentIdentity.command,
                )
              : null;
            if (
              !canonicalSessionId.trim()
              || !Number.isInteger(httpPort)
              || httpPort <= 0
              || !currentIdentity
              || currentIdentity.pid !== request.foregroundPid
              || typeof processStartTimeMs !== 'number'
              || snapshot?.status !== 'known'
              || registration.retirementSignal.aborted
              || !registration.isCurrent()
              || !connectedAccountLaunchCurrent
              || registration.pluginId
                !== bridge.authorization.descriptor.pluginId
              || registration.generation
                !== bridge.authorization.descriptor.generation
            ) {
              throw new Error(
                'Foreground Agent runtime process authority is unavailable',
              );
            }
            const runner = Object.freeze({
              pid: request.foregroundPid,
              processStartTimeMs,
              processCommandHash:
                hashProcessCommand(currentIdentity.command),
              snapshotIdentity: snapshot.comparableId,
            });
            if (requestAuthMaterializedRoot) {
              const requestAuthUses =
                sessionPurposeBindingSnapshot?.requestAuthUses;
              if (
                !sessionPurposeBindingLease
                || !requestAuthUses?.length
                || !connectedServiceRedactionLease
              ) {
                throw new Error(
                  'Foreground Connected Account request-auth authority is unavailable',
                );
              }
              await activateConnectedAccountRequestAuthForSpawn({
                materializationId: request.sessionId,
                materializedRootDir: requestAuthMaterializedRoot,
                httpPort:
                  dependencies.resolveConnectedAccountRequestAuthHttpPort!(),
                subject: scopeConnectedAccountSessionPurposeBindingLease({
                  lease: sessionPurposeBindingLease,
                  subjectId: sessionPurposeBindingLease.subjectId,
                  uses: requestAuthUses,
                  ...(legacyConnectedServiceCatalogAgent
                    ? { legacyServiceKeyedCompatibility: true as const }
                    : {}),
                  registerRedaction: (values) => {
                    connectedServiceRedactionLease!.add(values);
                  },
                }),
                registry: dependencies.connectedAccountRequestAuthRegistry!,
                launchResourceScope: connectedServiceLaunchScope,
              });
              if (
                registration.retirementSignal.aborted
                || !registration.isCurrent()
              ) {
                throw new Error(
                  'Foreground Agent runtime generation changed during request-auth activation',
                );
              }
            }
            const retainedAgent =
              lease.registry.agentRuntimesByAgentId
                .get(request.agentId)
                ?.sessionRunnerFactoryBinding;
            if (!retainedAgent) {
              throw new Error(
                'Foreground Agent runtime retained binding is unavailable',
              );
            }
            runnerManagedDependencyRetentionReservation =
              await lease.registry
                .reserveManagedDependencyRetention?.(retainedAgent)
              ?? {
                retention: {
                  v: 1 as const,
                  sourceGenerationIds: [],
                  qualifiedDependencyIds: [],
                },
                release() {},
              };
            const runnerManagedDependencyRetentionV1 =
              runnerManagedDependencyRetentionReservation
                .retention;
            const authorityState: {
              authority: Awaited<ReturnType<
                typeof publishAgentRuntimeDaemonServiceAuthority
              >> | null;
            } = { authority: null };
            const custodyAttached =
              await attachExactRunnerRetainedPluginGenerations({
                paths: resolvePluginStorePaths({
                  happyHomeDir: configuration.happyHomeDir,
                }),
                immutableGenerationIds: [
                  retainedAgent.immutableGenerationId,
                ],
                attach: async () => {
                  authorityState.authority =
                    await publishAgentRuntimeDaemonServiceAuthority({
                      happyHomeDir: configuration.happyHomeDir,
                      publicReleaseRing: configuration.publicReleaseRing,
                      path: bridge.authorization.authorityFilePath,
                      sessionId: canonicalSessionId,
                      runner,
                      retainedAgent,
                      httpPort,
                    });
                  return true;
                },
              });
            const authority = authorityState.authority;
            if (!custodyAttached || !authority) {
              throw new Error(
                'Foreground Agent runtime retained generation custody is unavailable',
              );
            }
            publishedAuthority = authority;
            await assertExpectedConnectedAccountsCurrent();
            if (ownsConnectedServiceLaunchScope) {
              connectedServiceCleanupOnExit =
                connectedServiceLaunchScope.transfer();
            }
            connectedAccountLaunchCommitted = true;
            if (!connectedAccountLaunchCurrent) {
              await connectedServiceCleanupOnExit?.();
              throw new Error(
                'Foreground Connected Account binding changed before runtime open',
              );
            }
            connectedServiceClaimSucceeded = true;
            return {
              ok: true as const,
              environment: mergedEnvironment.environment,
              unsetEnvironmentVariableNames:
                mergedEnvironment.unsetEnvironmentVariableNames,
              sensitiveEnvironmentVariableNames,
              invocationContext: Object.freeze({
                cwd: request.directory,
                environment: Object.freeze({}),
                ...(finalSpawnEnvironment.agentCliLaunchSpec
                  ? {
                      agentCliLaunch: bindAgentCliLaunchSpec({
                        localAgentId: retainedAgent.localAgentId,
                        spec: finalSpawnEnvironment.agentCliLaunchSpec,
                      }),
                    }
                  : {}),
                providerBindingActive: false,
              }),
              authority: Object.freeze({
                retainedAgent,
                runner: authority.document.runner,
                runnerManagedDependencyRetentionV1,
                capabilityDigest: authority.capabilityDigest,
                transferCleanupOwnership: () => {
                  transferProviderLaunchMaterializationCleanupOwnership?.();
                  transferProviderLaunchMaterializationCleanupOwnership =
                    null;
                  if (
                    publishedAuthority?.path === authority.path
                    && publishedAuthority.capabilityDigest
                      === authority.capabilityDigest
                  ) {
                    publishedAuthority = null;
                  }
                  runnerManagedDependencyRetentionReservation
                    ?.release();
                  runnerManagedDependencyRetentionReservation =
                    null;
                },
              }),
            };
          } catch (error) {
            if (
              error
              instanceof ForegroundProfileSecretRecoveryRequiredError
            ) {
              return {
                ok: false as const,
                error: createProviderErrorV1(
                  'provider_agent_runtime_unsupported',
                  {
                    connectionId:
                      request.selection?.ref.providerConnectionId
                      ?? undefined,
                    machineId: request.machineId,
                    sourceProfileId: request.profileId,
                  },
                ),
                profileSecretRecovery: Object.freeze({
                  requirementNames: error.requirementNames,
                }),
              };
            }
            return {
              ok: false as const,
              error: createProviderErrorV1(
                'provider_agent_runtime_unsupported',
                {
                  connectionId:
                    request.selection?.ref.providerConnectionId
                    ?? undefined,
                  machineId: request.machineId,
                },
              ),
            };
          } finally {
            if (!connectedServiceClaimSucceeded) {
              await connectedServiceLaunchScope.release().catch(() => undefined);
            }
          }
        },
        cleanup,
      },
    };
  } catch {
    return refusal(createProviderErrorV1(
      'provider_agent_runtime_unsupported',
      {
        connectionId:
          request.selection?.ref.providerConnectionId ?? undefined,
        machineId: request.machineId,
      },
    ));
  } finally {
    if (!transferred) await cleanup().catch(() => undefined);
  }
}
