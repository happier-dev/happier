import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { readOptionalFlagValue } from '@/cli/sessionStartArgs';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

export async function handleConfiguredAcpCatalogCliCommand(context: CommandContext): Promise<void> {
  const configuredAcpBackendId = readOptionalFlagValue(context.args, '--backend');
  const backendId = typeof configuredAcpBackendId === 'string' ? configuredAcpBackendId.trim() : '';
  if (!backendId) {
    throw new Error('Usage: happier acp-catalog --backend <backend-id> [session options]');
  }

  await runBackendSessionCliCommand({
    context,
    backendIdForSessionRuntime: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId,
    runtimeAuthorityAgentId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId,
    loadAccountSettings: true,
    resolveExtraOptions: () => ({
      agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: backendId },
      runtimeDescriptorV1: { v: 1, agentId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId, agent: { definitionId: backendId } },
      backendTarget: { kind: 'backend', backendId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId, sourceKind: 'built_in' },
    }),
  });
}
