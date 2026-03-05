import { z } from 'zod';

import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from './base64.js';
import { deriveKey } from './keyDerivation.js';

export const EncryptedStringV1Schema = z.object({
  t: z.literal('enc-v1'),
  c: z.string().min(1),
});

export type EncryptedStringV1 = z.infer<typeof EncryptedStringV1Schema>;

export const SecretStringV1Schema = z.object({
  _isSecretValue: z.literal(true),
  value: z.string().min(1).optional(),
  encryptedValue: EncryptedStringV1Schema.optional(),
});

export type SecretStringV1 = z.infer<typeof SecretStringV1Schema>;

const SETTINGS_SECRETS_USAGE = 'Happy Settings Secrets';
const SETTINGS_SECRETS_PATH = ['settings', 'secrets', 'v1'] as const;

export function deriveSettingsSecretsKeyV1(masterSecret: Uint8Array): Uint8Array {
  return deriveKey(masterSecret, SETTINGS_SECRETS_USAGE, SETTINGS_SECRETS_PATH);
}

export function encryptSecretStringV1(
  value: string,
  key: Uint8Array,
  randomBytes: (length: number) => Uint8Array,
): EncryptedStringV1 {
  const nonce = randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }
  const message = new TextEncoder().encode(value);
  const boxed = tweetnacl.secretbox(message, nonce, key);

  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce, 0);
  combined.set(boxed, nonce.length);
  return { t: 'enc-v1', c: encodeBase64(combined, 'base64') };
}

export function decryptSecretStringV1(enc: EncryptedStringV1, key: Uint8Array): string | null {
  try {
    const combined = decodeBase64(enc.c, 'base64');
    if (combined.length < tweetnacl.secretbox.nonceLength + 16) return null;
    const nonce = combined.slice(0, tweetnacl.secretbox.nonceLength);
    const boxed = combined.slice(tweetnacl.secretbox.nonceLength);
    const opened = tweetnacl.secretbox.open(boxed, nonce, key);
    if (!opened) return null;
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

export function decryptSecretValueV1(input: SecretStringV1 | null | undefined, key: Uint8Array | null): string | null {
  if (!input) return null;
  const plaintext = typeof input.value === 'string' ? input.value.trim() : '';
  if (plaintext) return plaintext;
  if (!key) return null;
  if (!input.encryptedValue) return null;
  return decryptSecretStringV1(input.encryptedValue, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sealSecretsDeepV1<T>(
  input: T,
  key: Uint8Array | null,
  randomBytes: (length: number) => Uint8Array,
): T {
  if (!key) return input;

  if (Array.isArray(input)) {
    let out: any[] | null = null;
    for (let i = 0; i < input.length; i++) {
      const item = (input as any)[i];
      const sealed = sealSecretsDeepV1(item, key, randomBytes);
      if (out) {
        out[i] = sealed;
        continue;
      }
      if (sealed !== item) {
        out = new Array(input.length);
        for (let j = 0; j < i; j++) out[j] = (input as any)[j];
        out[i] = sealed;
      }
    }
    return (out ? out : input) as any;
  }

  if (!isPlainObject(input)) return input;

  if ((input as any)._isSecretValue === true) {
    const value = typeof (input as any).value === 'string' ? String((input as any).value).trim() : '';
    if (value.length > 0) {
      const encryptedValue = encryptSecretStringV1(value, key, randomBytes);
      const { value: _dropped, ...rest } = input as any;
      return { ...rest, encryptedValue } as any;
    }
    return input as any;
  }

  let out: any = input;
  for (const [k, v] of Object.entries(input)) {
    const sealedChild = sealSecretsDeepV1(v, key, randomBytes);
    if (sealedChild !== v) {
      if (out === input) out = { ...(input as any) };
      out[k] = sealedChild;
    }
  }
  return out;
}

export function unsealSecretsDeepV1<T>(input: T, key: Uint8Array | null): T {
  if (!key) return input;

  if (Array.isArray(input)) {
    let out: any[] | null = null;
    for (let i = 0; i < input.length; i++) {
      const item = (input as any)[i];
      const unsealed = unsealSecretsDeepV1(item, key);
      if (out) {
        out[i] = unsealed;
        continue;
      }
      if (unsealed !== item) {
        out = new Array(input.length);
        for (let j = 0; j < i; j++) out[j] = (input as any)[j];
        out[i] = unsealed;
      }
    }
    return (out ? out : input) as any;
  }

  if (!isPlainObject(input)) return input;

  if ((input as any)._isSecretValue === true) {
    const hasPlain = typeof (input as any).value === 'string' && String((input as any).value).trim().length > 0;
    if (hasPlain) return input as any;
    const encryptedValue = (input as any).encryptedValue;
    const parsed = EncryptedStringV1Schema.safeParse(encryptedValue);
    if (!parsed.success) return input as any;

    const opened = decryptSecretStringV1(parsed.data, key);
    if (!opened) return input as any;
    const { encryptedValue: _dropped, ...rest } = input as any;
    return { ...rest, value: opened } as any;
  }

  let out: any = input;
  for (const [k, v] of Object.entries(input)) {
    const unsealedChild = unsealSecretsDeepV1(v, key);
    if (unsealedChild !== v) {
      if (out === input) out = { ...(input as any) };
      out[k] = unsealedChild;
    }
  }
  return out;
}

