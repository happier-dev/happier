import tweetnacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

import {
  deriveAccountMachineKeyFromRecoverySecret,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import { getAccountScopedBlobKindByte } from '../crypto/accountScopedCipherEnvelope.js';
import { encodeBase64 } from '../crypto/base64.js';

const ACCOUNT_SCOPED_MAGIC_V1 = 0xa1;
const CONNECTED_SERVICE_QUOTA_SNAPSHOT_KIND_BYTE = 4;
const CONNECTED_SERVICE_QUOTA_SNAPSHOT_INFO = new TextEncoder().encode(
  'happier:account_scoped:connected_service_quota_snapshot:v1',
);
const SESSION_OWNER_METADATA_INFO =
  new TextEncoder().encode(
    'happier:account_scoped:session_owner_metadata:v1',
  );

function resolveMachineKey(material: AccountScopedCryptoMaterial): Uint8Array {
  return material.type === 'dataKey'
    ? material.machineKey
    : deriveAccountMachineKeyFromRecoverySecret(material.secret);
}

function deriveConnectedServiceQuotaSnapshotFixtureKey(machineKey: Uint8Array): Uint8Array {
  return hmac(sha512, machineKey, CONNECTED_SERVICE_QUOTA_SNAPSHOT_INFO).slice(0, 32);
}

export function sealLegacyConnectedServiceQuotaSnapshotFixtureCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  const machineKey = resolveMachineKey(params.material);
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(params.payload));
  const boxed = tweetnacl.secretbox(
    plaintextBytes,
    nonce,
    deriveConnectedServiceQuotaSnapshotFixtureKey(machineKey),
  );

  const out = new Uint8Array(2 + nonce.length + boxed.length);
  out[0] = ACCOUNT_SCOPED_MAGIC_V1;
  out[1] = CONNECTED_SERVICE_QUOTA_SNAPSHOT_KIND_BYTE;
  out.set(nonce, 2);
  out.set(boxed, 2 + nonce.length);

  return encodeBase64(out, 'base64');
}

/** Independent fixture writer for the canonical Session owner domain. */
export function sealSessionOwnerMetadataFixtureCiphertext(
  params: Readonly<{
    material: AccountScopedCryptoMaterial;
    payload: unknown;
    randomBytes: (length: number) => Uint8Array;
  }>,
): string {
  const machineKey = resolveMachineKey(params.material);
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }
  const key = hmac(
    sha512,
    machineKey,
    SESSION_OWNER_METADATA_INFO,
  ).slice(0, 32);
  const boxed = tweetnacl.secretbox(
    new TextEncoder().encode(JSON.stringify(params.payload)),
    nonce,
    key,
  );
  const out = new Uint8Array(2 + nonce.length + boxed.length);
  out[0] = ACCOUNT_SCOPED_MAGIC_V1;
  out[1] = getAccountScopedBlobKindByte('session_owner_metadata');
  out.set(nonce, 2);
  out.set(boxed, 2 + nonce.length);
  return encodeBase64(out, 'base64');
}
