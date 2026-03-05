/**
 * MCP value ref resolution (CLI/runtime)
 *
 * Resolves MCP settings value references into plaintext strings at runtime:
 * - literal values may include `${VAR}` templates expanded from `processEnv`
 * - savedSecret values are looked up by id and decrypted using the settings secrets key
 */

import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import type { Credentials } from '@/persistence';
import {
  SecretStringV1Schema,
  decryptSecretValueV1,
  deriveSettingsSecretsKeyV1,
  type McpValueRefV1,
  type SecretStringV1,
} from '@happier-dev/protocol';

export function deriveSettingsSecretsKeyForCredentials(credentials: Credentials): Uint8Array {
  const masterSecret = credentials.encryption.type === 'legacy'
    ? credentials.encryption.secret
    : credentials.encryption.machineKey;
  return deriveSettingsSecretsKeyV1(masterSecret);
}

export function indexSavedSecretsByIdFromAccountSettings(settings: Readonly<Record<string, unknown>>): Map<string, SecretStringV1> {
  const out = new Map<string, SecretStringV1>();
  const raw = (settings as any)?.secrets;
  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = (item as any).id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const parsed = SecretStringV1Schema.safeParse((item as any).encryptedValue);
    if (!parsed.success) continue;
    out.set(id, parsed.data);
  }

  return out;
}

export function resolveMcpValueRefPlaintext(params: Readonly<{
  valueRef: McpValueRefV1;
  savedSecretsById: ReadonlyMap<string, SecretStringV1>;
  settingsSecretsKey: Uint8Array | null;
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
  return decryptSecretValueV1(container, params.settingsSecretsKey);
}

