import tweetnacl from 'tweetnacl';

import {
  AccountApiTokenCredentialV1Schema,
  AccountApiTokenEncryptionAccessV1Schema,
  AccountApiTokensCreateActionInputV1Schema,
  type AccountApiTokenEncryptionAccessV1,
} from '../auth/accountApiTokens.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from './accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { deriveKey } from './keyDerivation.js';

export type ApiTokenEncryptionAccessContextV1 = Readonly<{
  serverIdentityId: string;
  accountId: string;
  tokenId: string;
  contentPublicKey: string;
}>;

function deriveWrappingKey(context: ApiTokenEncryptionAccessContextV1, wrappingSecret: Uint8Array): Uint8Array {
  const fields = AccountApiTokenCredentialV1Schema.shape;
  if (
    !fields.serverIdentityId.safeParse(context.serverIdentityId).success
    || !fields.accountId.safeParse(context.accountId).success
    || !fields.contentPublicKey.safeParse(context.contentPublicKey).success
    || !AccountApiTokensCreateActionInputV1Schema.shape.tokenId.safeParse(context.tokenId).success
    || !(wrappingSecret instanceof Uint8Array)
    || wrappingSecret.length !== 32
  ) {
    throw new Error('Invalid API token encryption context or wrapping secret');
  }
  return deriveKey(wrappingSecret, 'Happier API token content wrap', [
    'v1', context.serverIdentityId, context.accountId, context.tokenId, context.contentPublicKey,
  ]);
}

function validateContentPrivateKey(contentPrivateKey: Uint8Array, contentPublicKey: string): Uint8Array {
  // Account material admission remains the sole private/public pair validator.
  const validated = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: { type: 'dataKey', machineKey: contentPrivateKey },
    dataKeyPublicKey: decodeBase64(contentPublicKey, 'base64'),
  });
  try { return new Uint8Array(contentPrivateKey); }
  finally {
    if (validated.material.type === 'dataKey') validated.material.machineKey.fill(0);
    else validated.material.secret.fill(0);
  }
}

/** Wraps only Account content material. The caller owns E2EE mode/currentness admission. */
export function wrapApiTokenEncryptionAccessV1(params: Readonly<{
  context: ApiTokenEncryptionAccessContextV1;
  wrappingSecret: Uint8Array;
  contentPrivateKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): AccountApiTokenEncryptionAccessV1 {
  const context = { ...params.context };
  const key = deriveWrappingKey(context, params.wrappingSecret);
  const privateKey = validateContentPrivateKey(params.contentPrivateKey, context.contentPublicKey);
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (!(nonce instanceof Uint8Array) || nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error('Invalid API token wrapping nonce');
  }
  const boxed = tweetnacl.secretbox(privateKey, nonce, key);
  const bytes = new Uint8Array(nonce.length + boxed.length);
  bytes.set(nonce);
  bytes.set(boxed, nonce.length);
  return {
    v: 1,
    serverIdentityId: context.serverIdentityId,
    contentPublicKey: context.contentPublicKey,
    wrappedContentPrivateKey: encodeBase64(bytes, 'base64url'),
  };
}

/** Context must come from local pins, never from the retrieved wrapping record. */
export function openApiTokenEncryptionAccessV1(params: Readonly<{
  context: ApiTokenEncryptionAccessContextV1;
  wrappingSecret: Uint8Array;
  encryptionAccess: unknown;
}>): Uint8Array | null {
  let key: Uint8Array | undefined;
  let opened: Uint8Array | null = null;
  try {
    const record = AccountApiTokenEncryptionAccessV1Schema.safeParse(params.encryptionAccess);
    if (!record.success) return null;
    const context = params.context;
    if (
      record.data.serverIdentityId !== context.serverIdentityId
      || record.data.contentPublicKey !== context.contentPublicKey
    ) return null;
    key = deriveWrappingKey(context, params.wrappingSecret);
    const bytes = decodeBase64(record.data.wrappedContentPrivateKey, 'base64url');
    const nonce = bytes.subarray(0, tweetnacl.secretbox.nonceLength);
    opened = tweetnacl.secretbox.open(bytes.subarray(nonce.length), nonce, key);
    if (!opened || opened.length !== 32) return null;
    return validateContentPrivateKey(opened, context.contentPublicKey);
  } catch {
    return null;
  } finally { key?.fill(0); opened?.fill(0); }
}
