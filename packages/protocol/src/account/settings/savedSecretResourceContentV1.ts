import type { SavedSecretResourceEnvelopeCensusRecipientV1 } from './savedSecretCatalogV1.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import tweetnacl from 'tweetnacl';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
export { parseSavedSecretPasskeyImportV1, type SavedSecretPasskeyImportResultV1 } from './savedSecretPasskeyImportV1.js';
export { SavedSecretPasskeySourceV1Schema, type SavedSecretPasskeySourceV1 } from './savedSecretPasskeySourceV1.js';

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
  SavedSecretExternalSourceV1Schema,
  type SavedSecretExternalSourceV1,
  SavedSecretResourceSourceV1Schema,
  type SavedSecretResourceSourceV1,
  SavedSecretResourceStoredContentV1Schema,
  describeSavedSecretResourceContentV1,
  type SavedSecretResourceContentV1,
  type SavedSecretResourceStoredContentV1,
} from './savedSecretResourceContentSchemaV1.js';

export {
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1,
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
  SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1,
  SavedSecretResourceContentV1Schema,
  SavedSecretExternalSourceV1Schema,
  SavedSecretResourceSourceV1Schema,
  SavedSecretResourceStoredContentV1Schema,
};
export type {
  SavedSecretResourceContentV1,
  SavedSecretExternalSourceV1,
  SavedSecretResourceSourceV1,
  SavedSecretResourceStoredContentV1,
};
export { canShareSavedSecretResourceContentV1 } from './savedSecretResourceContentSchemaV1.js';
export { describeSavedSecretResourceContentV1, SavedSecretStorageDescriptorV1Schema,
  type SavedSecretStorageDescriptorV1 } from './savedSecretResourceContentSchemaV1.js';

const EncryptedSavedSecretResourcePayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  resourceId: z.string(),
  mode: z.literal('e2ee'),
  content: SavedSecretResourceContentV1Schema,
}));

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
    return { t: 'plain', v: content, storage: describeSavedSecretResourceContentV1(content) };
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
  return { t: 'encrypted', c: encodeBase64(combined, 'base64'), storage: describeSavedSecretResourceContentV1(content) };
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
    const storedContent = createStoredReadSchema(SavedSecretResourceStoredContentV1Schema).safeParse(params.storedContent);
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
    const payload = createStoredReadSchema(EncryptedSavedSecretResourcePayloadV1Schema).safeParse(decoded);
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

export function prepareSavedSecretResourceRecipientEnvelopesV1(params: Readonly<{
  recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[];
  resourceDataKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): readonly Readonly<{ recipientAccountId: string; encryptedDataKey: string; recipientContentPublicKeyFingerprint: string }>[] {
  return params.recipients.flatMap(recipient => recipient.readiness.status !== 'available'
    || recipient.envelopeStatus === 'prepared' ? [] : [{
      recipientAccountId: recipient.account.accountId,
      encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: params.resourceDataKey,
        recipientPublicKey: decodeBase64(recipient.readiness.contentPublicKey, 'base64'), randomBytes: params.randomBytes }), 'base64'),
      recipientContentPublicKeyFingerprint: recipient.readiness.contentPublicKeyFingerprint,
    }]);
}


/** A resource opens in its persisted mode; Account policy decides only the next write.
 * An explicit owner directive (including keeping Home-managed Plain content) is retained.
 * Hosts keep their existing key-envelope and mutation custody around this preparation.
 */
export function prepareSavedSecretResourceUpdateContentV1(params: Readonly<{
  resourceId: string;
  resourceMode: 'plain' | 'e2ee';
  accountMode: 'plain' | 'e2ee';
  storedContent: unknown;
  resourceDataKey?: Uint8Array | null;
  nextName?: string;
  nextValue?: string;
  nextSource?: SavedSecretExternalSourceV1;
  toMode?: 'plain' | 'e2ee';
}>): Readonly<{
  content: SavedSecretResourceContentV1;
  mode: 'plain' | 'e2ee';
  toMode?: 'plain' | 'e2ee';
}> | null {
  const current = params.resourceMode === 'plain'
    ? openSavedSecretResourceStoredContentV1({ resourceId: params.resourceId, mode: 'plain', storedContent: params.storedContent })
    : params.resourceDataKey ? openSavedSecretResourceStoredContentV1({ resourceId: params.resourceId, mode: 'e2ee',
        storedContent: params.storedContent, resourceDataKey: params.resourceDataKey }) : null;
  if (!current) return null;
  // Imported RP/credential identity belongs to the source export. Ordinary
  // edits may rename it or convert custody, never remap or flatten the key.
  if (current.v === 2 && current.source.kind === 'passkey'
    && (params.nextSource !== undefined || params.nextValue !== undefined)) return null;
  if (params.nextValue !== undefined && params.nextSource !== undefined) return null;
  const updated = params.nextSource !== undefined
    ? { v: 2 as const, name: current.name, kind: current.kind, source: params.nextSource }
    : params.nextValue !== undefined
      ? { v: 1 as const, name: current.name, kind: current.kind, value: params.nextValue }
      : current;
  const content = SavedSecretResourceContentV1Schema.safeParse({ ...updated,
    ...(params.nextName === undefined ? {} : { name: params.nextName }),
  });
  if (!content.success) return null;
  const mode = params.toMode ?? (params.accountMode === 'e2ee' ? 'e2ee' : params.resourceMode);
  return { content: content.data, mode,
    ...(params.toMode !== undefined || mode !== params.resourceMode ? { toMode: mode } : {}),
  };
}
