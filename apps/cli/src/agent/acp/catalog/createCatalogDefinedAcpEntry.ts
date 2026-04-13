import { AGENTS_CORE, hasBuiltInAcpConfig, type AgentId } from '@happier-dev/agents';

import type { AgentCatalogEntry } from '@/backends/types';

import { createCatalogDefinedCliAuthSpec } from './auth/createCatalogDefinedCliAuthSpec';
import { createCatalogDefinedCliDetect } from './createCatalogDefinedCliDetect';

type CatalogDefinedAcpEntryOverrides = Readonly<{
  getDirectSessionProviderOps?: AgentCatalogEntry['getDirectSessionProviderOps'];
  getConnectedServicesSpawnMaterializer?: AgentCatalogEntry['getConnectedServicesSpawnMaterializer'];
  getProviderAttachOps?: AgentCatalogEntry['getProviderAttachOps'];
  getTerminalRuntimeOps?: AgentCatalogEntry['getTerminalRuntimeOps'];
  getSessionHandoffProviderOps?: AgentCatalogEntry['getSessionHandoffProviderOps'];
  normalizeSessionControlPermissionMode?: AgentCatalogEntry['normalizeSessionControlPermissionMode'];
  getPreflightSessionControlsProbeAdapter?: AgentCatalogEntry['getPreflightSessionControlsProbeAdapter'];
}>;

export function createCatalogDefinedAcpEntry(
  agentId: AgentId,
  overrides: CatalogDefinedAcpEntryOverrides = {},
): AgentCatalogEntry {
  if (!hasBuiltInAcpConfig(agentId)) {
    throw new Error(`Agent '${agentId}' is not registered as a built-in generic ACP agent`);
  }

  const core = AGENTS_CORE[agentId];

  return {
    id: core.id,
    cliSubcommand: core.cliSubcommand,
    getCliCommandHandler: async () => {
      return async (context) => {
        const { handleCatalogDefinedAcpCliCommand } = await import('./handleCatalogDefinedAcpCliCommand');
        await handleCatalogDefinedAcpCliCommand(agentId, context);
      };
    },
    getCliDetect: async () => createCatalogDefinedCliDetect(agentId),
    getCliAuthSpec: async () => createCatalogDefinedCliAuthSpec(agentId),
    ...(overrides.getDirectSessionProviderOps
      ? { getDirectSessionProviderOps: overrides.getDirectSessionProviderOps }
      : {}),
    ...(overrides.getConnectedServicesSpawnMaterializer
      ? { getConnectedServicesSpawnMaterializer: overrides.getConnectedServicesSpawnMaterializer }
      : {}),
    ...(overrides.getProviderAttachOps ? { getProviderAttachOps: overrides.getProviderAttachOps } : {}),
    ...(overrides.getTerminalRuntimeOps
      ? { getTerminalRuntimeOps: overrides.getTerminalRuntimeOps }
      : {}),
    ...(overrides.getSessionHandoffProviderOps
      ? { getSessionHandoffProviderOps: overrides.getSessionHandoffProviderOps }
      : {}),
    ...(overrides.normalizeSessionControlPermissionMode
      ? { normalizeSessionControlPermissionMode: overrides.normalizeSessionControlPermissionMode }
      : {}),
    ...(overrides.getPreflightSessionControlsProbeAdapter
      ? { getPreflightSessionControlsProbeAdapter: overrides.getPreflightSessionControlsProbeAdapter }
      : {}),
    vendorResumeSupport: core.resume.vendorResume,
    getAcpBackendFactory: async () => {
      const { createCatalogDefinedAcpBackend } = await import('./createCatalogDefinedAcpBackend');
      return (opts) => ({ backend: createCatalogDefinedAcpBackend(agentId, opts) });
    },
  };
}
