import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';

import type { McpCommandDeps } from '../deps';
import { readRepeatedFlagValues } from '../argv';
import { reportMcpServerCatalogMutation } from './errors';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';
import { cmd, fail } from '@happier-dev/cli-common/output';

export async function cmdMcpServersAdd(
  argv: string[],
  deps: Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext' | 'randomUUID' | 'nowMs'>,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_add', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
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
  const context = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const mutation = createCliMcpServerStore({ credentials }).mutate({
    kind: 'server-create',
    entry: {
      id,
      name,
      transport: 'stdio',
      stdio: { command, args },
      env: {},
      createdAt: now,
      updatedAt: now,
    },
    bindings: [],
  }, context.mcpServerCatalog.revision, context.mcpServerCatalog);
  if (!await reportMcpServerCatalogMutation(mutation, {
    kind: 'mcp_servers_add',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_add', data: { created: { id, name } } });
    return;
  }

  console.log(chalk.green('✓'), `MCP server added: ${name}`);
}
