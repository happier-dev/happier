import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleOpenCodeCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => (await import('@/backends/opencode/runOpenCode')).runOpenCode,
    agentIdForDeprecatedAliases: 'opencode',
  });
}
