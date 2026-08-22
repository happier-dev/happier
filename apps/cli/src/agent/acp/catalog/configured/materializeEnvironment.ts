import type { StoredCredentials } from '@/persistence';
import {
  deriveSettingsSecretsReadKeysForCredentials,
  indexSavedSecretsByIdFromAccountSettings,
  resolveMcpValueRefPlaintext,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export function materializeConfiguredAcpEnvironment(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  accountSettings: Readonly<Record<string, unknown>>;
  credentials: StoredCredentials;
  processEnv?: NodeJS.ProcessEnv;
}>): Record<string, string> {
  const processEnv = params.processEnv ?? process.env;
  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(params.accountSettings);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);

  const env: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(params.backend.env)) {
    const resolved = resolveMcpValueRefPlaintext({
      valueRef,
      savedSecretsById,
      settingsSecretsKey: null,
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
