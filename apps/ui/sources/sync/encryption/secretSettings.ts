import {
  decryptSecretStringV1,
  decryptSecretValueV1,
  decryptSecretValueWithKeysV1,
  deriveSettingsSecretsKeySetV1,
  deriveSettingsSecretsKeyV1,
  EncryptedStringV1Schema,
  encryptSecretStringV1,
  resealSecretsDeepV1,
  sealSecretsDeepV1,
  SecretStringV1Schema,
  unsealSecretsDeepV1,
  unsealSecretsDeepWithKeysV1,
  type EncryptedStringV1,
  type SettingsSecretsKeySetV1,
  type SecretStringV1,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

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

function hasUnsealedSecretValue(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const pending: object[] = [input as object];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    if (
      !Array.isArray(current)
      && (current as Record<string, unknown>)._isSecretValue === true
      && typeof (current as Record<string, unknown>).value === 'string'
    ) {
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
