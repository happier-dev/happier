import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';

import { resolveMcpCommandDeps, type McpCommandDeps } from './mcp/deps';
import { runMcpServersSubcommand } from './mcp/servers/subcommands';

function resolveCommandKind(args: readonly string[]): string {
  const group = args[0];
  const subcommand = args[1];
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

export async function handleMcpCommand(args: string[], deps?: Partial<McpCommandDeps>): Promise<void> {
  const json = wantsJson(args);
  const group = args[0];
  const subcommand = args[1];
  const kind = resolveCommandKind(args);

  const resolvedDeps = resolveMcpCommandDeps(deps);

  try {
    if (group !== 'servers') {
      throw new Error('Usage: happier mcp servers <command>');
    }

    const handled = await runMcpServersSubcommand(subcommand ?? '', args, resolvedDeps, { json });
    if (handled) return;

    throw new Error(`Unknown mcp servers subcommand: ${subcommand ?? ''}`);
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

export async function handleMcpCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  const json = wantsJson(args);
  const kind = resolveCommandKind(args);

  try {
    await handleMcpCommand(args);
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
    if (process.env.DEBUG) console.error(error);
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}

