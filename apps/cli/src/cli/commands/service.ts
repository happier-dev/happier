import type { CommandContext } from '@/cli/commandRegistry';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { runDaemonServiceCliCommand } from '@/daemon/service/cli';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

export async function handleServiceCliCommand(context: CommandContext): Promise<void> {
  const commandPath = `${resolveInvokerName() ?? 'happier'} service`;

  if (context.args[1] === 'repair') {
    await handleServiceRepairCliCommand({
      argv: context.args.slice(1),
      commandPath,
    });
    return;
  }

  await runDaemonServiceCliCommand({
    argv: context.args.slice(1),
    commandPath,
  });
}
