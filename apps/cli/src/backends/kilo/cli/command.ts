import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleKiloCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    backendIdForSessionRuntime: 'kilo',
    agentIdForAccountSettings: 'kilo',
  });
}
