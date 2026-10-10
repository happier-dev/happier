import chalk from 'chalk';

import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { McpServerCatalogUnavailableError, readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';
import { cmd, fail } from '@happier-dev/cli-common/output';

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
  deps: Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext'>,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_list', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exitCode = 1;
    return;
  }

  const ctx = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const mcpSettings = readMcpServersSettingsFromAccountSettings(ctx);
  if (!await ctx.operationContext.isCurrent()) {
    throw new McpServerCatalogUnavailableError('scope-retired');
  }

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_list', data: summarizeMcpServersForJson(mcpSettings) });
    return;
  }

  console.log(chalk.gray(`MCP servers: ${mcpSettings.servers.length}`));
  for (const server of mcpSettings.servers) {
    console.log(`- ${server.name} (${server.transport})`);
  }
}
