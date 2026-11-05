import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ApiClient } from '@/api/api';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '../qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountDaemonConfigurationOwner } from '../ConnectedAccountDaemonRuntime';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore, type ConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './createDaemonConnectedAccountPurposeBindingRuntime';

/** One requester-qualified purpose composition for finite Actions and retained Sessions. */
export function createRequesterConnectedAccountPurposeBindingRuntime(input: Readonly<{
  operationContext: SavedSecretOperationContextV1;
  accountId: string;
  machineId?: string;
  reloadController: Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'tryAcquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'>;
  getAccountEncryptionMode: ApiClient['getAccountEncryptionMode'];
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  subscribe?: ConnectedAccountPurposeBindingStore['subscribe'];
  resolveQualifiedConnectedAccountV4Support: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['resolveQualifiedConnectedAccountV4Support'];
  allowNativeAccountCredentials: boolean;
  openTeamDirect?: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['openTeamDirect'];
}>) {
  const operationContext = input.operationContext;
  const credentials = operationContext.credentials;
  const withHome = <T>(read: () => Promise<T>) => runWithServerHttpBaseUrl(operationContext.serverHttpBaseUrl, read);
  const store = createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials, operationContext,
    ...(input.subscribe ? { subscribe: input.subscribe } : {}) });
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
    if (!await input.isCurrent(signal)) throw Object.assign(new Error('requester_account_context_unavailable'), { code: 'requester_account_context_unavailable' });
  };
  const qualifiedConnectedAccountApi = {
    readGroup: async ({ service, groupId, signal }: Parameters<typeof readQualifiedConnectedAccountGroupV4>[0]['group'] & { signal?: AbortSignal }) => {
      await assertCurrent(signal);
      return await withHome(() => readQualifiedConnectedAccountGroupV4({ token: credentials.token, group: { service, groupId }, ...(signal ? { signal } : {}) }));
    },
    listAccounts: async ({ service, signal }: Pick<Parameters<typeof listQualifiedConnectedAccountsV4>[0], 'service' | 'signal'>) => {
      await assertCurrent(signal);
      return await withHome(() => listQualifiedConnectedAccountsV4({ token: credentials.token, service, ...(signal ? { signal } : {}) }));
    },
  };
  const purposes = createDaemonConnectedAccountPurposeBindingRuntime({ establishedRuntimeOwner: established,
    credentialOwnerAccountId: input.accountId, workerMachineId: input.machineId, store, reloadController: input.reloadController,
    allowNativeAccountCredentials: input.allowNativeAccountCredentials,
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
    resolveQualifiedConnectedAccountV4Support: input.resolveQualifiedConnectedAccountV4Support,
    resolveConnectedAccountEndpoints: async request => await withHome(() => established.readConfiguredEndpoints(request)),
    qualifiedApi: {
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
