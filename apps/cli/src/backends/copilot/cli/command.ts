import { runCopilot } from '@/backends/copilot/runCopilot';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleCopilotCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runCopilot,
    agentIdForAccountSettings: 'copilot',
  });
}
