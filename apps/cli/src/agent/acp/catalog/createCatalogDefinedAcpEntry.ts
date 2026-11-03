import {
  AGENTS_CORE,
  getBuiltInAcpConfig,
  getProviderCliRuntimeSpec,
  type AgentId,
} from '@happier-dev/agents';

import type { AgentCatalogEntry } from '@/backends/types';
import type { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';

import { createCatalogDefinedCliAuthSpec } from './auth/createCatalogDefinedCliAuthSpec';
import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';
import { createCatalogDefinedCliDetect } from './createCatalogDefinedCliDetect';
import { createAcpSessionListCatalogHook } from './createAcpSessionListCatalogHook';
import { resolveAcpCatalogTransportHandler } from './transport/resolveAcpCatalogTransportHandler';

export function createCatalogDefinedAcpEntry(
  agentId: AgentId,
  options: Readonly<Pick<Parameters<typeof createAcpCliCapability>[0], 'resolveAcpProbeLaunch'>> = {},
): AgentCatalogEntry {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
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
    getCliCapabilityOverride: async () => {
      const { createAcpCliCapability } = await import('@/capabilities/probes/createAcpCliCapability');
      return createAcpCliCapability({
        agentId,
        title: getProviderCliRuntimeSpec(agentId).title,
        acpArgs: [...config.launcher.args],
        transport: resolveAcpCatalogTransportHandler(config.transportProfile, agentId),
        resolveAcpProbeLaunch: options.resolveAcpProbeLaunch,
      });
    },
    vendorResumeSupport: core.resume.vendorResume,
    getAcpBackendFactory: async () => {
      return (opts) => ({ backend: createCatalogDefinedAcpBackend(agentId, opts as never) });
    },
    // The live handshake remains authoritative before `session/list` is dispatched.
    ...createAcpSessionListCatalogHook(agentId),
  };
}
