import chalk from 'chalk';

import { handleServerCommand } from '@/commands/server';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleServerCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleServerCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

