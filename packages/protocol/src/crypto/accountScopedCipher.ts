import tweetnacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

import { decodeBase64, encodeBase64 } from './base64.js';

export type AccountScopedBlobKind = 'account_settings' | 'automation_template_payload';

export type AccountScopedCryptoMaterial =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export type AccountScopedCiphertextFormat = 'account_scoped_v1' | 'legacy_secretbox';

export type AccountScopedOpenResult =
  | Readonly<{ format: AccountScopedCiphertextFormat; value: unknown }>
  | null;

const ACCOUNT_SCOPED_MAGIC_V1 = 0xa1;

const ACCOUNT_SCOPED_KIND_BYTE: Record<AccountScopedBlobKind, number> = {
  account_settings: 1,
  automation_template_payload: 2,
};

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data);
}

type KeyTreeState = Readonly<{ key: Uint8Array; chainCode: Uint8Array }>;

function deriveSecretKeyTreeRoot(seed: Uint8Array, usage: string): KeyTreeState {
  const I = hmacSha512(encodeUtf8(`${usage} Master Seed`), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveSecretKeyTreeChild(chainCode: Uint8Array, index: string): KeyTreeState {
  const indexBytes = encodeUtf8(index);
  const data = new Uint8Array(1 + indexBytes.length);
  data[0] = 0;
  data.set(indexBytes, 1);
  const I = hmacSha512(chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveKey(master: Uint8Array, usage: string, path: readonly string[]): Uint8Array {
  let state = deriveSecretKeyTreeRoot(master, usage);
  for (const index of path) {
    state = deriveSecretKeyTreeChild(state.chainCode, index);
  }
  return state.key;
}

export function deriveAccountMachineKeyFromRecoverySecret(recoverySecret: Uint8Array): Uint8Array {
  const contentSeed = deriveKey(recoverySecret, 'Happy EnCoder', ['content']);
  // libsodium crypto_box_seed_keypair uses SHA-512(seed) and takes the first 32 bytes as the scalar.
  return sha512(contentSeed).slice(0, 32);
}

function resolveMachineKey(material: AccountScopedCryptoMaterial): Uint8Array {
  return material.type === 'dataKey'
    ? material.machineKey
    : deriveAccountMachineKeyFromRecoverySecret(material.secret);
}

function deriveAccountScopedSecretboxKey(params: { machineKey: Uint8Array; kind: AccountScopedBlobKind }): Uint8Array {
  const info = encodeUtf8(`happier:account_scoped:${params.kind}:v1`);
  return hmacSha512(params.machineKey, info).slice(0, 32);
}

function tryParseJson(value: Uint8Array): unknown | null {
  try {
    const decoded = new TextDecoder().decode(value);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function sealAccountScopedBlobCiphertext(params: {
  kind: AccountScopedBlobKind;
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}): string {
  const kindByte = ACCOUNT_SCOPED_KIND_BYTE[params.kind];
  if (!Number.isFinite(kindByte)) {
    throw new Error(`Unsupported account-scoped blob kind: ${String(params.kind)}`);
  }

  const machineKey = resolveMachineKey(params.material);
  const key = deriveAccountScopedSecretboxKey({ machineKey, kind: params.kind });
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }

  const plaintextBytes = encodeUtf8(JSON.stringify(params.payload));
  const boxed = tweetnacl.secretbox(plaintextBytes, nonce, key);

  const out = new Uint8Array(2 + nonce.length + boxed.length);
  out[0] = ACCOUNT_SCOPED_MAGIC_V1;
  out[1] = kindByte;
  out.set(nonce, 2);
  out.set(boxed, 2 + nonce.length);

  return encodeBase64(out, 'base64');
}

export function openAccountScopedBlobCiphertext(params: {
  kind: AccountScopedBlobKind;
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}): AccountScopedOpenResult {
  const kindByte = ACCOUNT_SCOPED_KIND_BYTE[params.kind];
  if (!Number.isFinite(kindByte)) {
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(params.ciphertext, 'base64');
  } catch {
    return null;
  }

  const machineKey = resolveMachineKey(params.material);

  if (bytes.length >= 2 + tweetnacl.secretbox.nonceLength + 16 && bytes[0] === ACCOUNT_SCOPED_MAGIC_V1) {
    if (bytes[1] !== kindByte) {
      return null;
    }
    const nonce = bytes.slice(2, 2 + tweetnacl.secretbox.nonceLength);
    const boxed = bytes.slice(2 + tweetnacl.secretbox.nonceLength);
    const key = deriveAccountScopedSecretboxKey({ machineKey, kind: params.kind });
    const opened = tweetnacl.secretbox.open(boxed, nonce, key);
    const parsed = opened ? tryParseJson(new Uint8Array(opened)) : null;
    if (parsed === null) {
      return null;
    }
    return { format: 'account_scoped_v1', value: parsed };
  }

  // Backwards compatibility: legacy secretbox payloads that omitted magic/version bytes.
  // Try opening with either:
  // - raw machineKey (dataKey mode, e.g. old automation templates)
  // - raw recovery secret (legacy mode, e.g. old account settings/templates)
  if (bytes.length < tweetnacl.secretbox.nonceLength + 16) {
    return null;
  }

  const nonce = bytes.slice(0, tweetnacl.secretbox.nonceLength);
  const boxed = bytes.slice(tweetnacl.secretbox.nonceLength);

  const candidates: Uint8Array[] = [];
  candidates.push(machineKey);
  if (params.material.type === 'legacy') {
    candidates.push(params.material.secret);
  }

  for (const key of candidates) {
    try {
      const opened = tweetnacl.secretbox.open(boxed, nonce, key);
      const parsed = opened ? tryParseJson(new Uint8Array(opened)) : null;
      if (parsed !== null) {
        return { format: 'legacy_secretbox', value: parsed };
      }
    } catch {
      // continue
    }
  }

  return null;
}
