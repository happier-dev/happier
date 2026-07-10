import { readCredentials } from '@/persistence';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
  ResolvedContributionRegistry,
} from '@/plugins/projection/registry/types';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAcpCatalogSettingsFromAccountSettings } from '@/agent/acp/catalog/readAcpCatalogSettingsFromAccountSettings';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import {
  createAcpRuntimeCoreFromDefinition,
  normalizeConfiguredAcpDefinition,
} from '@/agent/acp/runtime/definition';

const ACCOUNT_CONFIGURED_ACP_SOURCE = Object.freeze({ kind: 'bundled' as const });

function createAccountConfiguredAcpAgentContribution(
  agentRuntime: ResolvedAgentRuntimeContribution,
): ResolvedAgentContribution {
  return Object.freeze({
    id: agentRuntime.agentId,
    provenance: 'first_party',
    source: ACCOUNT_CONFIGURED_ACP_SOURCE,
    definition: Object.freeze({
      kindVersion: 1,
      id: agentRuntime.agentId,
      ownedBackendIds: Object.freeze([agentRuntime.id]),
    }),
    runtimeSpec: null,
  });
}

export async function ingestAccountConfiguredAcpBackends(
  contributions: ResolvedContributionRegistry,
): Promise<ResolvedContributionRegistry> {
  const settings = getActiveAccountSettingsSnapshot()?.settings;
  if (!settings) {
    return contributions;
  }

  const catalogSettings = readAcpCatalogSettingsFromAccountSettings(settings);
  const missingBackendIds = catalogSettings.backends
    .map((backend) => backend.id)
    .filter((backendId) => !contributions.agentRuntimeDefinitionsById.has(backendId));
  if (missingBackendIds.length === 0) {
    return contributions;
  }

  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error('Account-configured ACP backends require credentials to resolve launch environment');
  }

  const agentRuntimeDefinitionsById = new Map(contributions.agentRuntimeDefinitionsById);
  const agentDefinitionsById = new Map(contributions.agentDefinitionsById);
  const agentRuntimes: ResolvedAgentRuntimeContribution[] = [...contributions.agentRuntimes];
  const agents: ResolvedAgentContribution[] = [...contributions.agents];

  for (const backendId of missingBackendIds) {
    const configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(settings, backendId);
    if (!configuredBackend || agentRuntimeDefinitionsById.has(configuredBackend.backendId)) {
      continue;
    }
    const launchEnv = materializeConfiguredAcpEnvironment({
      backend: configuredBackend,
      accountSettings: settings,
      credentials,
    });
    const definition = normalizeConfiguredAcpDefinition({
      backend: configuredBackend,
      launchEnv,
    });
    const agentId = `acp:${configuredBackend.backendId}`;
    const agentRuntimeContribution: ResolvedAgentRuntimeContribution = Object.freeze({
      id: configuredBackend.backendId,
      agentId,
      provenance: 'first_party',
      source: ACCOUNT_CONFIGURED_ACP_SOURCE,
      definition: Object.freeze({
        kindVersion: 1,
        id: configuredBackend.backendId,
        agentId,
      }),
      runtimeKind: 'acp',
      surfaceHandlers: Object.freeze([]),
      getRuntimeCore: async () => () => createAcpRuntimeCoreFromDefinition(definition),
    });
    const agentContribution = createAccountConfiguredAcpAgentContribution(agentRuntimeContribution);
    agentRuntimeDefinitionsById.set(agentRuntimeContribution.id, agentRuntimeContribution);
    agentRuntimes.push(agentRuntimeContribution);
    if (!agentDefinitionsById.has(agentContribution.id)) {
      agentDefinitionsById.set(agentContribution.id, agentContribution);
      agents.push(agentContribution);
    }
  }

  return Object.freeze({
    ...contributions,
    agents: Object.freeze(agents),
    agentRuntimes: Object.freeze(agentRuntimes),
    agentDefinitionsById,
    agentRuntimeDefinitionsById,
  });
}
