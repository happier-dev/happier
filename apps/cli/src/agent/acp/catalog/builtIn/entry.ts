import { getAgentCore, hasBuiltInAcpConfig, isAgentId } from '@happier-dev/agents';

import type { AgentCatalogEntry, CatalogAgentLookupId } from '@/backends/types';

import { createBuiltInCliAuthSpec } from './auth';
import { createBuiltInCliDetect } from './detect';
import { loadBuiltInRuntimeOwners } from './runtimeOwners';

type BuiltInAcpEntryOverrides = Readonly<{
  getExternalSessionProviderOps?: AgentCatalogEntry['getExternalSessionProviderOps'];
  getConnectedServicesMaterializer?: AgentCatalogEntry['getConnectedServicesMaterializer'];
  getConnectedServiceRuntimeAuthAdapter?: AgentCatalogEntry['getConnectedServiceRuntimeAuthAdapter'];
  getConnectedServiceStateSharingDescriptor?: AgentCatalogEntry['getConnectedServiceStateSharingDescriptor'];
  resolveConnectedServiceSwitchContinuity?: AgentCatalogEntry['resolveConnectedServiceSwitchContinuity'];
  verifyResumeReachable?: AgentCatalogEntry['verifyResumeReachable'];
  getProviderAttachOps?: AgentCatalogEntry['getProviderAttachOps'];
  getTerminalRuntimeOps?: AgentCatalogEntry['getTerminalRuntimeOps'];
  getForkSurface?: AgentCatalogEntry['getForkSurface'];
  getHandoffSurface?: AgentCatalogEntry['getHandoffSurface'];
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
  const getRuntimeCore: AgentCatalogEntry['getRuntimeCore'] = async () => {
    const { createCatalogRuntimeCore } = await import('@/agent/runtime/registry/runtimeCore/catalog');
    const runtimeOwners = await loadBuiltInRuntimeOwners(agentId);

    return createCatalogRuntimeCore({
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
    ...(overrides.getExternalSessionProviderOps
      ? { getExternalSessionProviderOps: overrides.getExternalSessionProviderOps }
      : {}),
    ...(overrides.getConnectedServicesMaterializer
      ? { getConnectedServicesMaterializer: overrides.getConnectedServicesMaterializer }
      : {}),
    ...(overrides.getConnectedServiceRuntimeAuthAdapter
      ? { getConnectedServiceRuntimeAuthAdapter: overrides.getConnectedServiceRuntimeAuthAdapter }
      : {}),
    ...(overrides.getConnectedServiceStateSharingDescriptor
      ? { getConnectedServiceStateSharingDescriptor: overrides.getConnectedServiceStateSharingDescriptor }
      : {}),
    ...(overrides.resolveConnectedServiceSwitchContinuity
      ? { resolveConnectedServiceSwitchContinuity: overrides.resolveConnectedServiceSwitchContinuity }
      : {}),
    ...(overrides.verifyResumeReachable
      ? { verifyResumeReachable: overrides.verifyResumeReachable }
      : {}),
    ...(overrides.getProviderAttachOps ? { getProviderAttachOps: overrides.getProviderAttachOps } : {}),
    ...(overrides.getTerminalRuntimeOps
      ? { getTerminalRuntimeOps: overrides.getTerminalRuntimeOps }
      : {}),
    ...(overrides.getForkSurface
      ? { getForkSurface: overrides.getForkSurface }
      : {}),
    ...(overrides.getHandoffSurface
      ? { getHandoffSurface: overrides.getHandoffSurface }
      : {}),
    ...(overrides.normalizeSessionControlPermissionMode
      ? { normalizeSessionControlPermissionMode: overrides.normalizeSessionControlPermissionMode }
      : {}),
    ...(overrides.getPreflightSessionControlsProbeAdapter
      ? { getPreflightSessionControlsProbeAdapter: overrides.getPreflightSessionControlsProbeAdapter }
      : {}),
    getRuntimeCore,
    vendorResumeSupport: core.resume.vendorResume,
  };
}
