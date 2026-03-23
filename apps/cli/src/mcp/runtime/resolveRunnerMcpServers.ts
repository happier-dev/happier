import type { McpServerConfig } from '@/agent';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import {
  readSessionMcpSelectionV1FromMetadata,
  type AccountSettings,
} from '@happier-dev/protocol';

import { readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { resolveManagedSessionMcpSelectionForDirectory } from '../servers/resolveManagedSessionMcpSelectionForDirectory';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
  indexSavedSecretsByIdFromAccountSettings,
} from '../servers/resolveMcpValueRefPlaintext';
import { materializeMcpServerConfigRecord } from '../servers/materializeMcpServerConfigRecord';
import { mergeWithBuiltInHappierMcpServer } from '../servers/mergeWithBuiltInHappierMcpServer';

import type { HappyMcpSessionClient } from '../startHappyServer';

export async function resolveRunnerMcpServers(params: Readonly<{
  session: HappyMcpSessionClient;
  credentials: Credentials;
  accountSettings: AccountSettings | null;
  machineId: string;
  directory: string;
  sessionMetadata?: Readonly<Record<string, unknown>> | null;
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
  const resolvedSelection = resolveManagedSessionMcpSelectionForDirectory({
    settings: mcpSettings,
    machineId: params.machineId,
    directory: params.directory,
    selection: readSessionMcpSelectionV1FromMetadata(params.sessionMetadata ?? null),
  });

  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(accountSettings as any);
  const settingsSecretsKey = deriveSettingsSecretsKeyForCredentials(params.credentials);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);

  const materialized = await materializeMcpServerConfigRecord({
    resolved: {
      directory: params.directory,
      strictMode: resolvedSelection.strictMode,
      serversByName: resolvedSelection.selectedServersByName,
    },
    savedSecretsById,
    settingsSecretsKey,
    settingsSecretsReadKeys,
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
