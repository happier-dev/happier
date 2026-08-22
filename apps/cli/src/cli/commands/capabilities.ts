import { errorFrame } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { createCliCapabilitiesService } from '@/rpc/handlers/capabilities';

function usage(): string {
  return [
    'happier capabilities - Inspect local capability metadata',
    '',
    'Usage:',
    '  happier capabilities [describe] [--json]',
    '',
  ].join('\n');
}

function resolveSubcommand(args: readonly string[]): string {
  const first = args.find((arg) => !arg.startsWith('-'));
  return first ?? 'describe';
}

export async function handleCapabilitiesCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const subcommand = resolveSubcommand(args);

  try {
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      console.log(usage());
      return;
    }

    if (subcommand !== 'describe') {
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'capabilities_unknown',
          error: { code: 'unknown_subcommand', message: `Unknown capabilities subcommand: ${subcommand}` },
        });
      } else {
        console.error(errorFrame('Error:', [`Unknown capabilities subcommand: ${subcommand}`]));
        console.log(usage());
        process.exitCode = 1;
      }
      return;
    }

    const service = await createCliCapabilitiesService();
    const data = service.describe();

    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'capabilities_describe', data });
      return;
    }

    await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    if (json) {
      await printJsonEnvelope(
        {
          ok: false,
          kind: 'capabilities_describe',
          error: {
            code: 'capabilities_failed',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        { exitCode: 2 },
      );
      return;
    }

    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
