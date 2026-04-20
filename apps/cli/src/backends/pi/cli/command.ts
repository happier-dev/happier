import type { CommandContext } from '@/cli/commandRegistry';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

export async function handlePiCliCommand(context: CommandContext): Promise<void> {
  await runBackendSessionCliCommand({
    context,
    backendIdForSessionRuntime: 'pi',
    agentIdForAccountSettings: 'pi',
  });
}
