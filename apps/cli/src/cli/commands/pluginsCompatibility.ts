import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';

function usage(): string {
  return [
    `${chalk.bold('happier plugins')} - Plugin compatibility commands`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier plugins list [--json]',
    '',
    'This Happier version does not support installing plugins.',
  ].join('\n');
}

export async function handlePluginsCompatibilityCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const subcommand = args.find((arg) => !arg.startsWith('-')) ?? 'help';
  const json = wantsJson(args);

  if (subcommand === 'list') {
    if (json) {
      printJsonEnvelope({ ok: true, kind: 'plugins_list', data: { plugins: [] } });
    } else {
      console.log('No plugins installed.');
    }
    return;
  }

  if (subcommand === 'help') {
    console.log(usage());
    return;
  }

  if (json) {
    printJsonEnvelope({
      ok: false,
      kind: 'plugins_unsupported',
      error: {
        code: 'unsupported_in_this_version',
        message: `Plugin command '${subcommand}' is not supported by this Happier version`,
      },
    });
    return;
  }

  console.error(chalk.red('Error:'), `Plugin command '${subcommand}' is not supported by this Happier version`);
  console.log(usage());
  process.exitCode = 1;
}
