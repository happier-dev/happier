import type { AccountSettings } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from './switchSessionConnectedServiceAuth';

export type ConnectedServiceRuntimeAuthSelectionBase = Readonly<{
  serviceId: string;
  binding: unknown;
  profileId: string;
  groupId?: string;
  activeProfileId?: string;
  fallbackProfileId?: string;
  generation?: number;
  record: unknown;
}>;

export type ConnectedServiceRuntimeAuthSelectionMaterializerParams = Readonly<{
  credentials: Credentials;
  api: ApiClient;
  activeServerDir?: string;
  input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
  baseSelection: ConnectedServiceRuntimeAuthSelectionBase;
  accountSettings?: AccountSettings | null;
  processEnv?: NodeJS.ProcessEnv;
}>;

export type ConnectedServiceRuntimeAuthSelectionMaterializer = (
  params: ConnectedServiceRuntimeAuthSelectionMaterializerParams,
) => Promise<unknown | null>;
