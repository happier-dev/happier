import {
  decryptSecretStringV1,
  decryptSecretValueV1,
  deriveSettingsSecretsKeyV1,
  EncryptedStringV1Schema,
  encryptSecretStringV1,
  sealSecretsDeepV1,
  SecretStringV1Schema,
  unsealSecretsDeepV1,
  type EncryptedStringV1,
  type SecretStringV1,
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

export function encryptSecretString(value: string, key: Uint8Array): EncryptedString {
  return encryptSecretStringV1(value, key, getRandomBytes);
}

export function decryptSecretString(valueEnc: EncryptedString, key: Uint8Array): string | null {
  return decryptSecretStringV1(valueEnc, key);
}

export function decryptSecretValue(input: SecretString | null | undefined, key: Uint8Array | null): string | null {
  return decryptSecretValueV1(input, key);
}

export function sealSecretsDeep<T>(input: T, key: Uint8Array | null): T {
  return sealSecretsDeepV1(input, key, getRandomBytes);
}

export function unsealSecretsDeep<T>(input: T, key: Uint8Array | null): T {
  return unsealSecretsDeepV1(input, key);
}
