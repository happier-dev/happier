import type {
  QualifiedConnectedAccountGroupV4,
  QualifiedConnectedAccountProfileV4,
  QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';

import {
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountGroupV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { observeCurrentConnectedServiceMaterializationPhase } from './materialize/materializationPhase';

export type ConnectedServiceQualifiedAuthGroupApi = Readonly<{
  readGroup: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    groupId: string;
    signal?: AbortSignal;
  }>) => Promise<QualifiedConnectedAccountGroupV4 | null>;
  listAccounts: (params: Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    service: QualifiedConnectedAccountServiceRef;
    accounts: readonly QualifiedConnectedAccountProfileV4[];
  }>>;
}>;

/** Spawn metadata uses the same qualified Home HTTP boundary for every binding. */
export function createSpawnBindingAccountApi(params: Readonly<{
  token: string;
  api?: ConnectedServiceQualifiedAuthGroupApi;
}>): ConnectedServiceQualifiedAuthGroupApi {
  const api: ConnectedServiceQualifiedAuthGroupApi = params.api ?? {
    readGroup: ({ service, groupId, signal }) => readQualifiedConnectedAccountGroupV4({
      token: params.token,
      group: { service, groupId },
      ...(signal ? { signal } : {}),
    }),
    listAccounts: ({ service, signal }) => listQualifiedConnectedAccountsV4({
      token: params.token,
      service,
      ...(signal ? { signal } : {}),
    }),
  };
  return {
    readGroup: input => observeCurrentConnectedServiceMaterializationPhase(
      'binding_group_read', () => api.readGroup(input),
    ),
    listAccounts: input => observeCurrentConnectedServiceMaterializationPhase(
      'binding_account_list', () => api.listAccounts(input),
    ),
  };
}
