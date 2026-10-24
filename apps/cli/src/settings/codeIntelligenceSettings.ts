import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  CodeIntelligenceSettingsV1Schema,
  decryptSecretValueWithKeysV1,
  normalizeCodeIntelligenceSettings,
  sealSecretsDeepV1,
  type CodeIntelligenceAnalysisProviderV1,
  type CodeIntelligenceSettingsV1,
} from '@happier-dev/protocol';

import { readCredentials, readSettings, updateSettings } from '@/persistence';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

/**
 * Reads persisted settings with API keys still sealed. Keys are opened only at request time by
 * `resolveCodeIntelligenceProviderApiKey`, so plaintext keys never sit in worker state or logs.
 */
export async function readCodeIntelligenceSettingsFromDisk(): Promise<CodeIntelligenceSettingsV1> {
  const settings = await readSettings();
  return normalizeCodeIntelligenceSettings(settings.codeIntelligence);
}

/**
 * A client round-trips redacted settings (`{ _isSecretValue: true }` without a value); an incoming
 * key with neither a new value nor ciphertext keeps the provider's stored key.
 */
function mergeIncomingProviderSecrets(
  previous: CodeIntelligenceSettingsV1,
  next: CodeIntelligenceSettingsV1,
): CodeIntelligenceSettingsV1 {
  const previousById = new Map(previous.remoteAnalysis.providers.map((provider) => [provider.id, provider]));
  const providers = next.remoteAnalysis.providers.map((provider): CodeIntelligenceAnalysisProviderV1 => {
    const incoming = provider.apiKey;
    const keepsStored = incoming !== null && !incoming.value && !incoming.encryptedValue;
    return keepsStored ? { ...provider, apiKey: previousById.get(provider.id)?.apiKey ?? null } : provider;
  });
  return { ...next, remoteAnalysis: { ...next.remoteAnalysis, providers } };
}

/** Null when there is no account encryption material (signed out, or token-only credentials). */
async function readSettingsSecretsKeys(): Promise<Readonly<{ writeKey: Uint8Array; readKeys: readonly Uint8Array[] }> | null> {
  const credentials = await readCredentials();
  if (!credentials) return null;
  try {
    return {
      writeKey: deriveSettingsSecretsKeyForCredentials(credentials),
      readKeys: deriveSettingsSecretsReadKeysForCredentials(credentials),
    };
  } catch {
    return null;
  }
}

export async function writeCodeIntelligenceSettingsToDisk(raw: unknown): Promise<CodeIntelligenceSettingsV1> {
  const previous = await readCodeIntelligenceSettingsFromDisk();
  const merged = mergeIncomingProviderSecrets(previous, CodeIntelligenceSettingsV1Schema.parse(raw));
  const keys = await readSettingsSecretsKeys();
  if (!keys && merged.remoteAnalysis.providers.some((provider) => provider.apiKey?.value)) {
    // Without account key material a key could only be stored in plaintext; refuse instead.
    throw new Error('Cannot store an analysis provider API key without account encryption keys on this machine');
  }
  const sealed = keys
    ? sealSecretsDeepV1(merged, keys.writeKey, (length) => new Uint8Array(nodeRandomBytes(length)))
    : merged;
  await updateSettings((current) => ({ ...current, codeIntelligence: sealed }));
  return sealed;
}

export async function resolveCodeIntelligenceProviderApiKey(provider: CodeIntelligenceAnalysisProviderV1): Promise<string | null> {
  if (!provider.apiKey) return null;
  const keys = await readSettingsSecretsKeys();
  return decryptSecretValueWithKeysV1(provider.apiKey, keys?.readKeys ?? []);
}
