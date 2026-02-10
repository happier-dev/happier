import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleQwenCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (await import('@/backends/qwen/runQwen')).runQwen,
    agentIdForAccountSettings: 'qwen',
  });
}
