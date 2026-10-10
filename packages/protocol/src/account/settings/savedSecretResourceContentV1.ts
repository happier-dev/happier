import { lazyZodSchema } from '../../lazyZodSchema.js';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  formatSharedSavedSecretRefV1,
} from './savedSecretReferenceV1.js';
import {
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1,
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1,
  SavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema,
  type SavedSecretResourceContentV1,
  type SavedSecretResourceStoredContentV1,
} from './savedSecretResourceContentSchemaV1.js';

export {
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1,
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1,
  SavedSecretResourceContentV1Schema,
  SavedSecretResourceStoredContentV1Schema,
};
export type {
  SavedSecretResourceContentV1,
  SavedSecretResourceStoredContentV1,
};

const EncryptedSavedSecretResourcePayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  resourceId: z.string(),
  mode: z.literal('e2ee'),
  content: SavedSecretResourceContentV1Schema,
}).strict());

type SealSavedSecretResourceStoredContentV1Params =
  | Readonly<{
      resourceId: string;
      mode: 'plain';
      content: SavedSecretResourceContentV1;
    }>
  | Readonly<{
      resourceId: string;
      mode: 'e2ee';
      content: SavedSecretResourceContentV1;
      resourceDataKey: Uint8Array;
      randomBytes: (length: number) => Uint8Array;
    }>;

export function sealSavedSecretResourceStoredContentV1(
  params: SealSavedSecretResourceStoredContentV1Params,
): SavedSecretResourceStoredContentV1 {
  formatSharedSavedSecretRefV1(params.resourceId);
  const content = SavedSecretResourceContentV1Schema.parse(params.content);

  if (params.mode === 'plain') {
    return { t: 'plain', v: content };
  }
  if (params.resourceDataKey.length !== tweetnacl.secretbox.keyLength) {
    throw new Error(`Invalid resource DEK length: ${params.resourceDataKey.length}`);
  }

  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({
    v: 1,
    resourceId: params.resourceId,
    mode: 'e2ee',
    content,
  }));
  if (plaintext.byteLength > SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1) {
    throw new Error('Saved Secret resource encrypted payload exceeds the maximum size');
  }
  const boxed = tweetnacl.secretbox(plaintext, nonce, params.resourceDataKey);
  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce);
  combined.set(boxed, nonce.length);
  return { t: 'encrypted', c: encodeBase64(combined, 'base64') };
}

type OpenSavedSecretResourceStoredContentV1Params =
  | Readonly<{
      resourceId: string;
      mode: 'plain';
      storedContent: unknown;
    }>
  | Readonly<{
      resourceId: string;
      mode: 'e2ee';
      storedContent: unknown;
      resourceDataKey: Uint8Array;
    }>;

export function openSavedSecretResourceStoredContentV1(
  params: OpenSavedSecretResourceStoredContentV1Params,
): SavedSecretResourceContentV1 | null {
  try {
    formatSharedSavedSecretRefV1(params.resourceId);
    const storedContent = SavedSecretResourceStoredContentV1Schema.safeParse(params.storedContent);
    if (!storedContent.success) return null;

    if (params.mode === 'plain') {
      return storedContent.data.t === 'plain' ? storedContent.data.v : null;
    }
    if (
      storedContent.data.t !== 'encrypted'
      || params.resourceDataKey.length !== tweetnacl.secretbox.keyLength
    ) {
      return null;
    }

    const combined = decodeBase64(storedContent.data.c, 'base64');
    if (combined.length < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) {
      return null;
    }
    const nonce = combined.subarray(0, tweetnacl.secretbox.nonceLength);
    const boxed = combined.subarray(tweetnacl.secretbox.nonceLength);
    const opened = tweetnacl.secretbox.open(boxed, nonce, params.resourceDataKey);
    if (!opened) return null;

    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened));
    const payload = EncryptedSavedSecretResourcePayloadV1Schema.safeParse(decoded);
    if (
      !payload.success
      || payload.data.resourceId !== params.resourceId
      || payload.data.mode !== params.mode
    ) {
      return null;
    }
    return payload.data.content;
  } catch {
    return null;
  }
}
