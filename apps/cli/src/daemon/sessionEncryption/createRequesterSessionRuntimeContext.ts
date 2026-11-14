import { createRequesterPluginSettingsSource } from './requesterPluginSettings';
import type { ActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { randomBytes } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { writeQualifiedProviderAccountUsageV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { createDaemonConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createRequesterTeamCredentialDirectMaterialClient } from '../connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { startDaemonConnectedServiceRuntime } from '../startup/startDaemonRuntimeBootstrap';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from './requesterSessionCredentials';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import { ProfileCatalogUnavailableError, readProfilesFromAccountSettings,
  readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { readAuthoringMemoryLastUsedProfile } from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';
import type { ProfileCatalogSnapshotV1, ProfileCatalogUnavailableReasonV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { createObservedAccountRunFollowRoutes } from '@/agent/runtime/session/follow/accountRunFollowRoutes';
import { createRequesterSessionFollowSourceReconciliation } from './requesterSessionFollowSourceReconciliation';
import { stopRequesterSessionBackgroundLoops } from './stopRequesterSessionBackgroundLoops';
import { resolveRequesterSessionRuntimeDirectories } from './requesterSessionRuntimeDirectories';

export { resolveRequesterSessionRuntimeDirectories } from './requesterSessionRuntimeDirectories';

type CoordinatorInput = Parameters<typeof startDaemonConnectedServiceRuntime>[0];

// The runner diagnostic boundary retains codes, never arbitrary exception text.
function requesterAccountContextUnavailable() {
  return Object.assign(new Error('requester_account_context_unavailable'), {
    code: 'requester_account_context_unavailable' as const,
  });
}

/** Reuses ordinary Account owners with invocation custody; never publishes Bob as the daemon Account. */
export async function createRequesterSessionRuntimeContext(input: Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  /** A finite Workflow owns its admitted bootstrap until the whole Run settles. */
  bootstrapOwnership?: 'borrowed';
  providerAccountUsageStore: ProviderAccountUsageStore;
  signal?: AbortSignal;
  coordinatorInput: Omit<CoordinatorInput, 'api' | 'credentials' | 'accountSettingsSnapshot' | 'subscribeAccountSettingsSnapshot'
    | 'activeServerDir' | 'providerAccountUsageStore' | 'connectedServiceRuntimeQuotaSnapshots'
    | 'qualifiedConnectedAccountEstablishedRuntimeOwner' | 'listScheduledQualifiedConnectedAccounts'
    | 'listQualifiedConnectedAccountGroupQuotaTargets' | 'onQualifiedConnectedAccountCredentialUpdated'
    | 'daemonSessionMutationCustody' | 'connectedServiceAuthGroupPreTurnSwitchCoordinator'
    | 'connectedServicePredictiveSwitchGuard'> & Readonly<{
      connectedServiceRuntimeRegistry: NonNullable<CoordinatorInput['connectedServiceRuntimeRegistry']>;
      connectedServiceAuthGroupPreTurnSwitchCoordinator: CoordinatorInput['connectedServiceAuthGroupPreTurnSwitchCoordinator']
        & NonNullable<RequesterSessionRuntimeContext['authGroupSwitchCoordinator']>;
      connectedServicePredictiveSwitchGuard?: NonNullable<CoordinatorInput['connectedServicePredictiveSwitchGuard']>
        & NonNullable<RequesterSessionRuntimeContext['predictiveSwitchGuard']>;
    }>;
  activeServerDir: string;
  connectedServicesMaterializationBaseDir: string;
  resolveQualifiedConnectedAccountV4Support: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['resolveQualifiedConnectedAccountV4Support'];
}>): Promise<RequesterSessionRuntimeContext | null> {
  const bootstrap = input.bootstrap;
  const savedSecrets = bootstrap.savedSecretOperationContext;
  let disposed = false;
  const lifetime = new AbortController();
  // Background coordinators also supply cancellation signals. Surface their
  // failed observation to the owning loop's backoff; only explicit preparation
  // entrypoints may retain an accepted Action while Home recovers.
  const isCurrent = async (signal?: AbortSignal) => {
    if (disposed || signal?.aborted) return false;
    const readerSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    try {
      return await bootstrap.ensureAccountSettingsCurrent(readerSignal)
        && await waitForObservation(savedSecrets.isCurrent(readerSignal), readerSignal)
        && !disposed;
    } catch (error) { rethrowRequesterHomeReadFailure(error); return false; }
  };
  if (!await isCurrent(input.signal)) return null;
  const sessionFollowRuleCache = createAccountSessionFollowRuleCache({ accountId: bootstrap.attribution.accountId,
    credentials: bootstrap.credentials, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
    signal: lifetime.signal, subscribeInvalidation: bootstrap.subscribeSessionFollowRules,
    subscribeSourceInvalidation: bootstrap.subscribeSessionFollowSources });
  const sessionFollowRunRoutes = createObservedAccountRunFollowRoutes({ accountId: bootstrap.attribution.accountId,
    credentials: bootstrap.credentials, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl, signal: lifetime.signal });
  const followSourceReconciliation = createRequesterSessionFollowSourceReconciliation({ bootstrap, sessionFollowRuleCache,
    receiverRecovery: bootstrap.attribution });
  const connectedServiceRuntimeRegistry = input.coordinatorInput.connectedServiceRuntimeRegistry.scopeToRequester(target => {
    const tracked = [...input.coordinatorInput.trackedSessionsByKey.values()].find(candidate => candidate.happySessionId === target.sessionId);
    const stamp = target.requesterWorkAttributionV1 ?? tracked?.requesterWorkAttributionV1;
    if (!stamp) return Boolean(target.sessionId && target.sessionId === bootstrap.getBoundSessionId());
    return stamp?.serverId === bootstrap.attribution.serverId && stamp.accountId === bootstrap.attribution.accountId
      && stamp.machineId === bootstrap.attribution.machineId && stamp.installationId === bootstrap.attribution.installationId;
  }, bootstrap.attribution);
  const readSnapshot = () => {
    const snapshot = savedSecrets.readSnapshot();
    if (disposed || !snapshot) throw requesterAccountContextUnavailable();
    return snapshot;
  };
  const withHome = <T>(operation: () => Promise<T>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (disposed) return Promise.reject<T>(requesterAccountContextUnavailable());
    return runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl, operation);
  };
  const api = await withHome(() => ApiClient.create(bootstrap.credentials));
  const profileStore = createCliProfileStoreForOperation({ operationContext: savedSecrets, signal: lifetime.signal });
  let profileProjection: Awaited<ReturnType<typeof profileStore.readCatalog>> | null = null;
  const refreshAccountSettings = async (minSettingsVersion?: number, signal?: AbortSignal) => {
    // Readers and publication retain the admitted custody and encryption identity.
    const refreshed = await (async () => {
      if (disposed || signal?.aborted || !await bootstrap.refreshAccountSettings(minSettingsVersion, signal)) return false;
      const snapshot = readSnapshot();
      try {
        const reader = signal ? createCliProfileStoreForOperation({ operationContext: savedSecrets,
          signal: AbortSignal.any([signal, lifetime.signal]) }) : profileStore;
        const projection = await reader.readCatalog();
        if (disposed || signal?.aborted || !await savedSecrets.commitProfileCatalog({ expectedSettingsVersion: snapshot.settingsVersion,
          catalog: projection.catalog })) return false;
        profileProjection = projection;
      } catch (error) {
        if (disposed || signal?.aborted) { profileProjection = null; return false; }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        const reason: ProfileCatalogUnavailableReasonV1 = code === 'unsupported' || code === 'unauthorized' || code === 'forbidden'
          ? code : 'unreachable';
        const catalog: ProfileCatalogSnapshotV1 = { status: 'unavailable', reason };
        if (!await savedSecrets.commitProfileCatalog({ expectedSettingsVersion: snapshot.settingsVersion, catalog })) return false;
        profileProjection = { catalog, artifactsById: new Map() };
      }
      const current = readSnapshot();
      await Promise.all([
        ...(current.connectedPurposeCatalog ? [readActiveConnectedAccountCatalog({ credentials: bootstrap.credentials,
          key: 'purposes', operationContext: savedSecrets, signal: lifetime.signal })] : []),
        ...(current.connectedConfigurationCatalog ? [readActiveConnectedAccountCatalog({ credentials: bootstrap.credentials,
          key: 'configurations', operationContext: savedSecrets, signal: lifetime.signal })] : []),
      ]);
      return true;
    })().catch(error => { rethrowRequesterHomeReadFailure(error); throw error; });
    if (!refreshed || disposed || signal?.aborted) return false;
    return true;
  };
  const readAccountLaunchProfiles: RequesterSessionRuntimeContext['readAccountLaunchProfiles'] = async () => {
    const snapshot = readSnapshot();
    const projection = profileProjection;
    if (!projection || projection.catalog !== snapshot.profileCatalog) throw new ProfileCatalogUnavailableError('unavailable');
    const lastUsedProfile = await withHome(() => readAuthoringMemoryLastUsedProfile(bootstrap.credentials, lifetime.signal));
    const current = readSnapshot();
    if (current.settingsVersion !== snapshot.settingsVersion || current.profileCatalog !== projection.catalog) {
      throw new ProfileCatalogUnavailableError('unavailable');
    }
    return { ...readProfilesFromAccountSettings(readProfileSettingsFromAccountSnapshot(current), projection.artifactsById,
      { lastUsedProfile }, projection.catalog), artifactsById: projection.artifactsById };
  };
  const directMaterial = createRequesterTeamCredentialDirectMaterialClient({
    credentials: bootstrap.credentials, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
    readAccountEncryptionMode: async signal => {
      signal?.throwIfAborted();
      if (disposed) return 'unknown';
      return await withHome(() => api.getAccountEncryptionMode({ signal }));
    },
  });
  const { established, qualifiedConnectedAccountApi, purposes } = createRequesterConnectedAccountPurposeBindingRuntime({
    serverId: bootstrap.attribution.serverId, operationContext: savedSecrets, accountId: bootstrap.attribution.accountId, machineId: bootstrap.attribution.machineId,
    reloadController: pluginReloadController,
    getAccountEncryptionMode: async options => await withHome(() => api.getAccountEncryptionMode(options)),
    // New secret acquisition admits through the captured credential owner.
    isCurrent: savedSecrets.isCurrent, signal: lifetime.signal,
    allowNativeAccountCredentials: bootstrap.allowNativeAccountCredentials === true, openTeamDirect: directMaterial.open,
    resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
  });
  const providerAccountUsageStore = input.providerAccountUsageStore;
  const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
    api: { getAccountEncryptionMode: async options => {
      return await withHome(() => api.getAccountEncryptionMode(options));
    } }, credentials: bootstrap.credentials, now: () => Date.now(), randomBytes,
    serverScope: bootstrap.attribution.serverId, accountScope: bootstrap.attribution.accountId,
    writeQualifiedProviderAccountUsage: async request => {
      return await withHome(() => writeQualifiedProviderAccountUsageV4(request));
    },
  });
  const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const daemonSessionMutationCustody = await withHome(async () => createDaemonSessionMutationCustody({ credentials: bootstrap.credentials }));
  const { activeServerDir, connectedServicesMaterializationBaseDir } = resolveRequesterSessionRuntimeDirectories({
    activeServerDir: input.activeServerDir, connectedServicesMaterializationBaseDir: input.connectedServicesMaterializationBaseDir,
    attribution: bootstrap.attribution });
  let releaseConnectedAccountObservation: (() => void) | undefined;
  let coordinators: Awaited<ReturnType<typeof startDaemonConnectedServiceRuntime>> | null = null;
  let retirement: Promise<void> | undefined;
  const dispose = () => retirement ??= (async () => {
    disposed = true;
    lifetime.abort();
    sessionFollowRuleCache.dispose();
    sessionFollowRunRoutes.dispose();
    followSourceReconciliation.dispose();
    releaseConnectedAccountObservation?.();
    profileProjection = null;
    if (input.bootstrapOwnership !== 'borrowed') savedSecrets.withdrawCatalog();
    providerAccountUsagePersistence.dispose();
    coordinators?.connectedServiceQuotasCoordinator?.disposeInBandQuotaPersistence();
    stopRequesterSessionBackgroundLoops({
      loops: [coordinators?.connectedServiceRefreshLoopHandle, coordinators?.connectedServiceQuotasLoopHandle],
      onError: () => input.coordinatorInput.logger.warn('[DAEMON RUN] Requester background observation retirement failed'),
    });
    const results = await Promise.allSettled([
      ...(input.bootstrapOwnership === 'borrowed' ? [] : [bootstrap.dispose()]),
      daemonSessionMutationCustody.close(),
    ]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Requester Account runtime retirement incomplete');
  })();
  try {
    coordinators = await withHome(() => startDaemonConnectedServiceRuntime({ ...input.coordinatorInput,
    activeServerDir, api, credentials: bootstrap.credentials, accountSettingsSnapshot: () => savedSecrets.readSnapshot(),
    savedSecretOperationContext: savedSecrets,
    connectedServiceRuntimeRegistry,
    connectedServicesMaterializationBaseDir, runAccountOperation: withHome,
    allowNativeAccountState: bootstrap.allowNativeAccountCredentials === true,
    accountPluginSettingsSource: createRequesterPluginSettingsSource({ bootstrap, isCurrent, signal: lifetime.signal }),
    connectedAccountsOwner: purposes.owner,
    activatePurposeBindings: purposes.activatePurposeBindings,
    providerAccountUsageStore, connectedServiceRuntimeQuotaSnapshots, daemonSessionMutationCustody,
    qualifiedConnectedAccountEstablishedRuntimeOwner: established,
    listScheduledQualifiedConnectedAccounts: (service, signal) => purposes.listCoordinatorAccounts(signal, service),
    subscribeConnectedAccountInvalidations: listener => {
      const releasePurpose = purposes.subscribeInvalidations(listener);
      // The runtime owns one demanded source, shared by both coordinators.
      releaseConnectedAccountObservation ??= bootstrap.subscribeConnectedAccounts(event => {
        purposes.invalidate(event, event.resetQuotaSchedule ? 'requester-recovery' : 'requester-account-changes');
      });
      return releasePurpose;
    },
    subscribeAccountSettingsSnapshot: bootstrap.subscribeAccountSettings,
    listQualifiedConnectedAccountGroupQuotaTargets: purposes.listGroupQuotaTargets, onQualifiedConnectedAccountCredentialUpdated: () => purposes.invalidate(),
    }));
    if (disposed || input.signal?.aborted) {
      await dispose();
      return null;
    }
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Requester Account runtime startup failed'); }
    throw error;
  }
  const createManagedProviderAccountAuthority: RequesterSessionRuntimeContext['createManagedProviderAccountAuthority'] = operationAuthority => Object.freeze({
    readCredentials: async () => bootstrap.credentials,
    operationAuthority: operationAuthority.forPurposeBindingOwner(purposes),
    connectedAccountsOwner: purposes.owner,
  });
  return Object.freeze({ bootstrap, isCurrent, api, sessionFollowRuleCache, sessionFollowRunRoutes,
    bindSessionFollowSourceReconciliation: followSourceReconciliation.bind,
    readAccountSettingsSnapshot: readSnapshot, refreshAccountSettings, readAccountLaunchProfiles,
    subscribeAccountSettingsSnapshot: (listener: () => void, keys: ActiveAccountSettingsKeys) => {
      if (disposed) throw requesterAccountContextUnavailable();
      return bootstrap.subscribeAccountSettings(listener, keys);
    },
    activeServerDir, connectedServicesMaterializationBaseDir, qualifiedConnectedAccountApi,
    connectedAccountsOwner: purposes.owner,
    createManagedProviderAccountAuthority,
    resolveCurrentRequestAuthBinding: purposes.resolveCurrentRequestAuthBinding,
    materializeRequestAuthBearer: purposes.materializeRequestAuthBearer,
    resolveCurrentSessionPurposeBindingSnapshot: purposes.resolveCurrentSessionPurposeBindingSnapshot,
    qualifiedConnectedAccountEstablishedRuntimeOwner: established, daemonSessionMutationCustody,
    providerAccountUsageStore, providerAccountUsagePersistence, connectedServiceRuntimeQuotaSnapshots,
    connectedServiceRuntimeRegistry,
    connectedServiceRefreshCoordinator: coordinators.connectedServiceRefreshCoordinator,
    connectedServiceQuotasCoordinator: coordinators.connectedServiceQuotasCoordinator,
    authGroupSwitchCoordinator: input.coordinatorInput.connectedServiceAuthGroupPreTurnSwitchCoordinator,
    predictiveSwitchGuard: input.coordinatorInput.connectedServicePredictiveSwitchGuard ?? undefined,
    resolveManagedPurposeBindingIntent: purposes.resolveBindingIntent,
    resolveManagedPurposeBindingIntentSelection: purposes.resolveBindingIntentSelection,
    activateSessionPurposeBindings: purposes.activateSessionPurposeBindings, activatePurposeBindings: purposes.activatePurposeBindings,
    dispose,
  });
}
