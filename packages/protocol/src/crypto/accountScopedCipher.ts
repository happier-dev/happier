import tweetnacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

import { decodeBase64, encodeBase64 } from './base64.js';
import { deriveKey } from './keyDerivation.js';
import { parseSerializedJsonValue } from './serializedJsonValue.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/installationIdentity.js';

export type AccountScopedBlobKind =
  | 'account_settings'
  | 'automation_template_payload'
  | 'connected_service_credential'
  | 'connected_service_quota_snapshot'
  | 'provider_account_usage_snapshot'
  | 'qualified_connected_account_configuration'
  | 'session_first_intent'
  | 'session_owner_metadata'
  | 'session_organization_display'
  | 'session_respawn_environment';

export type AccountScopedCryptoMaterial =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export type AccountScopedCryptoMaterialSnapshotV1 = Readonly<{
  accountEncryptionMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial;
  contentPublicKeyFingerprint: string;
}>;

export type AccountScopedCiphertextFormat = 'account_scoped_v1' | 'legacy_secretbox';

export type AccountScopedKindTag =
  | 'canonical'
  | 'historical_alias'
  | 'untagged_legacy';

export type AccountScopedOpenResult =
  | Readonly<{
      format: 'account_scoped_v1';
      kindTag: 'canonical' | 'historical_alias';
      value: unknown;
    }>
  | Readonly<{
      format: 'legacy_secretbox';
      kindTag: 'untagged_legacy';
      value: unknown;
    }>
  | null;

export type AccountScopedHistoricalAliasResealResult = Readonly<{
  ciphertext: string;
  opened: Exclude<AccountScopedOpenResult, null>;
  resealed: boolean;
}>;

const ACCOUNT_SCOPED_MAGIC_V1 = 0xa1;

const ACCOUNT_SCOPED_KIND_BYTE: Record<AccountScopedBlobKind, number> = {
  account_settings: 1,
  automation_template_payload: 2,
  connected_service_credential: 3,
  connected_service_quota_snapshot: 4,
  session_respawn_environment: 5,
  provider_account_usage_snapshot: 6,
  session_organization_display: 7,
  session_first_intent: 8,
  qualified_connected_account_configuration: 9,
  session_owner_metadata: 10,
};

const HISTORICAL_ACCOUNT_SCOPED_KIND_BYTE_ALIASES:
  Partial<Record<AccountScopedBlobKind, readonly number[]>> = {
    provider_account_usage_snapshot: [5],
    session_respawn_environment: [6],
    qualified_connected_account_configuration: [8],
  };

const LEGACY_READ_ONLY_ACCOUNT_SCOPED_BLOB_KINDS = new Set<AccountScopedBlobKind>([
  'connected_service_quota_snapshot',
]);

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha512, key, data);
}

export function deriveAccountMachineKeyFromRecoverySecret(recoverySecret: Uint8Array): Uint8Array {
  const contentSeed = deriveKey(recoverySecret, 'Happy EnCoder', ['content']);
  // libsodium crypto_box_seed_keypair uses SHA-512(seed) and takes the first 32 bytes as the scalar.
  return sha512(contentSeed).slice(0, 32);
}

function clone32ByteKey(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`Invalid ${label}: expected 32 bytes`);
  }
  return new Uint8Array(value);
}

/**
 * Captures the complete client-side Account currentness input used by one
 * Session owner-migration sealing attempt.
 *
 * Data-key credentials are admitted only when their public/private X25519
 * pair is exact. Legacy credentials derive the same X25519 public key from the
 * recovery-secret-derived Account machine key. Input bytes are copied so a
 * later credential refresh cannot mutate the attempt already being sealed.
 */
export function createAccountScopedCryptoMaterialSnapshotV1(params: Readonly<{
  accountEncryptionMode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial;
  dataKeyPublicKey?: Uint8Array;
}>): AccountScopedCryptoMaterialSnapshotV1 {
  if (
    params.accountEncryptionMode !== 'plain'
    && params.accountEncryptionMode !== 'e2ee'
  ) {
    throw new Error('Invalid Account encryption mode');
  }

  let material: AccountScopedCryptoMaterial;
  let contentPublicKey: Uint8Array;
  if (params.material.type === 'legacy') {
    if (params.dataKeyPublicKey !== undefined) {
      throw new Error('Legacy Account material cannot carry a data-key public key');
    }
    const secret = clone32ByteKey('Account recovery secret', params.material.secret);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    material = { type: 'legacy', secret };
    contentPublicKey = new Uint8Array(
      tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    );
  } else {
    const machineKey = clone32ByteKey(
      'Account data-key private machine key',
      params.material.machineKey,
    );
    const suppliedPublicKey = clone32ByteKey(
      'Account data-key public key',
      params.dataKeyPublicKey ?? new Uint8Array(0),
    );
    const derivedPublicKey = new Uint8Array(
      tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    );
    if (!tweetnacl.verify(derivedPublicKey, suppliedPublicKey)) {
      throw new Error(
        'Account data-key public key does not match its private machine key',
      );
    }
    material = { type: 'dataKey', machineKey };
    contentPublicKey = derivedPublicKey;
  }

  return {
    accountEncryptionMode: params.accountEncryptionMode,
    material,
    contentPublicKeyFingerprint:
      computeContentPublicKeyFingerprint(contentPublicKey),
  };
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
    return parseSerializedJsonValue(decoded);
  } catch {
    return null;
  }
}

function sealAccountScopedBlobCiphertextWithKindByte(params: {
  kind: AccountScopedBlobKind;
  kindByte: number;
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}): string {
  if (!Number.isFinite(params.kindByte)) {
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
  out[1] = params.kindByte;
  out.set(nonce, 2);
  out.set(boxed, 2 + nonce.length);

  return encodeBase64(out, 'base64');
}

export function sealAccountScopedBlobCiphertext(params: {
  kind: AccountScopedBlobKind;
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}): string {
  if (LEGACY_READ_ONLY_ACCOUNT_SCOPED_BLOB_KINDS.has(params.kind)) {
    throw new Error(`Account-scoped blob kind ${params.kind} is legacy read-only and cannot be sealed`);
  }
  const kindByte = ACCOUNT_SCOPED_KIND_BYTE[params.kind];
  return sealAccountScopedBlobCiphertextWithKindByte({
    ...params,
    kindByte,
  });
}

/**
 * Host-only compatibility primitive. The public general sealer deliberately
 * refuses kind 4; only the connected-service quota compatibility owner imports
 * this function, and it always authenticates the historical quota domain.
 */
export function sealLegacyQuotaSnapshotAccountScopedCiphertext(params: {
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}): string {
  return sealAccountScopedBlobCiphertextWithKindByte({
    kind: 'connected_service_quota_snapshot',
    kindByte: ACCOUNT_SCOPED_KIND_BYTE.connected_service_quota_snapshot,
    material: params.material,
    payload: params.payload,
    randomBytes: params.randomBytes,
  });
}

export function readAccountScopedCiphertextKindByte(
  ciphertext: string,
): number | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(ciphertext, 'base64');
  } catch {
    return null;
  }
  if (
    bytes.length < 2 + tweetnacl.secretbox.nonceLength + 16
    || bytes[0] !== ACCOUNT_SCOPED_MAGIC_V1
  ) {
    return null;
  }
  return bytes[1] ?? null;
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
    const kindTag =
      bytes[1] === kindByte
        ? 'canonical'
        : HISTORICAL_ACCOUNT_SCOPED_KIND_BYTE_ALIASES[params.kind]?.includes(
            bytes[1]!,
          ) === true
          ? 'historical_alias'
          : null;
    if (!kindTag) {
      return null;
    }
    const nonce = bytes.slice(2, 2 + tweetnacl.secretbox.nonceLength);
    const boxed = bytes.slice(2 + tweetnacl.secretbox.nonceLength);
    const key = deriveAccountScopedSecretboxKey({ machineKey, kind: params.kind });
    const opened = tweetnacl.secretbox.open(boxed, nonce, key);
    const parsed = opened ? tryParseJson(new Uint8Array(opened)) : null;
    if (parsed !== null) {
      return { format: 'account_scoped_v1', kindTag, value: parsed };
    }
  }

  // Untagged historical secretboxes carry no authenticated kind/domain.
  // Account settings and automation templates shared the same released key and
  // admit overlapping JSON, so generic or owner-local raw fallback would permit
  // cross-domain substitution. Reject them here; any future recovery mechanism
  // requires an explicit, independently authenticated owner discriminator.
  return null;
}

export function resealAccountScopedHistoricalAliasCiphertext(params: {
  kind: Exclude<AccountScopedBlobKind, 'connected_service_quota_snapshot'>;
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
  randomBytes: (length: number) => Uint8Array;
  validatePayload: (value: unknown) => unknown | null;
}): AccountScopedHistoricalAliasResealResult | null {
  const opened = openAccountScopedBlobCiphertext(params);
  if (!opened) return null;
  const validatedPayload = params.validatePayload(opened.value);
  if (validatedPayload === null) return null;
  const validatedOpened = {
    ...opened,
    value: validatedPayload,
  };
  if (
    opened.format !== 'account_scoped_v1'
    || opened.kindTag !== 'historical_alias'
  ) {
    return {
      ciphertext: params.ciphertext,
      opened: validatedOpened,
      resealed: false,
    };
  }
  return {
    ciphertext: sealAccountScopedBlobCiphertext({
      kind: params.kind,
      material: params.material,
      payload: validatedPayload,
      randomBytes: params.randomBytes,
    }),
    opened: validatedOpened,
    resealed: true,
  };
}
