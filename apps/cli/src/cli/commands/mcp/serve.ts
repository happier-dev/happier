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
  const accountSettingsContext = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
    // Security: external MCP clients can spawn this command with arbitrary env vars.
    // Ignore env-driven account settings disables so action enablement/approvals are always
    // based on the authenticated account settings snapshot.
    honorAccountSettingsModeEnv: false,
  });

  // Security: never allow external env overrides to bypass action enablement / approvals.
  // External MCP clients can often set process env when spawning the server command.
  try {
    const actionsSettings = accountSettingsContext.settings.actionsSettingsV1;
    if (actionsSettings && typeof actionsSettings === 'object') {
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify(actionsSettings);
    } else {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    }
  } catch {
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  }

  const { mcp } = deps.createExternalMcpServer({ credentials, defaultSessionId });

  await deps.connectMcpStdio(mcp);
}
