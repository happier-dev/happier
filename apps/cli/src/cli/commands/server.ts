import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';

import { showServerHelp } from './server/help';
import { runServerSubcommand } from './server/subcommands';

export async function handleServerCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showServerHelp();
    return;
  }

  const handled = await runServerSubcommand(subcommand, args);
  if (handled) {
    return;
  }

  console.error(chalk.red(`Unknown server subcommand: ${subcommand}`));
  showServerHelp();
  process.exit(1);
}

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
