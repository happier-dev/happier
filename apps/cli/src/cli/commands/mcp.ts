
import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import type { EphemeralResolvedServerSelection } from '@/server/serverSelection';

import { resolveMcpCommandDeps, type McpCommandDeps } from './mcp/deps';
import { runMcpServersSubcommand } from './mcp/servers/subcommands';
import { fail } from '@happier-dev/cli-common/output';

function isHelpToken(value: string): boolean {
  const trimmed = String(value ?? '').trim();
  return trimmed === 'help' || trimmed === '--help' || trimmed === '-h';
}

function printMcpUsage(): void {
  console.log('happier mcp serve [--session <session-id>]');
  console.log('happier --server <saved-home> mcp serve [--session <session-id>]  # pin one Home for this process');
  console.log('happier mcp servers list [--dir <path>] [--json]');
  console.log('happier mcp servers add --name <name> --transport stdio --command <cmd> [--arg <arg>] [--json]');
  console.log('happier mcp servers bind --mcp-server <name|id> --all-machines [--json]');
  console.log('happier mcp servers unbind --binding-id <id> [--json]');
  console.log('happier mcp servers detect --provider <provider-id> [--json]');
  console.log('happier mcp servers test --mcp-server <name|id> [--dir <path>] [--json]');
}

function printMcpServersUsage(): void {
  console.log('happier mcp servers list [--dir <path>] [--json]');
  console.log('happier mcp servers add --name <name> --transport stdio --command <cmd> [--arg <arg>] [--json]');
  console.log('happier mcp servers bind --mcp-server <name|id> --all-machines [--json]');
  console.log('happier mcp servers unbind --binding-id <id> [--json]');
  console.log('happier mcp servers detect --provider <provider-id> [--json]');
  console.log('happier mcp servers test --mcp-server <name|id> [--dir <path>] [--json]');
}

function resolveCommandKind(args: readonly string[]): string {
  const group = args[0];
  const subcommand = args[1];
  if (group === 'serve' || group === 'start') return 'mcp_serve';
  if (group !== 'servers') return 'mcp_unknown';
  const sub = String(subcommand ?? '').trim();
  if (!sub) return 'mcp_servers_unknown';
  if (sub === 'list') return 'mcp_servers_list';
  if (sub === 'add') return 'mcp_servers_add';
  if (sub === 'bind') return 'mcp_servers_bind';
  if (sub === 'unbind') return 'mcp_servers_unbind';
  if (sub === 'detect') return 'mcp_servers_detect';
  if (sub === 'test') return 'mcp_servers_test';
  return `mcp_servers_${sub}`;
}

export async function handleMcpCommand(
  args: string[],
  deps?: Partial<McpCommandDeps>,
  explicitServerSelection?: EphemeralResolvedServerSelection,
): Promise<void> {
  const json = wantsJson(args);
  const group = String(args[0] ?? '').trim();
  const subcommand = String(args[1] ?? '').trim();
  const kind = resolveCommandKind(args);

  const resolvedDeps = resolveMcpCommandDeps(deps);

  try {
    if (!group || isHelpToken(group)) {
      printMcpUsage();
      return;
    }

    if (group === 'serve' || group === 'start') {
      if (isHelpToken(subcommand)) {
        console.log('happier mcp serve [--session <session-id>]');
        console.log('happier --server <saved-home> mcp serve [--session <session-id>]  # pin one Home for this process');
        return;
      }
      const { runMcpServeCommand } = await import('./mcp/serve');
      await runMcpServeCommand(args, resolvedDeps, explicitServerSelection);
      return;
    }

    if (group !== 'servers') {
      throw new Error('Usage: happier mcp servers <command>');
    }

    if (!subcommand || isHelpToken(subcommand)) {
      printMcpServersUsage();
      return;
    }

    const handled = await runMcpServersSubcommand(subcommand ?? '', args, resolvedDeps, { json });
    if (handled) return;

    throw new Error(`Unknown mcp servers subcommand: ${subcommand ?? ''}`);
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

export async function handleMcpCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);

  try {
    await handleMcpCommand(args, undefined, context.explicitServerSelection);
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
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
