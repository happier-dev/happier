import chalk from 'chalk';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
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

export async function cmdMcpServersUnbind(
  argv: string[],
  deps: Pick<McpCommandDeps, 'readStoredCredentials' | 'bootstrapAccountSettingsContext'>,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_unbind', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exitCode = 1;
    return;
  }

  const bindingId = readFlagValue(argv, '--binding-id');
  if (!bindingId) throw new Error('Usage: happier mcp servers unbind --binding-id <id> [--json]');
  const context = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const current = readMcpServersSettingsFromAccountSettings(context);
  if (!current.bindings.some((binding) => binding.id === bindingId)) {
    throw createInvalidArgumentsError(`Binding not found: ${bindingId}`);
  }
  const mutation = createCliMcpServerStore({ credentials }).mutate({ kind: 'binding-remove', bindingId },
    context.mcpServerCatalog.revision, context.mcpServerCatalog);
  if (!await reportMcpServerCatalogMutation(mutation, {
    kind: 'mcp_servers_unbind',
    json: opts.json,
  })) return;

  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_unbind', data: { removedBindingId: bindingId } });
    return;
  }

  console.log(chalk.green('✓'), `MCP binding removed: ${bindingId}`);
}
