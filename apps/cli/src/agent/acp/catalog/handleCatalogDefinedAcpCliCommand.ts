import type { AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

export async function handleCatalogDefinedAcpCliCommand(agentId: AgentId, context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => {
      const { runCatalogDefinedAcpAgent } = await import('./runCatalogDefinedAcpAgent');
      return (opts) => runCatalogDefinedAcpAgent(agentId, opts);
    },
    agentIdForAccountSettings: agentId,
  });
}
