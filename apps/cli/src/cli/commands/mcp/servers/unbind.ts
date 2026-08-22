import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import type { McpCommandDeps } from '../deps';
import {
  createInvalidArgumentsError,
  reportMcpServersAccountSettingsMutation,
} from './errors';

export async function cmdMcpServersUnbind(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_unbind', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const bindingId = readFlagValue(argv, '--binding-id');
  if (!bindingId) throw new Error('Usage: happier mcp servers unbind --binding-id <id> [--json]');
  const context = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
  });
  const current = readMcpServersSettingsFromAccountSettings(
    context.rawSettings ?? context.settings,
  );
  if (!current.bindings.some((binding) => binding.id === bindingId)) {
    throw createInvalidArgumentsError(`Binding not found: ${bindingId}`);
  }
  const next = McpServersSettingsV1Schema.parse({
    ...current,
    bindings: current.bindings.filter((binding) => binding.id !== bindingId),
  });

  const mutation = await deps.updateAccountSettingsV2WithRetry({
    credentials,
    mutation: {
      operations: [{ op: 'set', key: 'mcpServersSettingsV1', value: next }],
    },
  });
  if (!await reportMcpServersAccountSettingsMutation(mutation, {
    kind: 'mcp_servers_unbind',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_unbind', data: { removedBindingId: bindingId } });
    return;
  }

  console.log(chalk.green('✓'), `MCP binding removed: ${bindingId}`);
}
