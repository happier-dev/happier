import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { runDoctorCommand } from '@/ui/doctor';

function usage(): string {
  return [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '',
  ].join('\n');
}

export async function handleInstallCliCommand(context: CommandContext): Promise<void> {
  const subcommand = context.args[1] ?? 'help';
  if (subcommand === 'doctor') {
    await runDoctorCommand();
    return;
  }
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return;
  }
  console.error(chalk.red('Error:'), `Unknown install subcommand: ${subcommand}`);
  console.log(usage());
  process.exit(1);
}
