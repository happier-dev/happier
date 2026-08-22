import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import type { McpCommandDeps } from '../deps';
import { readRepeatedFlagValues } from '../argv';
import { reportMcpServersAccountSettingsMutation } from './errors';

export async function cmdMcpServersAdd(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_add', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const name = readFlagValue(argv, '--name');
  const transport = (readFlagValue(argv, '--transport') ?? 'stdio').toLowerCase();
  const command = readFlagValue(argv, '--command');
  const args = readRepeatedFlagValues(argv, '--arg');

  if (!name) throw new Error('Usage: happier mcp servers add --name <name> --transport stdio --command <cmd> [--arg <arg>] [--json]');
  if (transport !== 'stdio') throw new Error('Only stdio transport is supported by this command currently.');
  if (!command) throw new Error('Missing --command');

  const id = deps.randomUUID();
  const now = deps.nowMs();
  const context = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  });
  const current = readMcpServersSettingsFromAccountSettings(
    context.rawSettings ?? context.settings,
  );
  if (current.servers.some((server) => server.name === name)) {
    throw new Error(`MCP server name already exists: ${name}`);
  }
  const next = McpServersSettingsV1Schema.parse({
    ...current,
    servers: [
      ...current.servers,
      {
        id,
        name,
        transport: 'stdio',
        stdio: { command, args },
        env: {},
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
    kind: 'mcp_servers_add',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_add', data: { created: { id, name } } });
    return;
  }

  console.log(chalk.green('✓'), `MCP server added: ${name}`);
}
