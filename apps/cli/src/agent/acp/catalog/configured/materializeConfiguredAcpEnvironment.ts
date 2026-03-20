import type { Credentials } from '@/persistence';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
  indexSavedSecretsByIdFromAccountSettings,
  resolveMcpValueRefPlaintext,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';

import type { ResolvedConfiguredAcpBackend } from './resolveConfiguredAcpBackendFromAccountSettings';

export function materializeConfiguredAcpEnvironment(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  accountSettings: Readonly<Record<string, unknown>>;
  credentials: Credentials;
  processEnv?: NodeJS.ProcessEnv;
}>): Record<string, string> {
  const processEnv = params.processEnv ?? process.env;
  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(params.accountSettings);
  const settingsSecretsKey = deriveSettingsSecretsKeyForCredentials(params.credentials);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);

  const env: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(params.backend.env)) {
    const resolved = resolveMcpValueRefPlaintext({
      valueRef,
      savedSecretsById,
      settingsSecretsKey,
      settingsSecretsReadKeys,
      processEnv,
    });
    if (resolved === null) {
      throw new Error(`Missing ACP backend value for env:${envKey}`);
    }
    env[envKey] = resolved;
  }
  return env;
}
