/**
 * MCP value ref resolution (CLI/runtime)
 *
 * Resolves MCP settings value references into plaintext strings at runtime:
 * - literal values may include `${VAR}` templates expanded from `processEnv`
 * - savedSecret values are looked up by id and decrypted using the settings secrets key
 */

import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import {
  decryptSecretValueWithKeysV1,
  type McpValueRefV1,
  type SecretStringV1,
} from '@happier-dev/protocol';

export {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';
export { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

export function resolveMcpValueRefPlaintext(params: Readonly<{
  valueRef: McpValueRefV1;
  savedSecretsById: ReadonlyMap<string, SecretStringV1>;
  settingsSecretsKey: Uint8Array | null;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  if (params.valueRef.t === 'literal') {
    const expanded = expandEnvironmentVariables({ __VALUE__: params.valueRef.v }, params.processEnv, { warnOnUndefined: false })
      .__VALUE__;
    if (typeof expanded !== 'string') return null;
    if (params.valueRef.v.includes('${') && expanded.includes('${')) return null;
    return expanded;
  }

  const container = params.savedSecretsById.get(params.valueRef.secretId) ?? null;
  if (!container) return null;
  return decryptSecretValueWithKeysV1(
    container,
    params.settingsSecretsReadKeys ?? (params.settingsSecretsKey ? [params.settingsSecretsKey] : []),
  );
}
