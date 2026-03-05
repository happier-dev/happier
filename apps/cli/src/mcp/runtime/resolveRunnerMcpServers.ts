import type { McpServerConfig } from '@/agent';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { AccountSettings } from '@happier-dev/protocol';

import { readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '../servers/resolveEffectiveMcpServersForDirectory';
import { deriveSettingsSecretsKeyForCredentials, indexSavedSecretsByIdFromAccountSettings } from '../servers/resolveMcpValueRefPlaintext';
import { materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';

import type { HappyMcpSessionClient } from '../startHappyServer';

export async function resolveRunnerMcpServers(params: Readonly<{
  session: HappyMcpSessionClient;
  credentials: Credentials;
  accountSettings: AccountSettings | null;
  machineId: string;
  directory: string;
  env?: NodeJS.ProcessEnv;
  tmpDir?: string | null;
  commandMode?: NonNullable<Parameters<typeof createHappierMcpBridge>[1]>['commandMode'];
}>): Promise<Readonly<{
  happierMcpServer: { url: string; stop: () => void };
  mcpServers: Record<string, McpServerConfig>;
}>> {
  const env = params.env ?? process.env;

  const builtIn = await createHappierMcpBridge(params.session, { commandMode: params.commandMode });

  const accountSettings = params.accountSettings ?? null;
  if (!accountSettings) {
    return { happierMcpServer: builtIn.happierMcpServer, mcpServers: builtIn.mcpServers };
  }

  const mcpSettings = readMcpServersSettingsFromAccountSettings(accountSettings as any);
  const resolved = resolveEffectiveMcpServersForDirectory({
    settings: mcpSettings,
    machineId: params.machineId,
    directory: params.directory,
  });

  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(accountSettings as any);
  const settingsSecretsKey = deriveSettingsSecretsKeyForCredentials(params.credentials);

  const materialized = await materializeMcpServerConfigRecord({
    resolved,
    savedSecretsById,
    settingsSecretsKey,
    processEnv: env,
    tmpDir: params.tmpDir ?? null,
    strictMode: mcpSettings.strictMode,
  });

  if (materialized.warnings.length > 0) {
    logger.debug('[mcp] Materialization warnings', {
      warningCount: materialized.warnings.length,
      warnings: materialized.warnings.map((w) => ({ serverName: w.serverName, code: w.code, detail: w.detail })),
    });
  }

  const merged = mergeWithBuiltInHappierMcpServer({ builtIn: builtIn.mcpServers, extra: materialized.mcpServers });
  return { happierMcpServer: builtIn.happierMcpServer, mcpServers: merged };
}
