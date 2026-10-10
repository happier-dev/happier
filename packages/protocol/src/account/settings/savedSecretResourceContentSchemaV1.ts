import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES,
} from '../../crypto/accountScopedCipherEnvelope.js';
import { SecretStringV1Schema } from '../../crypto/settingsSecretStringSchemasV1.js';
import { SavedSecretSchema } from '../../profiles/backendProfileSchema.js';
import {
  ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES,
  inspectAccountSettingValueBounds,
} from './catalog/accountSettingBounds.js';
import {
  SAVED_SECRET_REF_MAX_LENGTH_V1,
  SHARED_SAVED_SECRET_REF_V1_PREFIX,
} from './savedSecretReferenceV1.js';

const textEncoder = new TextEncoder();
const MAX_JSON_ESCAPED_UTF8_BYTES_PER_CODE_UNIT_V1 = 6;
const SAVED_SECRET_RESOURCE_ID_MAX_CODE_UNITS_V1 =
  SAVED_SECRET_REF_MAX_LENGTH_V1 - SHARED_SAVED_SECRET_REF_V1_PREFIX.length;
const ENCRYPTED_PAYLOAD_FIXED_JSON_UTF8_BYTES_V1 = textEncoder.encode(JSON.stringify({
  v: 1,
  resourceId: '',
  mode: 'e2ee',
  content: null,
})).byteLength - 'null'.length;

/**
 * The persisted Action/HTTP shape is deliberately independent of the
 * crypto implementation. The crypto owner imports this exact schema for
 * sealing/opening, while browser-safe Action discovery needs only admission.
 */
export const SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1 =
  ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES;
export const SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1 =
  SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1
  + ENCRYPTED_PAYLOAD_FIXED_JSON_UTF8_BYTES_V1
  + (MAX_JSON_ESCAPED_UTF8_BYTES_PER_CODE_UNIT_V1
    * SAVED_SECRET_RESOURCE_ID_MAX_CODE_UNITS_V1);
export const SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1 =
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES
  + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
  + SAVED_SECRET_RESOURCE_MAX_ENCRYPTED_PAYLOAD_UTF8_BYTES_V1;
export const SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1 = 4 * Math.ceil((
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1
) / 3);

export const SavedSecretResourceContentV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  name: SavedSecretSchema.shape.name,
  kind: SavedSecretSchema.shape.kind.removeDefault(),
  value: SecretStringV1Schema.shape.value.unwrap(),
}).strict().superRefine((content, context) => {
  const issue = inspectAccountSettingValueBounds(
    content,
    SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
  );
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue.message });
}));

export type SavedSecretResourceContentV1 = Readonly<
  z.infer<typeof SavedSecretResourceContentV1Schema>
>;

const CanonicalPaddedBase64Schema = lazyZodSchema(() => z.string().min(1).max(
  SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1,
).refine((value) => {
  try {
    const decoded = decodeBase64(value, 'base64');
    return decoded.byteLength >= (
      ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    ) && decoded.byteLength <= SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1
      && encodeBase64(decoded, 'base64') === value;
  } catch {
    return false;
  }
}, 'Expected canonical padded base64'));

export const SavedSecretResourceStoredContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: SavedSecretResourceContentV1Schema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: CanonicalPaddedBase64Schema,
  }).strict(),
]));

export type SavedSecretResourceStoredContentV1 = Readonly<
  z.infer<typeof SavedSecretResourceStoredContentV1Schema>
>;
