import { z } from 'zod';

import tweetnacl from 'tweetnacl';

import { decodeBase64, encodeBase64 } from './base64.js';
import {
  deriveAccountMachineKeyFromRecoverySecret,
  type AccountScopedCryptoMaterial,
} from './accountScopedCipher.js';
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
export type SettingsSecretsKeySetV1 = Readonly<{
  writeKey: Uint8Array;
  readKeys: readonly Uint8Array[];
}>;
export type ResealSecretsDeepV1Result<T> = Readonly<{
  value: T;
  changed: boolean;
}>;

const SETTINGS_SECRETS_USAGE = 'Happy Settings Secrets';
const SETTINGS_SECRETS_PATH = ['settings', 'secrets', 'v1'] as const;

export function deriveSettingsSecretsKeyV1(masterSecret: Uint8Array): Uint8Array {
  return deriveKey(masterSecret, SETTINGS_SECRETS_USAGE, SETTINGS_SECRETS_PATH);
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function deriveSettingsSecretsKeySetV1(material: AccountScopedCryptoMaterial): SettingsSecretsKeySetV1 {
  const canonicalSeed = material.type === 'dataKey'
    ? material.machineKey
    : deriveAccountMachineKeyFromRecoverySecret(material.secret);
  const writeKey = deriveSettingsSecretsKeyV1(canonicalSeed);
  const readKeys: Uint8Array[] = [writeKey];

  if (material.type === 'legacy') {
    const legacyFallbackKey = deriveSettingsSecretsKeyV1(material.secret);
    if (!byteArraysEqual(legacyFallbackKey, writeKey)) {
      readKeys.push(legacyFallbackKey);
    }
  }

  return { writeKey, readKeys };
}

export function encryptSecretStringV1(
  value: string,
  key: Uint8Array,
  randomBytes: (length: number) => Uint8Array,
): EncryptedStringV1 {
  if (key.length !== tweetnacl.secretbox.keyLength) {
    throw new Error(`Invalid secretbox key length: ${key.length}`);
  }
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

export function decryptSecretStringWithKeysV1(
  enc: EncryptedStringV1,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): string | null {
  for (const key of keys) {
    if (!key) continue;
    const opened = decryptSecretStringV1(enc, key);
    if (opened !== null) {
      return opened;
    }
  }
  return null;
}

export function decryptSecretValueV1(input: SecretStringV1 | null | undefined, key: Uint8Array | null): string | null {
  return decryptSecretValueWithKeysV1(input, key ? [key] : []);
}

export function decryptSecretValueWithKeysV1(
  input: SecretStringV1 | null | undefined,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): string | null {
  if (!input) return null;
  const plaintext = typeof input.value === 'string' ? input.value : null;
  if (plaintext !== null && plaintext.trim().length > 0) return plaintext;
  if (!input.encryptedValue) return null;
  return decryptSecretStringWithKeysV1(input.encryptedValue, keys);
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
    const rawValue = typeof (input as any).value === 'string' ? String((input as any).value) : null;
    if (rawValue !== null && rawValue.trim().length > 0) {
      const encryptedValue = encryptSecretStringV1(rawValue, key, randomBytes);
      const { value: _dropped, ...rest } = input as any;
      return { ...rest, encryptedValue } as any;
    }
    if (rawValue !== null) {
      const { value: _dropped, ...rest } = input as any;
      return rest as any;
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
  return unsealSecretsDeepWithKeysV1(input, key ? [key] : []);
}

export function unsealSecretsDeepWithKeysV1<T>(
  input: T,
  keys: ReadonlyArray<Uint8Array | null | undefined>,
): T {
  if (keys.length === 0) return input;

  if (Array.isArray(input)) {
    let out: any[] | null = null;
    for (let i = 0; i < input.length; i++) {
      const item = (input as any)[i];
      const unsealed = unsealSecretsDeepWithKeysV1(item, keys);
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
    if (hasPlain) {
      if ((input as any).encryptedValue === undefined) return input as any;
      const { encryptedValue: _dropped, ...rest } = input as any;
      return rest as any;
    }
    const encryptedValue = (input as any).encryptedValue;
    const parsed = EncryptedStringV1Schema.safeParse(encryptedValue);
    if (!parsed.success) return input as any;

    const opened = decryptSecretStringWithKeysV1(parsed.data, keys);
    if (!opened) return input as any;
    const { encryptedValue: _dropped, ...rest } = input as any;
    return { ...rest, value: opened } as any;
  }

  let out: any = input;
  for (const [k, v] of Object.entries(input)) {
    const unsealedChild = unsealSecretsDeepWithKeysV1(v, keys);
    if (unsealedChild !== v) {
      if (out === input) out = { ...(input as any) };
      out[k] = unsealedChild;
    }
  }
  return out;
}

export function resealSecretsDeepV1<T>(
  input: T,
  params: Readonly<{
    readKeys: ReadonlyArray<Uint8Array | null | undefined>;
    writeKey: Uint8Array;
    randomBytes: (length: number) => Uint8Array;
  }>,
): ResealSecretsDeepV1Result<T> {
  if (Array.isArray(input)) {
    let out: any[] | null = null;
    let changed = false;
    for (let index = 0; index < input.length; index += 1) {
      const child = (input as any)[index];
      const resealed = resealSecretsDeepV1(child, params);
      if (resealed.changed) {
        changed = true;
      }
      if (out) {
        out[index] = resealed.value;
        continue;
      }
      if (resealed.value !== child) {
        out = new Array(input.length);
        for (let copyIndex = 0; copyIndex < index; copyIndex += 1) {
          out[copyIndex] = (input as any)[copyIndex];
        }
        out[index] = resealed.value;
      }
    }
    return { value: (out ? out : input) as any, changed };
  }

  if (!isPlainObject(input)) {
    return { value: input, changed: false };
  }

  if ((input as any)._isSecretValue === true) {
    const plaintext = typeof (input as any).value === 'string' ? String((input as any).value).trim() : '';
    if (plaintext.length > 0) {
      const { value: _dropped, ...rest } = input as any;
      return {
        value: {
          ...rest,
          encryptedValue: encryptSecretStringV1(plaintext, params.writeKey, params.randomBytes),
        } as any,
        changed: true,
      };
    }

    const parsed = EncryptedStringV1Schema.safeParse((input as any).encryptedValue);
    if (!parsed.success) {
      return { value: input, changed: false };
    }

    if (decryptSecretStringV1(parsed.data, params.writeKey) !== null) {
      return { value: input, changed: false };
    }

    const opened = decryptSecretStringWithKeysV1(parsed.data, params.readKeys);
    if (opened === null) {
      return { value: input, changed: false };
    }

    return {
      value: {
        ...(input as any),
        encryptedValue: encryptSecretStringV1(opened, params.writeKey, params.randomBytes),
      } as any,
      changed: true,
    };
  }

  let out: any = input;
  let changed = false;
  for (const [key, child] of Object.entries(input)) {
    const resealed = resealSecretsDeepV1(child, params);
    if (resealed.changed) {
      changed = true;
    }
    if (resealed.value !== child) {
      if (out === input) out = { ...(input as any) };
      out[key] = resealed.value;
    }
  }

  return { value: out, changed };
}
