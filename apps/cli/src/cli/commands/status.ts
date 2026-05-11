import type { CommandContext } from '@/cli/commandRegistry';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

export async function handleStatusCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--yes')) {
    throw new Error('happier status is read-only. Use `happier doctor repair --yes` to apply repairs.');
  }

  await handleServiceRepairCliCommand({
    argv: ['repair', '--report-only', ...context.args.slice(1)],
    commandPath: 'happier status',
  });
}
