import type { AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

export async function handleBuiltInCliCommand(agentId: AgentId, context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    backendIdForSessionRuntime: agentId,
    agentIdForAccountSettings: agentId,
  });
}
