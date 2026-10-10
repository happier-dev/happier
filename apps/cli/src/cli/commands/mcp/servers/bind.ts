import chalk from 'chalk';

import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';

import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';
import {
  createInvalidArgumentsError,
  reportMcpServerCatalogMutation,
} from './errors';
import { cmd, fail } from '@happier-dev/cli-common/output';

export async function cmdMcpServersBind(
  argv: string[],
  deps: Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext' | 'randomUUID' | 'nowMs'>,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_bind', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
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
  const context = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const current = readMcpServersSettingsFromAccountSettings(context);
  const server = current.servers.find((candidate) => (
    candidate.id === serverRef || candidate.name === serverRef
  )) ?? null;
  if (!server) throw createInvalidArgumentsError(`MCP server not found: ${serverRef}`);
  const mutation = createCliMcpServerStore({ credentials }).mutate({
    kind: 'binding-create',
    binding: {
      id: bindingId,
      serverId: server.id,
      enabled: true,
      target: { t: 'allMachines' },
      createdAt: now,
      updatedAt: now,
    },
  }, context.mcpServerCatalog.revision, context.mcpServerCatalog);
  if (!await reportMcpServerCatalogMutation(mutation, {
    kind: 'mcp_servers_bind',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_bind', data: { createdBindingId: bindingId } });
    return;
  }

  console.log(chalk.green('✓'), `MCP binding created: ${bindingId}`);
}
