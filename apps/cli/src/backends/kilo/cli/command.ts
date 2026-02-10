import { runKilo } from '@/backends/kilo/runKilo';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleKiloCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runKilo,
    agentIdForAccountSettings: 'kilo',
  });
}
