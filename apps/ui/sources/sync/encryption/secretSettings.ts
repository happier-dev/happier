import { decryptSecretStringV1, decryptSecretValueV1, decryptSecretValueWithKeysV1, deriveSettingsSecretsKeySetV1, deriveSettingsSecretsKeyV1, encryptSecretStringV1, resealSecretsDeepV1, sealSecretsDeepV1, unsealSecretsDeepV1, unsealSecretsDeepWithKeysV1, type SettingsSecretsKeySetV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { EncryptedStringV1Schema, SecretStringV1Schema, type EncryptedStringV1, type SecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringSchemasV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { getRandomBytes } from '@/platform/cryptoRandom';

// Note: this module must remain safe for vitest/node (no react-native import).

export const EncryptedStringSchema = EncryptedStringV1Schema;
export type EncryptedString = EncryptedStringV1;

export const SecretStringSchema = SecretStringV1Schema;
export type SecretString = SecretStringV1;

export async function deriveSettingsSecretsKey(masterSecret: Uint8Array): Promise<Uint8Array> {
  return deriveSettingsSecretsKeyV1(masterSecret);
}

export function deriveSettingsSecretsKeySet(material: AccountScopedCryptoMaterial): SettingsSecretsKeySetV1 {
  return deriveSettingsSecretsKeySetV1(material);
}

export function encryptSecretString(value: string, key: Uint8Array): EncryptedString {
  return encryptSecretStringV1(value, key, getRandomBytes);
}

export function decryptSecretString(valueEnc: EncryptedString, key: Uint8Array): string | null {
  return decryptSecretStringV1(valueEnc, key);
}

export function decryptSecretValue(input: SecretString | null | undefined, key: Uint8Array | null): string | null {
  return decryptSecretValueV1(input, key);
}

export function decryptSecretValueWithKeys(
  input: SecretString | null | undefined,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): string | null {
  return decryptSecretValueWithKeysV1(input, keys);
}

export class LocalSettingsSecretUnavailableError extends Error {
  readonly code = 'local_secret_unavailable' as const;

  constructor() {
    super('Local settings secret key is unavailable');
    this.name = 'LocalSettingsSecretUnavailableError';
  }
}

function hasSecretValueMatching(
  input: unknown,
  predicate: (value: Readonly<Record<string, unknown>>) => boolean,
): boolean {
  if (!input || typeof input !== 'object') return false;
  const pending: object[] = [input as object];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    const record = Array.isArray(current) ? null : current as Record<string, unknown>;
    if (record?._isSecretValue === true && predicate(record)) {
      return true;
    }

    for (const child of Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>)) {
      if (child && typeof child === 'object') pending.push(child as object);
    }
  }

  return false;
}

function hasUnsealedSecretValue(input: unknown): boolean {
  return hasSecretValueMatching(input, (value) => typeof value.value === 'string');
}

function hasSecretValueUnsafeForPlainStorage(input: unknown): boolean {
  return hasSecretValueMatching(input, (value) => {
    const parsed = SecretStringV1Schema.safeParse(value);
    return !parsed.success
      || typeof parsed.data.value !== 'string'
      || parsed.data.value.trim().length === 0
      || parsed.data.encryptedValue !== undefined;
  });
}

export function assertNoUnsealedSettingsSecretValues(input: unknown): void {
  if (hasUnsealedSecretValue(input)) {
    throw new LocalSettingsSecretUnavailableError();
  }
}

export function sealSecretsDeep<T>(input: T, key: Uint8Array | null): T {
  if (!key) assertNoUnsealedSettingsSecretValues(input);
  return sealSecretsDeepV1(input, key, getRandomBytes);
}

export function resealSecretsDeep<T>(
  input: T,
  params: Readonly<{
    readKeys: ReadonlyArray<Uint8Array | null | undefined>;
    writeKey: Uint8Array;
  }>,
): { value: T; changed: boolean } {
  return resealSecretsDeepV1(input, { ...params, randomBytes: getRandomBytes });
}

export function unsealSecretsDeep<T>(input: T, key: Uint8Array | null): T {
  return unsealSecretsDeepV1(input, key);
}

export function unsealSecretsDeepWithKeys<T>(
  input: T,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): T {
  return unsealSecretsDeepWithKeysV1(input, keys);
}

export function unsealSecretsDeepWithKeysForPlainStorage<T>(
  input: T,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): T {
  const unsealed = unsealSecretsDeepWithKeysV1(input, keys);
  if (hasSecretValueUnsafeForPlainStorage(unsealed)) {
    throw new LocalSettingsSecretUnavailableError();
  }
  return unsealed;
}
