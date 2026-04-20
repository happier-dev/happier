import { getAgentCore, hasBuiltInAcpConfig, isAgentId } from '@happier-dev/agents';

import type { AgentCatalogEntry, CatalogAgentLookupId } from '@/backends/types';

import { createBuiltInCliAuthSpec } from './auth';
import { createBuiltInCliDetect } from './detect';
import { loadBuiltInRuntimeOwners } from './runtimeOwners';

type BuiltInAcpEntryOverrides = Readonly<{
  getDirectSessionProviderOps?: AgentCatalogEntry['getDirectSessionProviderOps'];
  getConnectedServicesMaterializer?: AgentCatalogEntry['getConnectedServicesMaterializer'];
  getProviderAttachOps?: AgentCatalogEntry['getProviderAttachOps'];
  getTerminalRuntimeOps?: AgentCatalogEntry['getTerminalRuntimeOps'];
  getReplayForkContinuationHandler?: AgentCatalogEntry['getReplayForkContinuationHandler'];
  getSessionHandoffProviderOps?: AgentCatalogEntry['getSessionHandoffProviderOps'];
  normalizeSessionControlPermissionMode?: AgentCatalogEntry['normalizeSessionControlPermissionMode'];
  getPreflightSessionControlsProbeAdapter?: AgentCatalogEntry['getPreflightSessionControlsProbeAdapter'];
}>;

export function createBuiltInEntry(
  agentId: CatalogAgentLookupId,
  overrides: BuiltInAcpEntryOverrides = {},
): AgentCatalogEntry {
  if (!isAgentId(agentId) || !hasBuiltInAcpConfig(agentId)) {
    throw new Error(`Agent '${agentId}' is not registered as a built-in generic ACP agent`);
  }

  const core = getAgentCore(agentId);
  const getBindings: AgentCatalogEntry['getBindings'] = async () => {
    const { createCatalogBindings } = await import('@/agent/runtime/registry/bindings/catalog');
    const runtimeOwners = await loadBuiltInRuntimeOwners(agentId);

    return createCatalogBindings({
      providerId: agentId,
      createHostSessionRuntimePlan: (sessionParams) =>
        runtimeOwners.createHostSessionRuntimePlan(
          sessionParams as Parameters<typeof runtimeOwners.createHostSessionRuntimePlan>[0],
        ),
      createRuntime: runtimeOwners.createRuntime,
    });
  };

  return {
    id: core.id,
    cliSubcommand: core.cliSubcommand,
    getCliCommandHandler: async () => {
      return async (context) => {
        const { handleBuiltInCliCommand } = await import('./command');
        await handleBuiltInCliCommand(agentId, context);
      };
    },
    getCliDetect: async () => createBuiltInCliDetect(agentId),
    getCliAuthSpec: async () => createBuiltInCliAuthSpec(agentId),
    ...(overrides.getDirectSessionProviderOps
      ? { getDirectSessionProviderOps: overrides.getDirectSessionProviderOps }
      : {}),
    ...(overrides.getConnectedServicesMaterializer
      ? { getConnectedServicesMaterializer: overrides.getConnectedServicesMaterializer }
      : {}),
    ...(overrides.getProviderAttachOps ? { getProviderAttachOps: overrides.getProviderAttachOps } : {}),
    ...(overrides.getTerminalRuntimeOps
      ? { getTerminalRuntimeOps: overrides.getTerminalRuntimeOps }
      : {}),
    ...(overrides.getReplayForkContinuationHandler
      ? { getReplayForkContinuationHandler: overrides.getReplayForkContinuationHandler }
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
    getBindings,
    vendorResumeSupport: core.resume.vendorResume,
  };
}
