import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { enableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';

import type { McpCommandDeps } from './deps';

export async function runMcpServeCommand(
  argv: readonly string[],
  deps: McpCommandDeps,
): Promise<void> {
  enableMcpStdioConsolePatch();

  const defaultSessionId = readFlagValue(argv, '--session');
  const credentials = await deps.readCredentials();
  if (!credentials) {
    throw new Error('not_authenticated');
  }

  await deps.ensureMachineIdForCredentials(credentials);
  await deps.bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });

  const { mcp } = deps.createExternalMcpServer({ credentials, defaultSessionId });

  await deps.connectMcpStdio(mcp);
}
