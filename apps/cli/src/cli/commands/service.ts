import type { CommandContext } from '@/cli/commandRegistry';
import { runDaemonServiceCliCommand } from '@/daemon/service/cli';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

export async function handleServiceCliCommand(context: CommandContext): Promise<void> {
  if (context.args[1] === 'repair') {
    await handleServiceRepairCliCommand({
      argv: context.args.slice(1),
      commandPath: 'happier service',
    });
    return;
  }

  await runDaemonServiceCliCommand({
    argv: context.args.slice(1),
    commandPath: 'happier service',
  });
}
