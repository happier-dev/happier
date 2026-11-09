import type { CommandContext } from '@/cli/commandRegistry';
import { CONFIGURED_ACP_CATALOG_USAGE } from './catalogHelp';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { readOptionalFlagValue } from '@/cli/sessionStartArgs';
import { resolveConfiguredAcpAgentSelection } from './resolveBackend';

export async function handleConfiguredAcpCatalogCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--help') || context.args.includes('-h')) { console.log(CONFIGURED_ACP_CATALOG_USAGE); return; }
  const configuredAcpBackendId = readOptionalFlagValue(context.args, '--backend');
  const backendId = typeof configuredAcpBackendId === 'string' ? configuredAcpBackendId.trim() : '';
  if (!backendId) {
    throw new Error(CONFIGURED_ACP_CATALOG_USAGE);
  }

  const selection = resolveConfiguredAcpAgentSelection(backendId);
  await runBackendSessionCliCommand({
    context,
    resolveSessionRuntimePreferences: null,
    backendIdForSessionRuntime: selection.runtimeRoutingAgentId,
    runtimeAuthorityAgentId: selection.runtimeAuthorityAgentId,
    loadAccountSettings: true,
    resolveExtraOptions: () => ({
      agentTarget: selection.agentTarget,
      runtimeDescriptorV1: selection.runtimeDescriptorV1,
    }),
  });
}
