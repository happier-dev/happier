import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { writeQualifiedProviderAccountUsageV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { createDaemonConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createHttpTeamCredentialDirectMaterialClient } from '../connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { startDaemonConnectedServiceRuntime } from '../startup/startDaemonRuntimeBootstrap';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from './requesterSessionCredentials';
import { rethrowRequesterHomeReadFailure, runWithRequesterSessionCurrentnessCheckpoint } from "@/daemon/sessionEncryption/requesterCurrentness";
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import { createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import { ProfileCatalogUnavailableError, readProfilesFromAccountSettings,
  readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { readAuthoringMemoryLastUsedProfile } from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';
import type { ProfileCatalogSnapshotV1, ProfileCatalogUnavailableReasonV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { createAccountSessionFollowRuleCache } from '@/agent/runtime/session/follow/accountSessionFollowRuleCache';
import { createRequesterSessionFollowSourceReconciliation } from './requesterSessionFollowSourceReconciliation';
import { logger } from '@/ui/logger';

type CoordinatorInput = Parameters<typeof startDaemonConnectedServiceRuntime>[0];

// The runner diagnostic boundary retains codes, never arbitrary exception text.
function requesterAccountContextUnavailable() {
  return Object.assign(new Error('requester_account_context_unavailable'), {
    code: 'requester_account_context_unavailable' as const,
  });
}

/** Same Account-qualified native roots for runtime and exact retained-resource cleanup. */
export function resolveRequesterSessionRuntimeDirectories(input: Readonly<{
  activeServerDir: string; connectedServicesMaterializationBaseDir: string;
  attribution: Pick<RequesterWorkAttributionV1, 'accountId'>;
}>): Readonly<{ activeServerDir: string; connectedServicesMaterializationBaseDir: string }> {
  const accountPath = `account-${encodeURIComponent(input.attribution.accountId)}`;
  return { activeServerDir: join(input.activeServerDir, 'requester-accounts', accountPath),
    connectedServicesMaterializationBaseDir: join(input.connectedServicesMaterializationBaseDir, 'requester-accounts', accountPath) };
}

/** Reuses ordinary Account owners with invocation custody; never publishes Bob as the daemon Account. */
export async function createRequesterSessionRuntimeContext(input: Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
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
  // Settings recovery and requester qualification form one read-only guard.
  // Reuse its proof here; later publication and effect guards still start fresh.
  const isCurrent = async (signal?: AbortSignal) => runWithRequesterSessionCurrentnessCheckpoint(async () => {
    if (disposed || signal?.aborted) return false;
    const readerSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    try {
      return await bootstrap.ensureAccountSettingsCurrent(readerSignal)
        && await waitForObservation(savedSecrets.isCurrent(), readerSignal)
        && await bootstrap.ensureAccountSettingsCurrent(readerSignal) && !disposed;
    } catch (error) { rethrowRequesterHomeReadFailure(error); return false; }
  }, { readOnly: true });
  if (!await isCurrent(input.signal)) return null;
  const sessionFollowRuleCache = createAccountSessionFollowRuleCache({ accountId: bootstrap.attribution.accountId,
    credentials: bootstrap.credentials, serverHttpBaseUrl: bootstrap.serverHttpBaseUrl,
    signal: lifetime.signal, isCurrent, subscribeInvalidation: bootstrap.subscribeSessionFollowRules });
  const followSourceReconciliation = createRequesterSessionFollowSourceReconciliation({ bootstrap, sessionFollowRuleCache, isCurrent });
  const connectedServiceRuntimeRegistry = input.coordinatorInput.connectedServiceRuntimeRegistry.scopeToRequester(target => {
    const tracked = [...input.coordinatorInput.pidToTrackedSession.values()].find(candidate => candidate.happySessionId === target.sessionId);
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
  const withHome = <T>(operation: () => Promise<T>) => {
    if (disposed) return Promise.reject<T>(requesterAccountContextUnavailable());
    return runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl, operation);
  };
  const api = await withHome(() => ApiClient.create(bootstrap.credentials));
  const listeners = new Set<() => void>();
  const releaseSettingsPublication = bootstrap.subscribeAccountSettings(() => {
    for (const listener of listeners) listener();
  });
  const profileStore = createCliProfileStoreForOperation({ operationContext: savedSecrets });
  let profileProjection: Awaited<ReturnType<typeof profileStore.readCatalog>> | null = null;
  const refreshAccountSettings = async (minSettingsVersion?: number, signal?: AbortSignal) => {
    // Catalog readers and commits consume one refresh's requester observation.
    // Keep publication outside it so Home revocation during a read still wins.
    const refreshed = await runWithRequesterSessionCurrentnessCheckpoint(async () => {
      if (disposed || !await bootstrap.refreshAccountSettings(minSettingsVersion, signal) || !await isCurrent(signal)) return false;
      const snapshot = readSnapshot();
      try {
        const projection = await profileStore.readCatalog();
        if (!await isCurrent() || !await savedSecrets.commitProfileCatalog({ expectedSettingsVersion: snapshot.settingsVersion,
          catalog: projection.catalog })) return false;
        profileProjection = projection;
      } catch (error) {
        if (!await isCurrent()) { profileProjection = null; return false; }
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
          key: 'purposes', operationContext: savedSecrets })] : []),
        ...(current.connectedConfigurationCatalog ? [readActiveConnectedAccountCatalog({ credentials: bootstrap.credentials,
          key: 'configurations', operationContext: savedSecrets })] : []),
      ]);
      return true;
    }).catch(error => { rethrowRequesterHomeReadFailure(error); throw error; });
    if (!refreshed || !await isCurrent(signal)) return false;
    for (const listener of listeners) listener();
    return true;
  };
  const readAccountLaunchProfiles: RequesterSessionRuntimeContext['readAccountLaunchProfiles'] = async () => {
    if (!await isCurrent()) throw new ProfileCatalogUnavailableError('unavailable');
    const snapshot = readSnapshot();
    const projection = profileProjection;
    if (!projection || projection.catalog !== snapshot.profileCatalog) throw new ProfileCatalogUnavailableError('unavailable');
    const lastUsedProfile = await withHome(() => readAuthoringMemoryLastUsedProfile(bootstrap.credentials));
    if (!await isCurrent()) throw new ProfileCatalogUnavailableError('unavailable');
    const current = readSnapshot();
    if (current.settingsVersion !== snapshot.settingsVersion || current.profileCatalog !== projection.catalog) {
      throw new ProfileCatalogUnavailableError('unavailable');
    }
    return { ...readProfilesFromAccountSettings(readProfileSettingsFromAccountSnapshot(current), projection.artifactsById,
      { lastUsedProfile }, projection.catalog), artifactsById: projection.artifactsById };
  };
  const token = bootstrap.credentials.token;
  const directMaterial = createHttpTeamCredentialDirectMaterialClient({ token, serverUrl: bootstrap.serverHttpBaseUrl,
    readRecipientEncryptionMaterial: async signal => { if (!await isCurrent(signal)) return { mode: 'e2ee_unavailable' };
      const mode = await withHome(() => api.getAccountEncryptionMode({ signal }));
      const encryption = bootstrap.credentials.encryption;
      return mode === 'plain' ? { mode: 'plain' } : mode === 'e2ee' && encryption
        ? { mode: 'e2ee', secretKeyOrSeed: encryption.type === 'dataKey' ? encryption.machineKey : encryption.secret }
        : { mode: 'e2ee_unavailable' }; },
  });
  const { store, established, qualifiedConnectedAccountApi, purposes } = createRequesterConnectedAccountPurposeBindingRuntime({
    operationContext: savedSecrets, accountId: bootstrap.attribution.accountId, machineId: bootstrap.attribution.machineId,
    reloadController: pluginReloadController,
    getAccountEncryptionMode: async options => await withHome(() => api.getAccountEncryptionMode(options)),
    isCurrent, subscribe: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    allowNativeAccountCredentials: bootstrap.allowNativeAccountCredentials === true, openTeamDirect: directMaterial.open,
    resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
  });
  const providerAccountUsageStore = input.providerAccountUsageStore;
  const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
    api: { getAccountEncryptionMode: async options => {
      if (!await isCurrent()) throw requesterAccountContextUnavailable();
      return await withHome(() => api.getAccountEncryptionMode(options));
    } }, credentials: bootstrap.credentials, now: () => Date.now(), randomBytes,
    serverScope: bootstrap.attribution.serverId, accountScope: bootstrap.attribution.accountId,
    writeQualifiedProviderAccountUsage: async request => {
      if (!await isCurrent()) throw requesterAccountContextUnavailable();
      return await withHome(() => writeQualifiedProviderAccountUsageV4(request));
    },
  });
  const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const daemonSessionMutationCustody = await withHome(async () => createDaemonSessionMutationCustody({ credentials: bootstrap.credentials }));
  const { activeServerDir, connectedServicesMaterializationBaseDir } = resolveRequesterSessionRuntimeDirectories({
    activeServerDir: input.activeServerDir, connectedServicesMaterializationBaseDir: input.connectedServicesMaterializationBaseDir,
    attribution: bootstrap.attribution });
  let coordinators: Awaited<ReturnType<typeof startDaemonConnectedServiceRuntime>> | null = null;
  let retirement: Promise<void> | undefined;
  const dispose = () => retirement ??= (async () => {
    disposed = true;
    lifetime.abort();
    sessionFollowRuleCache.dispose();
    followSourceReconciliation.dispose();
    releaseSettingsPublication();
    profileProjection = null;
    savedSecrets.withdrawCatalog();
    providerAccountUsagePersistence.dispose();
    listeners.clear();
    coordinators?.connectedServiceQuotasCoordinator?.disposeInBandQuotaPersistence();
    const results = await Promise.allSettled([
      bootstrap.dispose(),
      Promise.resolve(coordinators?.connectedServiceRefreshLoopHandle?.stop()),
      Promise.resolve(coordinators?.connectedServiceQuotasLoopHandle?.stop()), daemonSessionMutationCustody.close(),
    ]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Requester Account runtime retirement incomplete');
  })();
  try {
    coordinators = await withHome(() => startDaemonConnectedServiceRuntime({ ...input.coordinatorInput,
    activeServerDir, api, credentials: bootstrap.credentials, accountSettingsSnapshot: () => savedSecrets.readSnapshot(),
    connectedServiceRuntimeRegistry,
    connectedServicesMaterializationBaseDir, isAccountRuntimeCurrent: isCurrent, runAccountOperation: withHome,
    allowNativeAccountState: bootstrap.allowNativeAccountCredentials === true,
    connectedAccountsOwner: purposes.owner,
    activatePurposeBindings: purposes.activatePurposeBindings,
    providerAccountUsageStore, connectedServiceRuntimeQuotaSnapshots, daemonSessionMutationCustody,
    qualifiedConnectedAccountEstablishedRuntimeOwner: established,
    listScheduledQualifiedConnectedAccounts: service => purposes.listCoordinatorAccounts(undefined, service),
    subscribeConnectedAccountInvalidations: listener => {
      const releasePurpose = purposes.subscribeInvalidations(listener);
      const releaseObservation = bootstrap.subscribeConnectedAccounts(event => { purposes.invalidate(event); });
      return () => { releaseObservation(); releasePurpose(); };
    },
    subscribeAccountSettingsSnapshot: listener => {
      const subscription = store.subscribe(listener);
      return () => subscription.dispose();
    },
    listQualifiedConnectedAccountGroupQuotaTargets: purposes.listGroupQuotaTargets, onQualifiedConnectedAccountCredentialUpdated: () => purposes.invalidate(),
    }));
    if (!await isCurrent(input.signal)) {
      await dispose();
      return null;
    }
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Requester Account runtime startup failed'); }
    throw error;
  }
  return Object.freeze({ bootstrap, isCurrent, api, sessionFollowRuleCache,
    bindSessionFollowSourceReconciliation: followSourceReconciliation.bind,
    readAccountSettingsSnapshot: readSnapshot, refreshAccountSettings, readAccountLaunchProfiles,
    subscribeAccountSettingsSnapshot: (listener: () => void) => {
      if (disposed) throw requesterAccountContextUnavailable();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activeServerDir, connectedServicesMaterializationBaseDir, qualifiedConnectedAccountApi,
    connectedAccountsOwner: purposes.owner,
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
    activateSessionPurposeBindings: purposes.activateSessionPurposeBindings, activatePurposeBindings: purposes.activatePurposeBindings,
    dispose,
  });
}
