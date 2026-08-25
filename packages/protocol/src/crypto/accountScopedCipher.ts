import tweetnacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

import {
  ACCOUNT_SCOPED_BLOB_V1_MAGIC,
  ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES,
  getAccountScopedBlobKindByte,
  type AccountScopedBlobKind,
} from './accountScopedCipherEnvelope.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { computeCanonicalDomainSeparatedDigest } from './canonicalDigest.js';
import { deriveKey } from './keyDerivation.js';
import { parseSerializedJsonValue } from './serializedJsonValue.js';
import { computeContentPublicKeyFingerprint } from '../machines/identity/installationIdentity.js';

export {
  getAccountScopedBlobCiphertextBase64LengthV1,
  isAccountScopedBlobCiphertextForKind,
  readAccountScopedCiphertextKindByte,
} from './accountScopedCipherEnvelope.js';
export type { AccountScopedBlobKind } from './accountScopedCipherEnvelope.js';

export type AccountScopedCryptoMaterial =
  | Readonly<{ type: 'legacy'; secret: Uint8Array }>
  | Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export type AccountScopedCryptoMaterialSnapshotV1 = Readonly<{
  accountEncryptionMode: 'e2ee';
  material: AccountScopedCryptoMaterial;
  contentPublicKeyFingerprint: string;
}>;

export type AccountScopedCiphertextFormat = 'account_scoped_v1' | 'legacy_secretbox';

export type AccountScopedKindTag = 'canonical' | 'untagged_legacy';

export type AccountScopedOpenResult =
  | Readonly<{
      format: 'account_scoped_v1';
      kindTag: 'canonical';
      value: unknown;
    }>
  | Readonly<{
      format: 'legacy_secretbox';
      kindTag: 'untagged_legacy';
      value: unknown;
    }>
  | null;

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
  accountEncryptionMode: 'e2ee';
  material: AccountScopedCryptoMaterial;
  dataKeyPublicKey?: Uint8Array;
}>): AccountScopedCryptoMaterialSnapshotV1 {
  if (params.accountEncryptionMode !== 'e2ee') {
    throw new Error('Account-scoped crypto material requires E2EE Account mode');
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

/**
 * Narrow host-only derivation for Automation Event occurrence equality. It is
 * deliberately separate from every Account-scoped ciphertext key and does not
 * expose a caller-selected key-derivation API.
 */
export function deriveAutomationTriggerEvidenceEqualityKeyV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
}>): Uint8Array {
  return hmacSha512(
    resolveMachineKey(params.material),
    encodeUtf8('happier:automation-occurrence-equality:v1:trigger-evidence'),
  ).slice(0, 32);
}

/**
 * Domain constants of the plugin Collection identity operation below. They are
 * module state, never parameters: a caller-selected usage, path, domain or
 * version would turn this into an Account-root pseudonym oracle.
 *
 * `PLUGIN_COLLECTION_IDENTITY_VERSION_V1` separates a future derivation change
 * from this one. It is deliberately not a collection `schemaVersion` or
 * `contractDigest`: binding either would re-key every stored identity on an
 * ordinary schema bump and detach a corpus from its own rows.
 */
const PLUGIN_COLLECTION_IDENTITY_VERSION_V1 = 'v1';
const PLUGIN_COLLECTION_IDENTITY_KEYED_USAGE_V1 = 'Happier Plugin Collection Identity';
const PLUGIN_COLLECTION_IDENTITY_PLAIN_DOMAIN_V1 = 'happier:plugin-collection-identity:v1:plain';

/**
 * The closed identity-tag operation behind `PluginAccountCollection.identityTag`.
 *
 * It does not expose a caller-selected key-derivation API: the plugin supplies
 * only identity components, while the mode, version, plugin, collection and
 * field are stamped by the host from state the plugin cannot influence. Two
 * plugins, two collections, or two fields therefore live in disjoint derivation
 * domains by construction rather than by convention.
 *
 * Both arms return 43 characters over `[A-Za-z0-9_-]`, so the result is always a
 * valid Collection row id and indexed string whatever the natural key contained.
 * The keyed arm consumes each component in its own HMAC step and the plaintext
 * arm length-delimits each one, so component boundaries survive any byte a
 * contract-valid identity may contain — including a delimiter.
 */
export function derivePluginCollectionIdentityTagV1(params: Readonly<{
  accountEncryptionMode: 'plain' | 'e2ee';
  /** `null` on `plain`, required on `e2ee`. Either mismatch fails closed. */
  material: AccountScopedCryptoMaterial | null;
  /** Host-stamped from the bound plugin lifecycle. Never caller-supplied. */
  pluginId: string;
  /** Host-stamped from the admitted collection contract. Never caller-supplied. */
  collectionId: string;
  /** Host-validated against that contract: its row-id field, or a declared index field. */
  field: string;
  /** The only caller-supplied input. */
  components: readonly string[];
}>): string {
  const { accountEncryptionMode, material, pluginId, collectionId, field, components } = params;
  if (accountEncryptionMode === 'e2ee') {
    if (!material) {
      throw new Error('An E2EE Account requires Account-scoped identity material for a plugin Collection identity tag');
    }
    return encodeBase64(
      deriveKey(
        resolveMachineKey(material),
        PLUGIN_COLLECTION_IDENTITY_KEYED_USAGE_V1,
        [
          PLUGIN_COLLECTION_IDENTITY_VERSION_V1,
          accountEncryptionMode,
          pluginId,
          collectionId,
          field,
          ...components,
        ],
      ),
      'base64url',
    );
  }
  if (material) {
    throw new Error('A plaintext Account has no Account-scoped identity material for a plugin Collection identity tag');
  }
  return computeCanonicalDomainSeparatedDigest(
    PLUGIN_COLLECTION_IDENTITY_PLAIN_DOMAIN_V1,
    [pluginId, collectionId, field, ...components],
  );
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
  const nonce = params.randomBytes(ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES);
  if (nonce.length !== ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }

  const plaintextBytes = encodeUtf8(JSON.stringify(params.payload));
  const boxed = tweetnacl.secretbox(plaintextBytes, nonce, key);

  const out = new Uint8Array(ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES + nonce.length + boxed.length);
  out[0] = ACCOUNT_SCOPED_BLOB_V1_MAGIC;
  out[1] = params.kindByte;
  out.set(nonce, ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES);
  out.set(boxed, ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES + nonce.length);

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
  const kindByte = getAccountScopedBlobKindByte(params.kind);
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
    kindByte: getAccountScopedBlobKindByte('connected_service_quota_snapshot'),
    material: params.material,
    payload: params.payload,
    randomBytes: params.randomBytes,
  });
}

export function openAccountScopedBlobCiphertext(params: {
  kind: AccountScopedBlobKind;
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}): AccountScopedOpenResult {
  const kindByte = getAccountScopedBlobKindByte(params.kind);
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

  if (
    bytes.length >= (
      ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES
      + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES
      + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    )
    && bytes[0] === ACCOUNT_SCOPED_BLOB_V1_MAGIC
  ) {
    if (bytes[1] !== kindByte) {
      return null;
    }
    const nonce = bytes.slice(
      ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES,
      ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
    );
    const boxed = bytes.slice(
      ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
    );
    const key = deriveAccountScopedSecretboxKey({ machineKey, kind: params.kind });
    const opened = tweetnacl.secretbox.open(boxed, nonce, key);
    const parsed = opened ? tryParseJson(new Uint8Array(opened)) : null;
    if (parsed !== null) {
      return { format: 'account_scoped_v1', kindTag: 'canonical', value: parsed };
    }
  }

  // Untagged historical secretboxes carry no authenticated kind/domain.
  // Account settings and automation templates shared the same released key and
  // admit overlapping JSON, so generic or owner-local raw fallback would permit
  // cross-domain substitution. Reject them here; any future recovery mechanism
  // requires an explicit, independently authenticated owner discriminator.
  return null;
}
