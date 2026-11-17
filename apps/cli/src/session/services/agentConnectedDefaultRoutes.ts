import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import type { StoredCredentials } from '@/persistence';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readAgentPurposeDefaults, resolveSpawnConnectedServicesDefaultDisposition, type SpawnConnectedServicesDefaultDisposition } from './spawnConnectedServicesDefaults';

export type CliConnectedDefaultSelection = 'connectedAccount' | 'native' | null;

/** The CLI's own declared auth purposes, independent of availability of their material. */
export function resolveCliConnectedDefaultSelection(params: Parameters<typeof readAgentPurposeDefaults>[0]): CliConnectedDefaultSelection {
  if (!params.purposeCatalog || params.purposeCatalog.status !== 'ready' || params.purposeCatalog.record.key !== 'purposes') return null;
  const defaults = readAgentPurposeDefaults({ ...params, purposeDemand: 'agent' });
  return defaults.some(entry => entry.target !== null || entry.teamResource !== null) ? 'connectedAccount' : 'native';
}

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
  const selections = new Map<string, CliConnectedDefaultSelection>();
  const dispositions = new Map<string, SpawnConnectedServicesDefaultDisposition>();
  if (purposeCatalog) {
    for (const agentId of params.agentIds) {
      selections.set(agentId, resolveCliConnectedDefaultSelection({ accountSettings: params.settings, agentId, purposeCatalog }));
      dispositions.set(agentId, resolveSpawnConnectedServicesDefaultDisposition({
        accountSettings: params.settings, agentId, purposeCatalog,
      }));
    }
  }
  return { purposeCatalog, dispositions, selections };
}
