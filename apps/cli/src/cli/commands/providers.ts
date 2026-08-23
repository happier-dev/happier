import { ProviderErrorV1Schema } from '@happier-dev/protocol';
import { errorFrame } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';
import { executeProvidersCommand, ProviderCliError } from './providers/index';
import { hasFlag } from './providers/args';
import { resolveProviderCliDependencies } from './providers/deps';

const PROVIDERS_HELP = `happier providers

Manage model-provider connections.

  happier providers list [--available] [--json]
  happier providers show <connection-id> [--machine <machine-id>] [--json]
  happier providers add <qualified-contribution-key> [--name <name>] [--candidate-id <id>] [--saved-secret-id <id>] [--json]
  happier providers add --custom --name <name> --protocol <protocol> --base-url <url> --catalog manual|probe
  happier providers edit <connection-id> (--name <name>|--automatic-name)
  happier providers edit <connection-id> --scope account|machine --endpoint-template <id> (--base-url <url>|--clear-endpoint)
  happier providers enable|disable <connection-id> [--machine <machine-id>]
  happier providers bind-secret <connection-id> --scope account|machine --saved-secret-id <id>
  happier providers unbind-secret|replace-secret <connection-id> --scope account|machine
  happier providers add-model <connection-id> --models <newline-separated-ids>
  happier providers remove-model <connection-id> --model <model-id>
  happier providers probe|test|models <connection-id> [--machine <machine-id>]
  happier providers load-model <connection-id> --model <model-id> [--machine <machine-id>]
  happier providers remove <connection-id>

Agent CLI setup moved to 'happier agents'.`;

export async function handleProvidersCliCommand(
    context: CommandContext,
    resolveDependencies: typeof resolveProviderCliDependencies = resolveProviderCliDependencies,
): Promise<void> {
    const args = context.args.slice(1);
    const json = hasFlag(args, '--json');
    try {
        const subcommand = String(args[0] ?? '').trim();
        if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
            console.log(PROVIDERS_HELP);
            return;
        }
        if (['install', 'setup', 'status'].includes(subcommand)) {
            throw new ProviderCliError(
                'legacy_agent_command_moved',
                `Agent setup moved to 'happier agents ${subcommand}'; 'happier providers' now manages model providers`,
            );
        }
        const deps = await resolveDependencies();
        const result = await executeProvidersCommand(
            args,
            deps,
            context.signal ? { signal: context.signal } : {},
        );
        if (!result.ok) {
            throw new ProviderCliError(result.error.code, result.error.message, result.error.details);
        }
        if (result.kind === 'providers_help') {
            console.log(PROVIDERS_HELP);
            return;
        }
        if (json) {
            await printJsonEnvelope(result);
            return;
        }
        await writeJsonStdout(result.data, { pretty: true });
    } catch (error) {
        const cliError = error instanceof ProviderCliError
            ? error
            : new ProviderCliError('operation_failed', error instanceof Error ? error.message : 'Unknown provider operation failure');
        if (json) {
            await printJsonEnvelope({
                ok: false,
                kind: `providers_${String(args[0] ?? 'unknown').replaceAll('-', '_')}`,
                error: { code: cliError.code, message: cliError.message, ...(cliError.details === undefined ? {} : { details: cliError.details }) },
            }, { exitCode: 1 });
            return;
        }
        // A typed Provider refusal already names its recovery action. Render it
        // through the canonical presenter so the direct CLI path keeps the same
        // guidance the other Provider surfaces show instead of a bare code.
        const typed = ProviderErrorV1Schema.safeParse(cliError.details);
        console.error(typed.success
            ? errorFrame('Error:', presentProviderCliRefusal(typed.data))
            : `Error: ${cliError.message}`);
        process.exitCode = 1;
    }
}
