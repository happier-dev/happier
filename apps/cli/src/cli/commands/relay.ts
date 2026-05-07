import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';

import { showRelayHelp } from './relay/help';
import { runRelaySubcommand } from './relay/subcommands';

/**
 * Decide whether a failure is an argument-parsing error (where showing the
 * usage block helps the user fix the invocation) or a runtime error (where
 * dumping the usage block just buries the real message and confuses the
 * reader). Keyword-based because the parser throws plain Error objects; if
 * we introduce a typed ArgumentError later, check the type here instead.
 */
function isArgumentUsageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message ?? '';
  return /^Unknown relay /i.test(msg)
    || /^Unknown relay host /i.test(msg)
    || /^Usage:/i.test(msg)
    || /Missing (required )?(value for|argument|flag)/i.test(msg)
    || /^Invalid /i.test(msg);
}

export async function handleRelayCommand(args: string[]): Promise<void> {
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'relay_unknown';
    if (sub === 'inspect-target') return 'relay_inspect_target';
    return `relay_${sub}`;
  })();

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showRelayHelp();
      return;
    }

    const handled = await runRelaySubcommand(subcommand, args);
    if (handled) {
      return;
    }

    throw new Error(`Unknown relay subcommand: ${subcommand}`);
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

export async function handleRelayCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const subcommand = args[0];
  const kind = (() => {
    const sub = String(subcommand ?? '').trim();
    if (!sub) return 'relay_unknown';
    if (sub === 'inspect-target') return 'relay_inspect_target';
    return `relay_${sub}`;
  })();

  try {
    await handleRelayCommand(args);
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
    if (isArgumentUsageError(error)) {
      // Only surface the usage block when the error is about how the command
      // was invoked. Runtime failures (daemon didn't converge, port busy,
      // etc.) already carry their own actionable next-step message — dumping
      // the usage block buries them.
      showRelayHelp();
    }
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
