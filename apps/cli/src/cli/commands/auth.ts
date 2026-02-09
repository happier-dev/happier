import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';

import { showAuthHelp } from './auth/help';
import { handleAuthLogin } from './auth/login';
import { handleAuthLogout } from './auth/logout';
import { handleAuthStatus } from './auth/status';

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      return;
    case 'logout':
      await handleAuthLogout(args.slice(1));
      return;
    case 'status':
      await handleAuthStatus();
      return;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

export async function handleAuthCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAuthCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
