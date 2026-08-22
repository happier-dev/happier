import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { errorFrame } from '@happier-dev/cli-common/output';

import { showRelayHelp } from './relay/help';
import { runRelaySubcommand } from './relay/subcommands';

function isArgumentUsageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? '';
  return /^Unknown relay /i.test(message)
    || /^Unknown relay host /i.test(message)
    || /^Usage:/i.test(message)
    || /Missing (required )?(value for|argument|flag)/i.test(message)
    || /^Invalid /i.test(message);
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
    await printJsonEnvelope(
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
      await printJsonEnvelope(
        {
          ok: false,
          kind,
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    if (isArgumentUsageError(error)) {
      showRelayHelp();
    }
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
