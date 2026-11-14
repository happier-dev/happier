import { createCliPrivateLabelActionOpener } from '@/api/privateLabels';
import { createConnectedAccountActionTeamResourceCatalogReader } from './actionTeamResourceCatalog';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createRequesterTeamCredentialDirectMaterialClient } from '../directMaterial/teamCredentialDirectMaterialClient';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ApiClient } from '@/api/api';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountDaemonConfigurationOwner } from '../ConnectedAccountDaemonRuntime';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './createDaemonConnectedAccountPurposeBindingRuntime';

/** One requester-qualified purpose composition for finite Actions and retained Sessions. */
export function createRequesterConnectedAccountPurposeBindingRuntime(input: Readonly<{
  operationContext: SavedSecretOperationContextV1;
  accountId: string;
  serverId: string;
  machineId?: string;
  reloadController: Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'tryAcquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'>;
  nativeReloadController?: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['nativeReloadController'];
  getAccountEncryptionMode: ApiClient['getAccountEncryptionMode'];
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
  resolveQualifiedConnectedAccountV4Support: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['resolveQualifiedConnectedAccountV4Support'];
  allowNativeAccountCredentials: boolean;
  openTeamDirect?: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['openTeamDirect'];
  executeTeamCredentialBrokerAction?: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['executeTeamCredentialBrokerAction'];
  resolvePlatformOperationRequestHeaders?: Parameters<typeof createRequesterTeamCredentialDirectMaterialClient>[0]['resolvePlatformOperationRequestHeaders'];
}>) {
  const operationContext = input.operationContext;
  const credentials = operationContext.credentials;
  const withHome = async <T>(read: () => Promise<T>, signal?: AbortSignal) => {
    input.signal?.throwIfAborted();
    signal?.throwIfAborted();
    const result = await runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, read);
    input.signal?.throwIfAborted();
    signal?.throwIfAborted();
    return result;
  };
  const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials, operationContext });
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
    getAccountEncryptionMode: input.getAccountEncryptionMode, operationContext,
    secrets: createAccountSettingsConnectedAccountSecrets({ expectedScopeKey: runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl,
      () => resolveAccountSettingsScopeKey(credentials)), operationContext }),
  });
  const configurationOwner = createConnectedAccountDaemonConfigurationOwner({ reloadController: input.reloadController,
    persistence: persistence.configuration });
  const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ reloadController: input.reloadController,
    credentials, getAccountEncryptionMode: async (signal, options) => await withHome(() => input.getAccountEncryptionMode({ ...options, signal })),
    isAccountRuntimeCurrent: input.isCurrent, runAccountOperation: withHome,
    configuration: persistence.configuration, configurationOwner });
  const assertCurrent = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (input.signal?.aborted || !operationContext.readSnapshot()) throw Object.assign(new Error('requester_account_context_unavailable'), { code: 'requester_account_context_unavailable' });
  };
  const qualifiedConnectedAccountApi = {
    readGroup: async ({ service, groupId, signal }: Parameters<typeof readQualifiedConnectedAccountGroupV4>[0]['group'] & { signal?: AbortSignal }) => {
      await assertCurrent(signal);
      return await withHome(() => readQualifiedConnectedAccountGroupV4({ token: credentials.token, group: { service, groupId }, ...(signal ? { signal } : {}) }));
    },
    listAccounts: async ({ service, signal }: Pick<Parameters<typeof listQualifiedConnectedAccountsV4>[0], 'service' | 'signal'>) => {
      await assertCurrent(signal);
      return await withHome(() => listQualifiedConnectedAccountsV4({ token: credentials.token, service,
        requestPurpose: 'connected-accounts:requester-qualification', ...(signal ? { signal } : {}) }));
    },
  };
  const directMaterial = createRequesterTeamCredentialDirectMaterialClient({ credentials,
    serverHttpBaseUrl: operationContext.serverHttpBaseUrl,
    resolvePlatformOperationRequestHeaders: input.resolvePlatformOperationRequestHeaders,
    readAccountEncryptionMode: signal => withHome(() => input.getAccountEncryptionMode({ usage: 'fresh-authority', signal }), signal),
  });
  const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
    credentialOwnerAccountId: input.accountId, workerMachineId: input.machineId, store, reloadController: input.reloadController,
    nativeReloadController: input.nativeReloadController,
    listTeamResources: createConnectedAccountActionTeamResourceCatalogReader({
      privateLabelOpen: createCliPrivateLabelActionOpener(credentials.encryption),
      homeDomainAction: (...args) => createAccountServerActionDeps({ token: credentials.token, credentials,
        serverId: input.serverId, serverHttpBaseUrl: operationContext.serverHttpBaseUrl }).homeDomainAction!(...args),
    }),
    allowNativeAccountCredentials: input.allowNativeAccountCredentials,
    openTeamDirect: input.openTeamDirect ?? (request => directMaterial.open(request)),
    executeTeamCredentialBrokerAction: input.executeTeamCredentialBrokerAction,
    resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
    resolveConnectedAccountEndpoints: async request => await withHome(() => established.readConfiguredEndpoints(request)),
    qualifiedApi: {
      listAccountsForServices: async (services, signal) => {
        await assertCurrent(signal);
        return await withHome(() => listQualifiedConnectedAccountsV4({ token: credentials.token, services, signal,
          requestPurpose: 'connected-accounts:requester-coordinator' }));
      },
      listAccounts: async (service, signal) => await qualifiedConnectedAccountApi.listAccounts({ service, signal }),
      listGroups: async (service, signal) => {
        await assertCurrent(signal);
        return await withHome(() => listQualifiedConnectedAccountGroupsV4({ token: credentials.token, service, signal }));
      },
      readGroup: async (group, signal) => await qualifiedConnectedAccountApi.readGroup({ ...group, signal }),
    },
  });
  return { store, established, qualifiedConnectedAccountApi, purposes };
}
