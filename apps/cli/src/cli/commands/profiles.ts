import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';

import { showProfilesHelp } from './profiles/help';
import { runProfilesSubcommand } from './profiles/subcommands';

export async function handleProfilesCommand(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'profiles_unknown';
    if (sub === 'list') return 'profiles_list';
    return `profiles_${sub}`;
  })();

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showProfilesHelp();
      return;
    }

    const handled = await runProfilesSubcommand(subcommand, args);
    if (handled) {
      return;
    }

    throw new Error(`Unknown profiles subcommand: ${subcommand}`);
  } catch (error) {
    if (!json) throw error;
    const mapped = mapUnknownErrorToControlError(error);
    printJsonEnvelope(
      {
        ok: false,
        kind,
        error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
      },
      { exitCode: mapped.unexpected ? 2 : 1 },
    );
  }
}

export async function handleProfilesCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'profiles_unknown';
    if (sub === 'list') return 'profiles_list';
    return `profiles_${sub}`;
  })();

  try {
    await handleProfilesCommand(args);
  } catch (error) {
    if (json) {
      const mapped = mapUnknownErrorToControlError(error);
      printJsonEnvelope(
        {
          ok: false,
          kind,
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }

    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    showProfilesHelp();
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
