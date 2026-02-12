import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import { runPi } from '@/backends/pi/runPi';

export async function handlePiCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    loadRun: async () => runPi,
    agentIdForAccountSettings: 'pi',
  });
}
