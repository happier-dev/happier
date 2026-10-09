import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4, writeQualifiedProviderAccountUsageV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountDaemonConfigurationOwner } from '../connectedServices/ConnectedAccountDaemonRuntime';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { refreshActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createHttpTeamCredentialDirectMaterialClient } from '../connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { startDaemonConnectedServiceRuntime } from '../startup/startDaemonRuntimeBootstrap';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from './requesterSessionCredentials';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import { createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import { ProfileCatalogUnavailableError, readProfilesFromAccountSettings,
  readProfileSettingsFromAccountSnapshot } from '@/settings/profiles/readProfilesFromAccountSettings';
import { readAuthoringMemoryLastUsedProfile } from '@/settings/profiles/readAuthoringMemoryLastUsedProfile';
import type { ProfileCatalogSnapshotV1, ProfileCatalogUnavailableReasonV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';

type CoordinatorInput = Parameters<typeof startDaemonConnectedServiceRuntime>[0];

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
  coordinatorInput: Omit<CoordinatorInput, 'api' | 'credentials' | 'accountSettingsSnapshot'
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
  const isCurrent = async () => !disposed && await savedSecrets.isCurrent();
  if (!await isCurrent()) return null;
  const connectedServiceRuntimeRegistry = input.coordinatorInput.connectedServiceRuntimeRegistry.scopeToRequester(target => {
    const tracked = [...input.coordinatorInput.pidToTrackedSession.values()].find(candidate => candidate.happySessionId === target.sessionId);
    const stamp = target.requesterWorkAttributionV1 ?? tracked?.requesterWorkAttributionV1;
    if (!stamp) return Boolean(target.sessionId && target.sessionId === bootstrap.getBoundSessionId());
    return stamp?.serverId === bootstrap.attribution.serverId && stamp.accountId === bootstrap.attribution.accountId
      && stamp.machineId === bootstrap.attribution.machineId && stamp.installationId === bootstrap.attribution.installationId;
  }, bootstrap.attribution);
  const readSnapshot = () => {
    const snapshot = savedSecrets.readSnapshot();
    if (disposed || !snapshot) throw new Error('requester_account_context_unavailable');
    return snapshot;
  };
  const withHome = <T>(operation: () => Promise<T>) => {
    if (disposed) return Promise.reject<T>(new Error('requester_account_context_unavailable'));
    return runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl, operation);
  };
  const api = await withHome(() => ApiClient.create(bootstrap.credentials));
  const listeners = new Set<() => void>();
  const profileStore = createCliProfileStoreForOperation({ operationContext: savedSecrets });
  let profileProjection: Awaited<ReturnType<typeof profileStore.readCatalog>> | null = null;
  const refreshAccountSettings = async (minSettingsVersion?: number) => {
    if (!await isCurrent()) return false;
    const snapshot = await withHome(() => bootstrapAccountSettingsContext({ credentials: bootstrap.credentials,
      mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
      ...(minSettingsVersion === undefined ? {} : { minSettingsVersion }),
      shouldCommit: () => savedSecrets.readSnapshot() !== null }));
    if (snapshot.source !== 'network' || !await savedSecrets.replaceAccountSettings(snapshot)) return false;
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
      ...(current.connectedPurposeCatalog ? [refreshActiveConnectedAccountCatalog({ credentials: bootstrap.credentials,
        key: 'purposes', operationContext: savedSecrets })] : []),
      ...(current.connectedConfigurationCatalog ? [refreshActiveConnectedAccountCatalog({ credentials: bootstrap.credentials,
        key: 'configurations', operationContext: savedSecrets })] : []),
    ]);
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
  const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials: bootstrap.credentials,
    operationContext: savedSecrets,
    subscribe: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
  });
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials: bootstrap.credentials,
    getAccountEncryptionMode: async () => await withHome(() => api.getAccountEncryptionMode()),
    operationContext: savedSecrets,
    secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(bootstrap.credentials), operationContext: savedSecrets }),
  });
  const configurationOwner = createConnectedAccountDaemonConfigurationOwner({ reloadController: pluginReloadController, persistence: persistence.configuration });
  const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ reloadController: pluginReloadController,
    credentials: bootstrap.credentials, getAccountEncryptionMode: async signal => await withHome(() => api.getAccountEncryptionMode({ signal })),
    isAccountRuntimeCurrent: isCurrent,
    runAccountOperation: withHome,
    configuration: persistence.configuration, configurationOwner });
  const token = bootstrap.credentials.token;
  const qualifiedConnectedAccountApi: RequesterSessionRuntimeContext['qualifiedConnectedAccountApi'] = {
    readGroup: async ({ service, groupId, signal }) => { if (!await isCurrent()) throw new Error('requester_account_context_unavailable');
      return await withHome(() => readQualifiedConnectedAccountGroupV4({ token, group: { service, groupId }, ...(signal ? { signal } : {}) })); },
    listAccounts: async ({ service, signal }) => { if (!await isCurrent()) throw new Error('requester_account_context_unavailable');
      return await withHome(() => listQualifiedConnectedAccountsV4({ token, service, ...(signal ? { signal } : {}) })); },
  };
  const directMaterial = createHttpTeamCredentialDirectMaterialClient({ token, serverUrl: bootstrap.serverHttpBaseUrl,
    readRecipientEncryptionMaterial: async signal => { if (!await isCurrent()) return { mode: 'e2ee_unavailable' };
      const mode = await withHome(() => api.getAccountEncryptionMode({ signal }));
      const encryption = bootstrap.credentials.encryption;
      return mode === 'plain' ? { mode: 'plain' } : mode === 'e2ee' && encryption
        ? { mode: 'e2ee', secretKeyOrSeed: encryption.type === 'dataKey' ? encryption.machineKey : encryption.secret }
        : { mode: 'e2ee_unavailable' }; },
  });
  const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
    workerMachineId: bootstrap.attribution.machineId, store, reloadController: pluginReloadController,
    allowNativeAccountCredentials: false, openTeamDirect: directMaterial.open,
    resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
    resolveConnectedAccountEndpoints: async request => await withHome(() => established.readConfiguredEndpoints(request)),
    qualifiedApi: { listAccounts: async (service, signal) => await qualifiedConnectedAccountApi.listAccounts({ service, signal }),
      listGroups: async (service, signal) => {
        if (!await isCurrent()) throw new Error('requester_account_context_unavailable');
        return await withHome(() => listQualifiedConnectedAccountGroupsV4({ token, service, signal }));
      },
      readGroup: async (group, signal) => await qualifiedConnectedAccountApi.readGroup({ ...group, signal }) },
  });
  const providerAccountUsageStore = createProviderAccountUsageStore();
  const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
    api: { getAccountEncryptionMode: async () => {
      if (!await isCurrent()) throw new Error('requester_account_context_unavailable');
      return await withHome(() => api.getAccountEncryptionMode());
    } }, credentials: bootstrap.credentials, now: () => Date.now(), randomBytes,
    serverScope: bootstrap.attribution.serverId, accountScope: bootstrap.attribution.accountId,
    writeQualifiedProviderAccountUsage: async request => {
      if (!await isCurrent()) throw new Error('requester_account_context_unavailable');
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
    profileProjection = null;
    savedSecrets.withdrawCatalog();
    providerAccountUsagePersistence.dispose();
    listeners.clear();
    coordinators?.connectedServiceRefreshLoopHandle?.stop();
    coordinators?.connectedServiceQuotasCoordinator?.disposeInBandQuotaPersistence();
    const results = await Promise.allSettled([
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
    allowNativeAccountState: false,
    connectedAccountsOwner: purposes.owner,
    providerAccountUsageStore, connectedServiceRuntimeQuotaSnapshots, daemonSessionMutationCustody,
    qualifiedConnectedAccountEstablishedRuntimeOwner: established, listScheduledQualifiedConnectedAccounts: purposes.listCoordinatorAccounts,
    listQualifiedConnectedAccountGroupQuotaTargets: purposes.listGroupQuotaTargets, onQualifiedConnectedAccountCredentialUpdated: purposes.invalidate,
    }));
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Requester Account runtime startup failed'); }
    throw error;
  }
  if (!await isCurrent()) {
    await dispose();
    return null;
  }
  return Object.freeze({ bootstrap, api, readAccountSettingsSnapshot: readSnapshot, refreshAccountSettings, readAccountLaunchProfiles,
    subscribeAccountSettingsSnapshot: (listener: () => void) => {
      if (disposed) throw new Error('requester_account_context_unavailable');
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
