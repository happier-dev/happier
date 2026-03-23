import type { AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import { runCatalogDefinedAcpAgent } from './runCatalogDefinedAcpAgent';

export async function handleCatalogDefinedAcpCliCommand(agentId: AgentId, context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (opts) => runCatalogDefinedAcpAgent(agentId, opts),
    agentIdForAccountSettings: agentId,
  });
}
