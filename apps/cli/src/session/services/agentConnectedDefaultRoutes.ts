import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import type { StoredCredentials } from '@/persistence';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveSpawnConnectedServicesDefaultDisposition, type SpawnConnectedServicesDefaultDisposition } from './spawnConnectedServicesDefaults';

export type AgentConnectedDefaultRoute = SpawnConnectedServicesDefaultDisposition['kind'];

/**
 * The Account's connected-service default for each Agent, as run admission
 * decides it: one purpose-catalog read, then the spawn default owner per Agent.
 * Readiness readers (the background-task candidates and the Agent backend
 * inventory) consume this so a connected route counts as signed in the same way
 * everywhere. Without credentials there is no catalog and nothing is decided.
 */
export async function readAgentConnectedDefaultRoutes(params: Readonly<{
  credentials?: StoredCredentials;
  settings: AccountSettings;
  agentIds: readonly string[];
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  authorizeRequest?: Parameters<typeof readActiveConnectedAccountCatalog>[0]['authorizeRequest'];
}>) {
  const purposeCatalog = params.credentials ? await readActiveConnectedAccountCatalog({
    credentials: params.credentials, key: 'purposes', signal: params.signal,
    operationContext: params.operationContext, authorizeRequest: params.authorizeRequest,
    readMode: 'admitted',
  }) : null;
  const dispositions = new Map<string, SpawnConnectedServicesDefaultDisposition>();
  if (purposeCatalog) {
    for (const agentId of params.agentIds) {
      dispositions.set(agentId, resolveSpawnConnectedServicesDefaultDisposition({
        accountSettings: params.settings, agentId, purposeCatalog,
      }));
    }
  }
  return { purposeCatalog, dispositions };
}
