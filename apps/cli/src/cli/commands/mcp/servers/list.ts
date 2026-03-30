import chalk from 'chalk';

import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';

function summarizeMcpServersForJson(settings: ReturnType<typeof readMcpServersSettingsFromAccountSettings>): unknown {
  const bindingCountByServerId = new Map<string, number>();
  for (const binding of settings.bindings) {
    bindingCountByServerId.set(binding.serverId, (bindingCountByServerId.get(binding.serverId) ?? 0) + 1);
  }

  return {
    strictMode: settings.strictMode,
    servers: settings.servers.map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      bindingCount: bindingCountByServerId.get(server.id) ?? 0,
    })),
  };
}

export async function cmdMcpServersList(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readCredentials();
  if (!credentials) {
    if (opts.json) {
      printJsonEnvelope({ ok: false, kind: 'mcp_servers_list', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exitCode = 1;
    return;
  }

  const ctx = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const mcpSettings = readMcpServersSettingsFromAccountSettings(ctx.settings);

  if (opts.json) {
    printJsonEnvelope({ ok: true, kind: 'mcp_servers_list', data: summarizeMcpServersForJson(mcpSettings) });
    return;
  }

  console.log(chalk.gray(`MCP servers: ${mcpSettings.servers.length}`));
  for (const server of mcpSettings.servers) {
    console.log(`- ${server.name} (${server.transport})`);
  }
}
