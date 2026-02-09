import type { CommandContext } from '@/cli/commandRegistry';
import { handleSelfCliCommand } from '@/cli/commands/self';

export async function handleSelfUpdateCliCommand(context: CommandContext): Promise<void> {
  const passthrough = context.args.slice(1);
  const wantsCheck = passthrough.includes('--check');
  const args = wantsCheck
    ? ['self', 'check', ...passthrough.filter((arg) => arg !== '--check')]
    : ['self', 'update', ...passthrough];
  await handleSelfCliCommand({
    ...context,
    args,
  });
}
