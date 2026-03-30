import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { reloadConfiguration } from '@/configuration';
import { enableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';

import type { McpCommandDeps } from './deps';

function clearServerSelectionEnvOverrides(): void {
  delete process.env.HAPPIER_SERVER_URL;
  delete process.env.HAPPIER_LOCAL_SERVER_URL;
  delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  delete process.env.HAPPIER_WEBAPP_URL;
  delete process.env.HAPPIER_ACTIVE_SERVER_ID;
}

export async function runMcpServeCommand(
  argv: readonly string[],
  deps: McpCommandDeps,
): Promise<void> {
  enableMcpStdioConsolePatch();

  clearServerSelectionEnvOverrides();
  reloadConfiguration();

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
    honorAccountSettingsModeEnv: false,
  });

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
