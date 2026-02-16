import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

import { parseConnectedServicesBindings } from './parseConnectedServicesBindings';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { materializeConnectedServicesForSpawn } from './materialize/materializeConnectedServicesForSpawn';

export async function resolveConnectedServiceAuthForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  connectedServicesBindingsRaw: unknown;
  materializationKey: string;
  baseDir: string;
  credentials: Credentials;
  api: ApiClient;
}>): Promise<Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}> | null> {
  const bindings = parseConnectedServicesBindings(params.connectedServicesBindingsRaw);
  if (bindings.length === 0) return null;

  const recordsByServiceId: Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1> =
    await resolveConnectedServiceCredentials({
      credentials: params.credentials,
      api: params.api,
      bindings,
    });

  return await materializeConnectedServicesForSpawn({
    agentId: params.agentId,
    materializationKey: params.materializationKey,
    baseDir: params.baseDir,
    recordsByServiceId,
  });
}
