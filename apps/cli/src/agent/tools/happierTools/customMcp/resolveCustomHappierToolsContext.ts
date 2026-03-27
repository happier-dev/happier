import type { Credentials } from '@/persistence';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
  indexSavedSecretsByIdFromAccountSettings,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';

export async function resolveCustomHappierToolsContext(params: Readonly<{
  credentials: Credentials;
  accountSettings: Readonly<Record<string, unknown>>;
  machineId: string;
  directory: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<Awaited<ReturnType<typeof materializeMcpServerConfigRecord>>> {
  const settings = readMcpServersSettingsFromAccountSettings(params.accountSettings);
  const resolved = resolveEffectiveMcpServersForDirectory({
    settings,
    machineId: params.machineId,
    directory: params.directory,
  });
  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(params.accountSettings);
  return await materializeMcpServerConfigRecord({
    resolved,
    savedSecretsById,
    settingsSecretsKey: deriveSettingsSecretsKeyForCredentials(params.credentials),
    settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(params.credentials),
    processEnv: params.processEnv ?? process.env,
    tmpDir: null,
    strictMode: resolved.strictMode,
  });
}
