import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';

import { showServerHelp } from './server/help';
import { runServerSubcommand } from './server/subcommands';

export async function handleServerCommand(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'server_unknown';
    if (sub === 'list') return 'server_list';
    if (sub === 'current') return 'server_current';
    if (sub === 'add') return 'server_add';
    if (sub === 'use') return 'server_use';
    if (sub === 'remove') return 'server_remove';
    if (sub === 'test') return 'server_test';
    if (sub === 'set') return 'server_set';
    return `server_${sub}`;
  })();

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showServerHelp();
      return;
    }

    const handled = await runServerSubcommand(subcommand, args);
    if (handled) {
      return;
    }

    throw new Error(`Unknown server subcommand: ${subcommand}`);
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

export async function handleServerCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'server_unknown';
    if (sub === 'list') return 'server_list';
    if (sub === 'current') return 'server_current';
    if (sub === 'add') return 'server_add';
    if (sub === 'use') return 'server_use';
    if (sub === 'remove') return 'server_remove';
    if (sub === 'test') return 'server_test';
    if (sub === 'set') return 'server_set';
    return `server_${sub}`;
  })();
  try {
    await handleServerCommand(args);
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
    showServerHelp();
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
