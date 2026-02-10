import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleAuggieCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (await import('@/backends/auggie/runAuggie')).runAuggie,
    agentIdForAccountSettings: 'auggie',
  });
}
