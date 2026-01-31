import chalk from 'chalk';

import { handleAuthCommand } from '@/commands/auth';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleLogoutCliCommand(_context: CommandContext): Promise<void> {
  console.log(chalk.yellow('Note: "happier logout" is deprecated. Use "happier auth logout" instead.\n'));
  try {
    await handleAuthCommand(['logout']);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
