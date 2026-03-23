import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import type { McpCommandDeps } from '../deps';

export async function cmdMcpServersUnbind(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readCredentials();
  if (!credentials) {
    if (opts.json) {
      printJsonEnvelope({ ok: false, kind: 'mcp_servers_unbind', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const bindingId = readFlagValue(argv, '--binding-id');
  if (!bindingId) throw new Error('Usage: happier mcp servers unbind --binding-id <id> [--json]');

  await deps.updateAccountSettingsV2WithRetry({
    credentials,
    mutate: (settings: Readonly<Record<string, unknown>>) => {
      const current = readMcpServersSettingsFromAccountSettings(settings);
      if (!current.bindings.some((b) => b.id === bindingId)) {
        throw new Error(`Binding not found: ${bindingId}`);
      }
      const next = McpServersSettingsV1Schema.parse({
        ...current,
        bindings: current.bindings.filter((b) => b.id !== bindingId),
      });
      return { ...settings, mcpServersSettingsV1: next };
    },
  });

  if (opts.json) {
    printJsonEnvelope({ ok: true, kind: 'mcp_servers_unbind', data: { removedBindingId: bindingId } });
    return;
  }

  console.log(chalk.green('✓'), `MCP binding removed: ${bindingId}`);
}

