import { readProviderSettingsForCli } from '@/providers/settings/read';
import type { PrepareAgentIsolationMember } from '../spawn/prepareDaemonConnectedServices';
import type { AgentLaunchMaterialization } from '../agentIsolation/agentLaunchMaterials';
import { join } from 'node:path';
import { createMemberAgentCliLaunchContext } from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { agentRoutingIdAddressesContributionIdentityV1, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol/bugs/reports/redaction';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ProviderErrorV1, QualifiedConnectedAccountRef, ArtifactSharingResourceV1 } from '@happier-dev/protocol';
import type { AgentSessionConnectedAccountSelection } from '@happier-dev/plugin-sdk/agents/runtime';

import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { readStoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { acquireSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';
import { prepareDirectProviderLaunch, type DirectProviderLaunchResult } from '@/providers/lifecycle/prepareDirectLaunch';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/spawnSession';
import { projectChildEnvironmentLaunchError } from '../spawn/projectChildEnvironmentFailure';
import { createRuntimeProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsKeys,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshSavedSecretCatalogForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { loadAccountLaunchProfileArtifacts, ProfileCatalogUnavailableError, readProfilesFromAccountSettings, readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveCanonicalSpawnProfile } from '@/settings/profiles/validateSpawnProfile';
import {
  ForegroundProfileSecretRecoveryRequiredError,
  LaunchSecretReferenceOverlayError,
  readForegroundProfileRequiredSecretNamesMissingBinding,
  createLaunchSecretReferenceOverlayProviderErrorV1,
  resolveEffectiveLaunchProfileSecretBindings,
  resolveForegroundProfileSavedSecretEnvironment,
} from './resolveForegroundProfileSavedSecretEnvironment';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { attestFreshRunnerAgentBinding } from '@/plugins/runtime/retainedPluginSourceAttestation';
import {
  attachExactRunnerRetainedPluginGenerations,
} from '@/plugins/store/registry/generationCustodyRetirement';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import { resolveAccountConfiguredAcpLaunchForAgent } from '@/agent/runtime/registry/engineRegistry/accountConfiguredAcp';
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
  type ConnectedAccountCurrentSessionPurposeBindingSnapshot,
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
import { createBestEffortCleanupDirectory, type ConnectedServiceMaterializedStateObservationBinding } from '@/daemon/connectedServices/materialization/materializer';
import { isLegacyServiceKeyedCompatibilityCatalogAgent } from '@/agent/catalog/registry';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { preflightProjectAgentLaunch } from '@/workspaces/projectSetup/projectAgentLaunch';
import { resolveConnectedServiceMaterializedRootDir } from '@/daemon/connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { materializeQualifiedConnectedAccountLaunchUses } from '@/daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses';
import { materializeConnectedServicesForSpawn } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import { createRequesterPluginSettingsSource } from '@/daemon/sessionEncryption/requesterPluginSettings';
import { resolveRequesterSessionRuntimeDirectories } from '@/daemon/sessionEncryption/requesterSessionRuntimeDirectories';
import { createAccountPluginSettingsRecordStorage } from '@/plugins/runtime/context/accountPluginSettingsRecordStorage';

import type {
  ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  ForegroundAgentRuntimeAdmissionResponseV1,
} from './foregroundAdmissionContract';
import type { PreparedForegroundAgentRuntimeAdmission } from './foregroundAdmission';

function refusal(
  error: Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }>['error'],
): Extract<ForegroundAgentRuntimeAdmissionResponseV1, { ok: false }> {
  return { ok: false, error };
}

class ForegroundSessionAccountAdmissionError extends Error {}

function readForegroundAccountSnapshot(dependencies: PrepareForegroundAgentRuntimeAdmissionDependencies) {
  try {
    return dependencies.requesterSessionRuntimeContext
      ? dependencies.requesterSessionRuntimeContext.readAccountSettingsSnapshot()
      : dependencies.requesterSessionBootstrap
        ? dependencies.requesterSessionBootstrap.savedSecretOperationContext.readSnapshot()
        : getActiveAccountSettingsSnapshot();
  } catch { return null; }
}

function readExactForegroundProfileSnapshot(
  request: ForegroundAgentRuntimeAdmissionOwnerRequestV1,
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>,
  readAccountSettingsSnapshot = getActiveAccountSettingsSnapshot,
) {
  if (!request.profileId) return null;
  const settingsSnapshot = readAccountSettingsSnapshot();
  if (
    !settingsSnapshot
    || typeof settingsSnapshot.scopeKey !== 'string'
    || settingsSnapshot.scopeKey.length === 0
    || settingsSnapshot.scopeKey !== request.accountSettingsScopeKey
    || settingsSnapshot.settingsVersion !== request.accountSettingsVersion
    || (settingsSnapshot.profileCatalog && settingsSnapshot.profileCatalog.status !== 'ready')
  ) {
    return null;
  }
  let profile;
  try {
    const source = readProfileSettingsFromAccountSnapshot(settingsSnapshot);
    const resolved = resolveCanonicalSpawnProfile({ rawSettings: source,
      profileId: request.profileId, artifactsById, profileCatalog: settingsSnapshot.profileCatalog,
      expectedProfileRecordRevision: request.profileRecordRevision });
    if (!resolved.ok) return null;
    profile = readProfilesFromAccountSettings(source, artifactsById, undefined, settingsSnapshot.profileCatalog)
      .visibleProfiles.find((candidate) => candidate.id === request.profileId);
  } catch (error) {
    if (!(error instanceof ProfileCatalogUnavailableError)) throw error;
    return null;
  }
  return profile && profile.enabled !== false
    ? Object.freeze({ settingsSnapshot, profile, scopeKey: settingsSnapshot.scopeKey })
    : null;
}

export type PrepareForegroundAgentRuntimeAdmissionDependencies = Readonly<{
  agentIsolation?: import('../agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
  signal?: AbortSignal;
  prepareAgentIsolationMember?: PrepareAgentIsolationMember;
  /** Host-private admitted Account ports; never accepted from the foreground request body. */
  requesterSessionBootstrap?: AdmittedRequesterSessionBootstrap;
  requesterSessionRuntimeContext?: RequesterSessionRuntimeContext;
  connectedAccountsOwner?: StablePluginConnectedAccountsOwner;
  subscribeAccountSettingsSnapshot?: RequesterSessionRuntimeContext['subscribeAccountSettingsSnapshot'];
  resolveManagedPurposeBindingIntent?: RequesterSessionRuntimeContext['resolveManagedPurposeBindingIntent'];
  resolveManagedPurposeBindingIntentSelection?: RequesterSessionRuntimeContext['resolveManagedPurposeBindingIntentSelection'];
  managedProviderAccountAuthority?: import('@/plugins/runtime/providerBindings/runtimeTypes').ManagedProviderInvocationAccountAuthority | null;
  isSessionAccountCurrent?: (canonicalSessionId?: string) => Promise<boolean>;
  refreshSavedSecretCatalogForOperation?: typeof refreshSavedSecretCatalogForOperation;
  activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
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
  }>) => Promise<ConnectedAccountCurrentSessionPurposeBindingSnapshot | null>;
  /**
   * The Session Team slot bindings that the foreground Session must be created
   * with so the Home admits the snapshot's durable Team resource defaults
   * (resolved by the canonical defaults owner against the Home's catalog).
   */
  resolveSessionTeamCredentialBindingIntents?: (input: Readonly<{
    teamResourceSelections: ConnectedAccountCurrentSessionPurposeBindingSnapshot['teamResourceSelections'];
    signal: AbortSignal;
  }>) => Promise<SessionTeamCredentialBindingIntentListV1>;
  resolveConnectedServiceAuthForSpawn?: (
    input: Omit<Pick<
      Parameters<typeof resolveConnectedServiceAuthForSpawn>[0],
      | 'connectedServicesBindingsRaw'
      | 'modelId'
      | 'agentLaunchTarget'
      | 'signal'
      | 'materializationKey'
      | 'sessionDirectory'
      | 'sessionId'
      | 'vendorResumeId'
      | 'resumeReachabilityRequired'
      | 'resolveQualifiedPurposeBindingSnapshot'
      | 'activateQualifiedPurposeBindings'
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

function copyStringEnvironmentValues(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  ));
}

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
    copyStringEnvironmentValues(input.profile),
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
  for (const [name, value] of Object.entries(copyStringEnvironmentValues(input.connectedService))) {
    applyValue(name, value);
  }
  for (const [name, value] of Object.entries(copyStringEnvironmentValues(input.provider))) {
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
  agentIsolation?: import('../agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
  happyHomeDir: string;
  pluginRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
  resolvedAgentId: string;
  directory: string;
  backendTarget: ForegroundAgentRuntimeAdmissionOwnerRequestV1['backendTarget'];
  environment: Readonly<Record<string, string>>;
}>): Promise<Awaited<ReturnType<typeof resolveSpawnChildEnvironment>>> {
  return await resolveSpawnChildEnvironment({
    agentIsolation: params.agentIsolation,
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
      return [buildQualifiedPluginContributionKey(service)];
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
  dependencies: PrepareForegroundAgentRuntimeAdmissionDependencies;
  lease: Awaited<ReturnType<
    typeof acquireAuthoritativePluginRuntimeRegistryLease
  >>;
}>): Promise<DirectProviderLaunchResult<Readonly<{ ok: false; error: ProviderErrorV1 | SessionSpawnLaunchErrorV1 }>> | null> {
  const { request, lease, dependencies } = input;
  if ((!request.selection || request.selection.ref.providerConnectionId === null)
    && !request.previousBinding && !request.connectedServices) return null;
  const requester = dependencies.requesterSessionBootstrap;
  const featureEnabled = async () => (
    await resolveCliFeatureDecisionForServer({
      featureId: 'providers',
      env: process.env,
      serverUrl: requester?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
    })
  ).decision.state === 'enabled';
  return await prepareDirectProviderLaunch<Readonly<{ ok: false; error: ProviderErrorV1 | SessionSpawnLaunchErrorV1 }>>({
    signal: dependencies.signal,
    selection: request.selection,
    backendTarget: request.backendTarget,
    machineId: request.machineId,
    agentId: request.agentId,
    scope: { kind: 'session', sessionId: request.sessionId },
    previousBinding: request.previousBinding ?? null,
    confirmation: null,
    connectedServices: request.connectedServices ?? null,
    featureEnabled,
    managedPurposeContext: { lease, signal: dependencies.signal,
      readProviderSettings: () => {
        const snapshot = readForegroundAccountSnapshot(dependencies);
        return snapshot ? readProviderSettingsForCli(snapshot).settings : null;
      },
      happyHomeDir: requester ? dependencies.connectedServicesMaterializationBaseDir! : configuration.happyHomeDir,
      resolveManagedPurposeBindingIntentSelection: dependencies.resolveManagedPurposeBindingIntentSelection,
      accountAuthority: dependencies.managedProviderAccountAuthority },
  }, {
    resolvePrerequisites: async (providerBindingContext) => {
      const result = await resolveSpawnChildEnvironment({
        agentIsolation: dependencies.agentIsolation,
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
            error: projectChildEnvironmentLaunchError(result),
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
      signal: dependencies.signal,
      selection,
      machineId,
      agentTargetKey,
      agentId,
      lease,
      getAccountSettingsSnapshot: () => readForegroundAccountSnapshot(dependencies),
      subscribeAccountSettingsSnapshot: dependencies.subscribeAccountSettingsSnapshot
        ?? (requester ? undefined : (listener, keys) => subscribeActiveAccountSettingsKeys(keys, () => listener())),
      ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
      ...(dependencies.resolveManagedPurposeBindingIntent
        ? { resolveManagedPurposeBindingIntent: dependencies.resolveManagedPurposeBindingIntent } : {}),
      runtimeStateStore: createProviderRuntimeStateStore({
        happyHomeDir: requester ? dependencies.connectedServicesMaterializationBaseDir! : configuration.happyHomeDir,
        machineId,
      }),
      materializationBaseDir: join(
        requester ? dependencies.connectedServicesMaterializationBaseDir! : configuration.happyHomeDir,
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
  const requester = dependencies.requesterSessionBootstrap;
  if (dependencies.requesterSessionRuntimeContext && dependencies.requesterSessionRuntimeContext.bootstrap !== requester) {
    return refusal(createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }));
  }
  const readAccountSettingsSnapshot = () => readForegroundAccountSnapshot(dependencies);
  const withAccountHome = <T>(operation: () => Promise<T>): Promise<T> => requester
    ? runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, operation) : operation();
  // Held requester custody is local. The dependency is the launch's Account
  // admission: spent at entry and when the canonical Session binds, not per step.
  const isRequesterCustodyCurrent = async (): Promise<boolean> => {
    try {
      return !requester || (readAccountSettingsSnapshot() !== null
        && requester.getBoundSessionId() === (request.existingSessionId ?? request.sessionId)
        && requester.attribution.machineId === request.machineId
        && await requester.savedSecretOperationContext.isCurrent());
    } catch { return false; }
  };
  const isSessionAccountCurrent = async (canonicalSessionId?: string): Promise<boolean> => {
    try {
      return await isRequesterCustodyCurrent()
        && (!dependencies.isSessionAccountCurrent || await dependencies.isSessionAccountCurrent(canonicalSessionId));
    } catch { return false; }
  };
  const assertSessionAccountCurrent = async (canonicalSessionId?: string) => {
    if (!await isSessionAccountCurrent(canonicalSessionId)) throw new ForegroundSessionAccountAdmissionError('requester_session_not_current');
  };
  if (!await isSessionAccountCurrent()
    || requester && (request.selection || request.previousBinding)
      && (!dependencies.subscribeAccountSettingsSnapshot || !dependencies.connectedServicesMaterializationBaseDir)) {
    return refusal(createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }));
  }
  let launchProfileArtifacts: ReadonlyMap<string, ArtifactSharingResourceV1> | undefined;
  if (request.profileId) {
    const credentials = requester ? requester.credentials : await readStoredCredentials();
    if (credentials && resolveAccountSettingsScopeKey(credentials) === request.accountSettingsScopeKey) {
      // A cold requester bootstrap has Settings, not a demanded Profile catalog.
      // Hydrate through its existing private Account owner before exact selection.
      if (requester && !readAccountSettingsSnapshot()?.profileCatalog) {
        const { refreshActiveProfileCatalog } = await import('@/settings/profiles/hydrateProfileCatalog');
        await refreshActiveProfileCatalog({ credentials, operationContext: requester.savedSecretOperationContext });
      }
      const accountSnapshot = readAccountSettingsSnapshot();
      if (!accountSnapshot?.profileCatalog || accountSnapshot.profileCatalog.status === 'ready') {
        launchProfileArtifacts = await withAccountHome(() => loadAccountLaunchProfileArtifacts(readProfileSettingsFromAccountSnapshot(accountSnapshot), credentials, undefined, accountSnapshot?.profileCatalog));
      }
    }
  }
  const initialExactProfileSnapshot = readExactForegroundProfileSnapshot(request, launchProfileArtifacts, readAccountSettingsSnapshot);
  if (request.profileId && !initialExactProfileSnapshot) {
    return refusal(createProviderErrorV1(
      'provider_agent_runtime_unsupported',
      {
        machineId: request.machineId,
        sourceProfileId: request.profileId,
      },
    ));
  }
  if (initialExactProfileSnapshot) {
    const expectedScopeKey = initialExactProfileSnapshot.scopeKey;
    let references: readonly Readonly<{ ref: string; revision?: number }>[];
    try {
      references = Object.freeze(Object.values(
        resolveEffectiveLaunchProfileSecretBindings({
          profile: initialExactProfileSnapshot.profile,
          accountSettings: initialExactProfileSnapshot.settingsSnapshot.settings,
          ...(request.secretReferenceOverlay
            ? { secretReferenceOverlay: request.secretReferenceOverlay }
            : {}),
        }),
      ));
    } catch (error) {
      if (!(error instanceof LaunchSecretReferenceOverlayError)) throw error;
      return refusal(createLaunchSecretReferenceOverlayProviderErrorV1(
        error.reason,
        { machineId: request.machineId, sourceProfileId: request.profileId },
      ));
    }
    try {
      await (
        dependencies.refreshSavedSecretCatalogForOperation
        ?? refreshSavedSecretCatalogForOperation
      )({
        expectedScopeKey,
        references,
        ...(requester ? { operationContext: requester.savedSecretOperationContext } : {}),
      });
    } catch (error) {
      return refusal(createLaunchSecretReferenceOverlayProviderErrorV1(
        error instanceof SavedSecretOperationAdmissionError ? error.reason : 'reference_unavailable',
        { machineId: request.machineId, sourceProfileId: request.profileId },
      ));
    }
  }
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
    // Refuse an unavailable Project namespace before Provider materialization
    // or Agent activation. Native setup consumes the actual child tuple later.
    const projectCredentials = requester ? requester.credentials : await readStoredCredentials();
    if (projectCredentials) {
      const project = await preflightProjectAgentLaunch({
        cwd: request.directory,
        machineId: request.machineId,
        serverId: requester?.attribution.serverId ?? configuration.activeServerId,
        serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        account: {
          credentials: projectCredentials,
          assertCurrentAuthority: async () => {
            if (!await isRequesterCustodyCurrent()) throw new ForegroundSessionAccountAdmissionError('requester_session_not_current');
          },
          ...(requester ? { sessionCustody: {
            serverId: requester.attribution.serverId,
            accountId: requester.attribution.accountId,
            serverHttpBaseUrl: requester.serverHttpBaseUrl,
            isCurrent: isRequesterCustodyCurrent,
          } } : {}),
        },
      });
      if (project.kind === 'refused') {
        return { ok: false, error: { code: 'project_agent_launch_refused', reason: project.code } };
      }
    }
    // The Provider decision runs before any runner bootstrap material is
    // written. Cleanup removes those files, but it cannot un-activate an Agent
    // runtime contribution, so every Provider refusal this owner can already
    // establish is established first.
    const providerLaunch = await prepareForegroundProviderLaunch({
      request,
      lease,
      dependencies,
    });
    if (providerLaunch && !providerLaunch.ok) {
      return refusal(providerLaunch.error);
    }
    const activeProviderLaunch =
      providerLaunch?.ok && providerLaunch.kind !== 'native'
        ? providerLaunch
        : null;
    if (activeProviderLaunch) {
      providerCleanup = activeProviderLaunch.cleanupOnExit;
      if (activeProviderLaunch.kind === 'provider') transferProviderLaunchMaterializationCleanupOwnership =
        activeProviderLaunch.transferLaunchMaterializationCleanupOwnership;
    }
    const selectedAgent = lease.registry.contributes.agentDefinitionsById.get(request.agentId);
    if (request.agentTarget && (!selectedAgent?.identity
      || selectedAgent.identity.pluginId !== request.agentTarget.identity.pluginId
      || selectedAgent.identity.localId !== request.agentTarget.identity.localId)
      || request.runtimeDescriptorV1 && (!selectedAgent?.identity
        || !agentRoutingIdAddressesContributionIdentityV1(request.runtimeDescriptorV1.agentId, selectedAgent.identity))) {
      return refusal(createProviderErrorV1('provider_agent_runtime_unsupported', { machineId: request.machineId }));
    }
    if (selectedAgent?.identity) {
      // Bind the selected Account row through the same launch owner as daemon
      // and direct Session execution before creating foreground bootstrap files.
      await resolveAccountConfiguredAcpLaunchForAgent({
        identity: selectedAgent.identity,
        agentTarget: request.agentTarget,
        startupRuntimeDescriptorV1: request.runtimeDescriptorV1,
        savedSecretOperationContext: requester?.savedSecretOperationContext,
      });
    }
    const foregroundPreparedIdentity = await dependencies.prepareAgentIsolationMember?.({
      requesterWorkAttributionV1: dependencies.requesterSessionRuntimeContext?.bootstrap.attribution
        ?? dependencies.requesterSessionBootstrap?.attribution,
      signal: dependencies.signal,
    });
    const foregroundMemberIdentity = foregroundPreparedIdentity?.kind === 'member' ? foregroundPreparedIdentity.identity : undefined;
    if (foregroundMemberIdentity && !request.runtimeDescriptorV1) {
      return refusal(createProviderErrorV1('provider_agent_runtime_unsupported', { machineId: request.machineId }));
    }
    const foregroundNativeIdentity = foregroundPreparedIdentity?.identity;
    const agentLaunchTarget = foregroundNativeIdentity ? {
      ...(foregroundMemberIdentity ? { memberIdentity: foregroundMemberIdentity } : {}),
      runtimeHome: resolveConnectedServiceMaterializedRootDir({ baseDir: foregroundNativeIdentity.home,
        agentId: request.agentId, materializationKey: request.sessionId }),
    } : undefined;
    let agentLaunchMaterials: AgentLaunchMaterialization | undefined = agentLaunchTarget ? Object.freeze({
      ...agentLaunchTarget, environment: Object.freeze({}), selectedMaterials: Object.freeze([]),
    }) : undefined;
    const bridge = await prepareForegroundAgentRuntimeBootstrapForLease({
      target: request.backendTarget,
      lease,
      ...(request.runtimeDescriptorV1 ? { launch: { runtimeDescriptorV1: request.runtimeDescriptorV1,
        ...(agentLaunchMaterials ? { agentIsolationRuntimeHome: agentLaunchMaterials.runtimeHome } : {}),
        ...(foregroundMemberIdentity ? { agentIsolationMemberIdentity: foregroundMemberIdentity } : {}),
      } } : {}),
    });
    const registration = lease.registry.agentRuntimesByAgentId.get(
      request.agentId,
    );
    // The registry is keyed by the canonical host routing id, and the
    // descriptor must carry exactly that id — no corridor-local respelling.
    const expectedDescriptorAgentId = registration?.agentId ?? null;
    if (
      !bridge
      || bridge.authorization.descriptor.agentId
        !== expectedDescriptorAgentId
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
    if (
      !registration?.hasPrimaryRuntime
      || registration.pluginId !== bridge.authorization.descriptor.pluginId
      || registration.occurrenceId
        !== bridge.authorization.descriptor.occurrenceId
      || !pluginSourceCustodyV1Equal(
        registration.sourceCustody,
        bridge.authorization.descriptor.sourceCustody,
      )
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
              activeProviderLaunch.kind === 'managedPurpose'
                ? serializeProviderBindingLaunchHandoffForEnv({ v: 1,
                    materialization: activeProviderLaunch.launchMaterialization,
                    providerBinding: activeProviderLaunch.providerBinding, selection: activeProviderLaunch.selection })
                : serializeProviderBindingLaunchHandoffForEnv(
                    activeProviderLaunch.launchMaterialization, activeProviderLaunch.bindingMetadata),
          })
        : Object.freeze({});
    const providerUnsetEnvironmentVariableNames =
      activeProviderLaunch?.unsetEnvKeys ?? Object.freeze([]);
    const effectiveConnectedServices =
      activeProviderLaunch
        ? activeProviderLaunch.connectedServices
        : request.connectedServices ?? null;
    let materializedConnectedServices = effectiveConnectedServices;
    let materializedSessionConnectedAccounts: readonly AgentSessionConnectedAccountSelection[] = [];
    let materializedStateObservationBinding: ConnectedServiceMaterializedStateObservationBinding | undefined;
    const connectedServiceCatalogEntry = lease.registry.acquireAgentCatalogEntry
      ? await lease.registry.acquireAgentCatalogEntry(request.agentId)
      : lease.registry.contributes.catalogEntriesById[request.agentId] ?? null;
    const legacyConnectedServiceCatalogAgent =
      isLegacyServiceKeyedCompatibilityCatalogAgent(
        connectedServiceCatalogEntry,
      );
    const externalPurposeDeclarations = !legacyConnectedServiceCatalogAgent
      ? resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
          agentId: request.agentId,
          contributions: lease.registry.contributes,
          catalogEntry: connectedServiceCatalogEntry,
        })
      : null;
    let sessionTeamCredentialBindings: SessionTeamCredentialBindingIntentListV1 | null = null;
    let sessionPurposeBindingSnapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null =
      effectiveConnectedServices
      ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId: request.agentId,
          bindings: effectiveConnectedServices,
          contributions: lease.registry.contributes,
          catalogEntry: connectedServiceCatalogEntry,
        })
      : null;
    // A resumed Session carries its exact Account selection. Only a new launch
    // without that selection reads current defaults through the purpose owner.
    if (!effectiveConnectedServices && externalPurposeDeclarations?.authorizedPurposes.length) {
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
      if (externalSnapshot.teamResourceSelections.length > 0) {
        if (!dependencies.resolveSessionTeamCredentialBindingIntents) {
          return refusal(createProviderErrorV1(
            'provider_agent_runtime_unsupported',
            { machineId: request.machineId },
          ));
        }
        try {
          sessionTeamCredentialBindings =
            await dependencies.resolveSessionTeamCredentialBindingIntents({
              teamResourceSelections: externalSnapshot.teamResourceSelections,
              signal: registration.retirementSignal,
            });
        } catch {
          // The durable Team default no longer resolves to a resource this
          // Home offers: refuse typed rather than launch without it.
          return refusal(createProviderErrorV1(
            'provider_binding_changed',
            { machineId: request.machineId },
          ));
        }
        if (registration.retirementSignal.aborted || !registration.isCurrent()) {
          return refusal(createProviderErrorV1(
            'provider_agent_runtime_unsupported',
            { machineId: request.machineId },
          ));
        }
      }
      sessionPurposeBindingSnapshot = Object.freeze({
        purposes: externalSnapshot.purposes,
        bindings: externalSnapshot.bindings,
        ...(externalSnapshot.directMaterialOrigins.length > 0
          ? { directMaterialOrigins: externalSnapshot.directMaterialOrigins }
          : {}),
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
        ...(externalPurposeDeclarations.environmentUnsetUses
          ? { environmentUnsetUses: externalPurposeDeclarations.environmentUnsetUses }
          : {}),
      });
    }
    if (
      effectiveConnectedServices
      && (
        !sessionPurposeBindingSnapshot
        || !hasCompleteConnectedServiceProjection(
          effectiveConnectedServices,
          sessionPurposeBindingSnapshot,
        )
        || !dependencies.activateSessionPurposeBindings
        || legacyConnectedServiceCatalogAgent && (
          !dependencies.resolveConnectedServiceAuthForSpawn
          || !dependencies.resolveDaemonSpawnHooks
        )
      )
    ) {
      return refusal(createProviderErrorV1(
        'provider_agent_runtime_unsupported',
        { machineId: request.machineId },
      ));
    }
    let connectedServiceAuth: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
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
      connectedServiceAuth =
        await dependencies.resolveConnectedServiceAuthForSpawn!({
          agentId: request.agentId,
          modelId: request.selection?.ref.modelId,
          ...(agentLaunchTarget ? { agentLaunchTarget } : {}),
          signal: dependencies.signal ?? registration.retirementSignal,
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
              catalogEntry: connectedServiceCatalogEntry,
            }),
          ...(dependencies.activatePurposeBindings ? {
            activateQualifiedPurposeBindings: snapshot => dependencies.activatePurposeBindings!({
              subject: {
                kind: 'operation',
                operationId: request.attemptId,
                consumer: snapshot.purposes[0]!.consumer,
                ...(request.existingSessionId ? { sessionId: request.existingSessionId } : {}),
                isCurrent: () => true,
              },
              purposes: snapshot.purposes,
              bindings: snapshot.bindings,
              ...(snapshot.directMaterialOrigins ? { directMaterialOrigins: snapshot.directMaterialOrigins } : {}),
            }),
          } : {}),
        });
      if (connectedServiceAuth?.materializationPurposeLease) {
        const materializationPurposeLease = connectedServiceAuth.materializationPurposeLease;
        connectedServiceLaunchScope.register(() => materializationPurposeLease.dispose());
      }
      if (connectedServiceAuth?.agentLaunchMaterials) agentLaunchMaterials = connectedServiceAuth.agentLaunchMaterials;
      const daemonSpawnHooks =
        await dependencies.resolveDaemonSpawnHooks!(request.agentId);
      materializedStateObservationBinding = connectedServiceAuth?.materializedStateObservationBinding;
      materializedSessionConnectedAccounts = connectedServiceAuth?.sessionConnectedAccounts ?? [];
      materializedConnectedServices = connectedServiceAuth?.connectedServicesBindings
        ?? effectiveConnectedServices;
      const childEnvironment = await resolveSpawnChildEnvironment({
        memberAgentCliLaunch: createMemberAgentCliLaunchContext({ material: agentLaunchMaterials,
          managedHappierBinaryPath: dependencies.agentIsolation?.managedHappierBinaryPath, signal: dependencies.signal }),
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
        return {
          ok: false,
          error: {
            kind: 'launch_error',
            code: childEnvironment.errorCode,
            message: connectedServiceLaunchScope.sanitize(childEnvironment.errorMessage),
          },
        };
      }
      connectedServiceEnvironment = Object.freeze({
        ...childEnvironment.extraEnvForChild,
      });
      connectedServiceUnsetEnvironmentVariableNames = Object.freeze([
        ...(childEnvironment.unsetEnvKeys ?? []),
      ]);
      if (
        connectedServiceAuth
        && !connectedServiceAuth.qualifiedPurposeBindingSnapshot
      ) {
        return refusal(createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { machineId: request.machineId },
        ));
      }
      if (
        connectedServiceAuth?.qualifiedPurposeBindingSnapshot
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
      && !agentLaunchTarget
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
      effectiveConnectedServices || requestAuthMaterializedRoot || agentLaunchTarget,
    );
    const readExactProfileSnapshot = () =>
      readExactForegroundProfileSnapshot(request, launchProfileArtifacts, readAccountSettingsSnapshot);
    const stateSharingDescriptor = await connectedServiceCatalogEntry
      ?.getConnectedServiceStateSharingDescriptor?.();

    transferred = true;
    return {
      ok: true,
      prepared: {
        ...(dependencies.requesterSessionRuntimeContext
          ? { requesterSessionRuntimeContext: dependencies.requesterSessionRuntimeContext } : {}),
        authorization: bridge.authorization,
        ...(sessionTeamCredentialBindings && sessionTeamCredentialBindings.length > 0
          ? { teamCredentialBindings: sessionTeamCredentialBindings }
          : {}),
        reservedEnvironmentVariableNames:
          requirements?.authIsolation.ownedEnvKeys ?? [],
        profileSecretRequirementNamesMissingBinding:
          initialExactProfileSnapshot
            ? readForegroundProfileRequiredSecretNamesMissingBinding({
                profile: initialExactProfileSnapshot.profile,
                accountSettings:
                  initialExactProfileSnapshot.settingsSnapshot.settings,
                ...(request.secretReferenceOverlay
                  ? { secretReferenceOverlay: request.secretReferenceOverlay }
                  : {}),
              })
            : Object.freeze([]),
        ...(!requester && stateSharingDescriptor?.providerSupportStatus === 'supported'
          && stateSharingDescriptor.nativeHome
          ? {
              nativeHomeSourceEnvironmentKey:
                stateSharingDescriptor.nativeHome.environmentKey,
            }
          : {}),
        retirementSignal: registration.retirementSignal,
        isCurrent: () => (
          registration.isCurrent() && connectedAccountLaunchCurrent
          && (!requester || readAccountSettingsSnapshot() !== null)
        ),
        ...(connectedServiceCatalogEntry?.resolveSessionRuntimePreferences
          ? {
              resolveSessionRuntimePreferences: async (input) => {
                if (
                  registration.retirementSignal.aborted
                  || !registration.isCurrent()
                  || !connectedAccountLaunchCurrent
                ) {
                  return {};
                }
                const result = await connectedServiceCatalogEntry.resolveSessionRuntimePreferences!(input);
                return registration.isCurrent() && connectedAccountLaunchCurrent ? result : {};
              },
            }
          : {}),
        claim: async ({
          canonicalSessionId,
          httpPort,
          foregroundSatisfiedProfileSecretRequirementNames,
          nativeHomeSourceEnvironmentValue,
        }) => {
          let connectedServiceClaimSucceeded = false;
          try {
            if (requester && canonicalSessionId !== requester.getBoundSessionId()) {
              return { ok: false as const, error: createProviderErrorV1('provider_authorization_changed', { machineId: request.machineId }) };
            }
            await assertSessionAccountCurrent(canonicalSessionId);
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
              try {
                const bindings = resolveEffectiveLaunchProfileSecretBindings({
                  profile: exactProfileSnapshot.profile, accountSettings: exactProfileSnapshot.settingsSnapshot.settings,
                  secretReferenceOverlay: request.secretReferenceOverlay,
                });
                const savedSecretMaterializer = await acquireSavedSecretMaterializerForOperation({
                  snapshot: exactProfileSnapshot.settingsSnapshot,
                  secretSources: lease.registry.secretSources,
                  references: Object.entries(bindings)
                    .filter(([name]) => !foregroundSatisfiedProfileSecretRequirementNames.includes(name)).map(([, binding]) => binding),
                  ...(requester ? { operationContext: requester.savedSecretOperationContext } : {}),
                });
                savedProfileEnvironment =
                  resolveForegroundProfileSavedSecretEnvironment({
                    profile: exactProfileSnapshot.profile,
                    accountSettings:
                      exactProfileSnapshot.settingsSnapshot.settings,
                    settingsSecretsReadKeys:
                      exactProfileSnapshot.settingsSnapshot
                        .settingsSecretsReadKeys,
                    savedSecretResources:
                      exactProfileSnapshot.settingsSnapshot.savedSecretResources,
                    savedSecretMaterializer,
                    foregroundSatisfiedSecretRequirementNames:
                      foregroundSatisfiedProfileSecretRequirementNames,
                    ...(request.secretReferenceOverlay
                      ? { secretReferenceOverlay: request.secretReferenceOverlay }
                      : {}),
                  });
              } catch (error) {
                if (!(error instanceof LaunchSecretReferenceOverlayError)) throw error;
                // The caller chose these exact Saved Secrets for this launch.
                // Falling back to the Profile binding would silently launch
                // with credentials they did not select.
                return {
                  ok: false as const,
                  error: createLaunchSecretReferenceOverlayProviderErrorV1(
                    error.reason,
                    {
                      machineId: request.machineId,
                      sourceProfileId: request.profileId,
                    },
                  ),
                };
              }
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
                  ...(sessionPurposeBindingSnapshot.directMaterialOrigins
                    ? { directMaterialOrigins: sessionPurposeBindingSnapshot.directMaterialOrigins }
                    : {}),
                });
            }
            const expectedConnectedAccountByPurposeKey =
              new Map<string, QualifiedConnectedAccountRef>();
            const sourceConnectedAccountsOwner =
              dependencies.connectedAccountsOwner
              ?? (requester ? undefined : lease.registry.resolveConnectedAccountPurposeBindingOwner?.());
            const connectedAccountsOwner = sourceConnectedAccountsOwner ? {
              ...sourceConnectedAccountsOwner,
              materialize: async (input: Parameters<StablePluginConnectedAccountsOwner['materialize']>[0]) => {
                const result = await sourceConnectedAccountsOwner.materialize(input);
                if (input.expectedAccount) {
                  materializedSessionConnectedAccounts = [...materializedSessionConnectedAccounts.filter(selection =>
                    selection.purpose !== input.purpose.purpose), {
                    purpose: input.purpose.purpose, account: input.expectedAccount,
                    ...(result.usageAccountScope === undefined ? {} : { usageAccountScope: result.usageAccountScope }),
                  }];
                }
                return result;
              },
            } : undefined;
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
                // Admission owns this start's selection; the saved default only
                // chooses future starts and may be absent or select another account.
                const exactBinding = await connectedAccountsOwner.getBinding({
                  purpose: authorized.purpose,
                  serviceRefs: authorized.serviceRefs,
                  exactPurposeBindingSubjectId: sessionPurposeBindingLease.subjectId,
                  sessionId: canonicalSessionId,
                  signal: registration.retirementSignal,
                });
                if (!exactBinding) {
                  throw new Error(
                    'Foreground Connected Account binding is unavailable before materialization',
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
                  async listener(change) {
                    if (!change.authorityChanged) return;
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
            const boundNativeHomeFilePurposes = sessionPurposeBindingLease
              ? (sessionPurposeBindingSnapshot?.fileMaterializationPurposes ?? [])
                  .filter(scope => sessionPurposeBindingLease?.resolvePurposeBinding(scope.purpose) !== null)
              : [];
            const providerRequiresNativeHome = !agentLaunchTarget
              && boundNativeHomeFilePurposes.length === 0
              && stateSharingDescriptor?.providerSupportStatus === 'supported'
              && Boolean(stateSharingDescriptor.nativeHome)
              && Boolean(activeProviderLaunch);
            if (
              sessionPurposeBindingSnapshot
              && !agentLaunchTarget
              && !connectedServiceAuth
              && boundNativeHomeFilePurposes.length === 0
              && !providerRequiresNativeHome
              && sessionPurposeBindingLease
              && (
                (sessionPurposeBindingSnapshot.environmentUses?.length ?? 0) > 0
                || (sessionPurposeBindingSnapshot.fileEnvironmentUses?.length ?? 0) > 0
                || (sessionPurposeBindingSnapshot.environmentUnsetUses?.length ?? 0) > 0
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
                    occurrenceId: registration.occurrenceId,
                    pluginId: registration.pluginId,
                    contributionQualifiedId: resolveAgentContributionQualifiedId({
                      pluginId: registration.pluginId,
                      localId: registration.localAgentId,
                    }),
                    sessionId: canonicalSessionId,
                  }),
                  retainCredentialFileCleanup(cleanup) {
                    connectedServiceLaunchScope.register({
                      onFailure: () => cleanup.dispose(),
                      onExit: () => cleanup.dispose(),
                    });
                  },
                });
              if (Object.keys(launchEnvironment.env).length > 0) {
                const redaction = registerSensitiveDiagnosticValues(
                  Object.values(launchEnvironment.env),
                );
                connectedServiceLaunchScope.register({
                  onFailure: () => redaction.close(),
                  onExit: () => redaction.close(),
                });
                connectedServiceEnvironment = Object.freeze({
                  ...connectedServiceEnvironment,
                  ...launchEnvironment.env,
                });
                sensitiveEnvironmentVariableNames = Object.freeze([
                  ...new Set([
                    ...sensitiveEnvironmentVariableNames,
                    ...Object.keys(launchEnvironment.env),
                  ]),
                ]);
                ownsConnectedServiceLaunchScope = true;
              }
              connectedServiceUnsetEnvironmentVariableNames = Object.freeze([
                ...connectedServiceUnsetEnvironmentVariableNames,
                ...launchEnvironment.unsetEnvKeys,
              ]);
            }
            if (!connectedServiceAuth && (
              agentLaunchTarget || boundNativeHomeFilePurposes.length > 0 || providerRequiresNativeHome
            )) {
              if (!dependencies.connectedServicesMaterializationBaseDir) {
                throw new Error('Foreground Connected Account materialization authority is unavailable');
              }
              const materializationDirectories = dependencies.requesterSessionRuntimeContext
                ?? (requester ? resolveRequesterSessionRuntimeDirectories({
                  activeServerDir: configuration.activeServerDir,
                  connectedServicesMaterializationBaseDir: dependencies.connectedServicesMaterializationBaseDir,
                  attribution: requester.attribution,
                }) : {
                  activeServerDir: configuration.activeServerDir,
                  connectedServicesMaterializationBaseDir: dependencies.connectedServicesMaterializationBaseDir,
                });
              if (!connectedServiceRedactionLease) {
                connectedServiceRedactionLease = createProviderRedactionLease({ values: [] });
                connectedServiceLaunchScope.register(connectedServiceRedactionLease.close);
                connectedServiceLaunchScope.setSanitizer(connectedServiceRedactionLease.redact);
              }
              const materialized = await materializeConnectedServicesForSpawn({
                agentId: request.agentId, materializationKey: request.sessionId,
                activeServerDir: materializationDirectories.activeServerDir,
                baseDir: materializationDirectories.connectedServicesMaterializationBaseDir,
                sessionDirectory: request.directory, agentLaunchTarget,
                requesterWorkAttributionV1: requester?.attribution,
                recordsByServiceId: new Map(), allowNativeAccountState: !agentLaunchTarget && !requester,
                ...(providerRequiresNativeHome ? { nativeHomeOnly: true } : {}),
                accountSettings: readAccountSettingsSnapshot()?.rawSettings ?? null,
                vendorResumeId: request.vendorResumeId ?? null,
                runtimeDescriptorV1: request.runtimeDescriptorV1,
                accountPluginSettingsSource: requester ? createRequesterPluginSettingsSource({
                  bootstrap: requester, signal: registration.retirementSignal,
                  isCurrent: () => isSessionAccountCurrent(canonicalSessionId),
                }) : {
                  recordAdapter: createAccountPluginSettingsRecordStorage(),
                  readReleasedAccountSettings: () => readAccountSettingsSnapshot()?.rawSettings ?? null,
                },
                connectedAccountsOwner,
                ...(sessionPurposeBindingSnapshot && sessionPurposeBindingLease ? {
                  qualifiedPurposeBindingSnapshot: sessionPurposeBindingSnapshot,
                  exactPurposeBindingSubjectId: sessionPurposeBindingLease.subjectId,
                  purposeBindingSessionId: canonicalSessionId,
                  connectedAccountMaterializationAuthority: {
                    kind: 'qualified' as const,
                    purposeBindings: sessionPurposeBindingSnapshot.bindings,
                    requestAuthPurposeBindings: resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(sessionPurposeBindingSnapshot),
                  },
                } : {}),
                processEnv: {
                  ...process.env, ...savedProfileEnvironment,
                  ...(stateSharingDescriptor?.nativeHome && nativeHomeSourceEnvironmentValue !== undefined
                    ? { [stateSharingDescriptor.nativeHome.environmentKey]: nativeHomeSourceEnvironmentValue ?? undefined }
                    : {}),
                },
                signal: registration.retirementSignal,
                isAccountRuntimeCurrent: async () => !registration.retirementSignal.aborted
                  && connectedAccountLaunchCurrent && registration.isCurrent(),
              });
              if (!materialized) throw new Error('Foreground Connected Account materialization is unavailable');
              if (agentLaunchTarget && (!materialized.agentLaunchMaterials
                || materialized.agentLaunchMaterials.runtimeHome !== agentLaunchTarget.runtimeHome)) {
                throw new Error('Foreground member native home is unavailable');
              }
              connectedServiceLaunchScope.register({ onFailure: materialized.cleanupOnFailure ?? (() => {}),
                onExit: materialized.cleanupOnExit ?? (() => {}) });
              if (materialized.agentLaunchMaterials) agentLaunchMaterials = materialized.agentLaunchMaterials;
              connectedServiceRedactionLease.add([
                ...Object.values(materialized.env), ...Object.values(materialized.agentLaunchMaterials?.environment ?? {}),
              ]);
              sensitiveEnvironmentVariableNames = Object.freeze([
                ...new Set([...sensitiveEnvironmentVariableNames, ...Object.keys(materialized.env)]),
              ]);
              connectedServiceEnvironment = Object.freeze({ ...connectedServiceEnvironment, ...materialized.env });
              connectedServiceUnsetEnvironmentVariableNames = Object.freeze([
                ...connectedServiceUnsetEnvironmentVariableNames, ...(materialized.unsetEnvKeys ?? []),
              ]);
              materializedSessionConnectedAccounts = materialized.sessionConnectedAccounts ?? [];
              materializedStateObservationBinding = materialized.materializedStateObservationBinding;
              if (materialized.requestAuthMaterializedRoot) requestAuthMaterializedRoot = materialized.requestAuthMaterializedRoot;
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
              agentIsolation: dependencies.agentIsolation,
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
              || registration.occurrenceId
                !== bridge.authorization.descriptor.occurrenceId
              || !pluginSourceCustodyV1Equal(
                registration.sourceCustody,
                bridge.authorization.descriptor.sourceCustody,
              )
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
            const selectedRetainedAgent =
              lease.registry.agentRuntimesByAgentId
                .get(request.agentId)
                ?.sessionRunnerFactoryBinding;
            if (!selectedRetainedAgent) {
              throw new Error(
                'Foreground Agent runtime retained binding is unavailable',
              );
            }
            const retainedAgent = await attestFreshRunnerAgentBinding({
              binding: selectedRetainedAgent,
              paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
              runnerSnapshotIdentity: runner.snapshotIdentity,
            });
            runnerManagedDependencyRetentionReservation =
              await lease.registry
                .reserveManagedDependencyRetention?.(retainedAgent)
              ?? {
                retention: {
                  v: 1 as const,
                  sourceCustodies: [],
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
                immutableGenerationIds:
                  retainedAgent.sourceCustody.kind === 'managed'
                    ? [retainedAgent.sourceCustody.immutableGenerationId]
                    : [],
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
            const sessionConnectedAccounts = (sessionPurposeBindingSnapshot?.authorizedPurposes ?? [])
              .flatMap(({ purpose }) => {
                const account = expectedConnectedAccountByPurposeKey.get(qualifiedPurposeKey(purpose));
                const materialized = materializedSessionConnectedAccounts.find(selection => selection.purpose === purpose.purpose
                  && account && sameQualifiedConnectedAccountRef(account, selection.account));
                return account ? [{ purpose: purpose.purpose, account,
                  ...(materialized?.usageAccountScope === undefined ? {} : { usageAccountScope: materialized.usageAccountScope }),
                }] : [];
              });
            return {
              ok: true as const,
              environment: mergedEnvironment.environment,
              ...(agentLaunchMaterials ? { agentLaunchMaterials } : {}),
              ...(sessionConnectedAccounts.length > 0
                ? { sessionConnectedAccounts: Object.freeze(sessionConnectedAccounts) }
                : {}),
              unsetEnvironmentVariableNames:
                mergedEnvironment.unsetEnvironmentVariableNames,
              sensitiveEnvironmentVariableNames,
              ...(materializedStateObservationBinding ? { materializedStateObservationBinding } : {}),
              ...(materializedConnectedServices && sessionPurposeBindingLease
                ? {
                    connectedServiceRuntimeTarget: {
                      materializationKey: request.sessionId,
                      connectedServicesBindingsRaw: materializedConnectedServices,
                      connectedServiceSelectionsEnvRaw:
                        connectedServiceEnvironment[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
                      sessionDirectory: request.directory,
                      exactPurposeBindingSubjectId: sessionPurposeBindingLease.subjectId,
                    },
                  }
                : {}),
              invocationContext: Object.freeze({
                cwd: request.directory,
                environment: Object.freeze({}),
                ...(request.profileId ? { profileId: request.profileId } : {}),
                ...(request.secretReferenceOverlay ? { secretReferenceOverlay: request.secretReferenceOverlay } : {}),
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
                error instanceof ForegroundSessionAccountAdmissionError ? 'provider_authorization_changed' : 'provider_agent_runtime_unsupported',
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
  } catch (error) {
    return refusal(createProviderErrorV1(
      error instanceof ForegroundSessionAccountAdmissionError ? 'provider_authorization_changed' : 'provider_agent_runtime_unsupported',
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
