import chalk from 'chalk';

import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import type { McpCommandDeps } from '../deps';
import {
  createInvalidArgumentsError,
  reportMcpServersAccountSettingsMutation,
} from './errors';

export async function cmdMcpServersBind(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_bind', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const serverRef = readFlagValue(argv, '--mcp-server') ?? readFlagValue(argv, '--server');
  const allMachines = hasFlag(argv, '--all-machines');
  if (!serverRef) {
    throw new Error('Usage: happier mcp servers bind --mcp-server <name|id> --all-machines [--json]');
  }
  if (!allMachines) throw new Error('Missing binding target (try --all-machines).');

  const bindingId = deps.randomUUID();
  const now = deps.nowMs();
  const context = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  });
  const current = readMcpServersSettingsFromAccountSettings(
    context.rawSettings ?? context.settings,
  );
  const server = current.servers.find((candidate) => (
    candidate.id === serverRef || candidate.name === serverRef
  )) ?? null;
  if (!server) throw createInvalidArgumentsError(`MCP server not found: ${serverRef}`);
  const next = McpServersSettingsV1Schema.parse({
    ...current,
    bindings: [
      ...current.bindings,
      {
        id: bindingId,
        serverId: server.id,
        enabled: true,
        target: { t: 'allMachines' },
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  const mutation = await deps.updateAccountSettingsV2WithRetry({
    credentials,
    mutation: {
      operations: [{ op: 'set', key: 'mcpServersSettingsV1', value: next }],
    },
  });
  if (!await reportMcpServersAccountSettingsMutation(mutation, {
    kind: 'mcp_servers_bind',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_bind', data: { createdBindingId: bindingId } });
    return;
  }

  console.log(chalk.green('✓'), `MCP binding created: ${bindingId}`);
}
