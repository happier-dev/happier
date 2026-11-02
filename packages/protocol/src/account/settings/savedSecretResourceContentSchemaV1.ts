import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SavedSecretPasskeySourceV1Schema } from './savedSecretPasskeySourceV1.js';
export { SavedSecretPasskeySourceV1Schema, type SavedSecretPasskeySourceV1 } from './savedSecretPasskeySourceV1.js';
export { parseSavedSecretPasskeyImportV1, type SavedSecretPasskeyImportResultV1 } from './savedSecretPasskeyImportV1.js';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES,
  ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES,
} from '../../crypto/accountScopedCipherEnvelope.js';
import { SecretStringV1Schema } from '../../crypto/settingsSecretStringSchemasV1.js';
import { SavedSecretSchema } from '../../profiles/backendProfileSchema.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginSettingFieldIdV2Schema } from '../../plugins/contributions/settings.js';
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

export const SavedSecretExternalSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('external'),
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  account: z.string().check(z.minLength(1)),
  reference: z.string().check(z.minLength(1)),
}));
export type SavedSecretExternalSourceV1 = Readonly<z.infer<typeof SavedSecretExternalSourceV1Schema>>;
export const SavedSecretResourceSourceV1Schema = lazyZodSchema(() => z.union([
  SavedSecretExternalSourceV1Schema, SavedSecretPasskeySourceV1Schema,
]));
export type SavedSecretResourceSourceV1 = Readonly<z.infer<typeof SavedSecretResourceSourceV1Schema>>;

/** Value-free row metadata; never credential selection or disclosure authority. */
export const SavedSecretStorageDescriptorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('value') }),
  z.strictObject({ kind: z.literal('passkey') }),
  z.strictObject({ kind: z.literal('external'), provider: asProtocolZod(PluginContributionIdentityV1Schema),
    providerLabel: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
]));
export type SavedSecretStorageDescriptorV1 = Readonly<z.infer<typeof SavedSecretStorageDescriptorV1Schema>>;

const CreatedByPluginSchema = lazyZodSchema(() => z.optional(z.strictObject({
  pluginId: z.string().check(z.refine(value => PluginIdSchema.safeParse(value).success)),
  secretId: z.string().check(z.refine(value => PluginSettingFieldIdV2Schema.safeParse(value).success)),
})));

const InlineSavedSecretResourceContentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  name: SavedSecretSchema.shape.name,
  kind: SavedSecretSchema.shape.kind._zod.def.innerType,
  value: SecretStringV1Schema.shape.value._zod.def.innerType,
  createdByPlugin: CreatedByPluginSchema,
}));

export const SavedSecretResourceContentV1Schema = lazyZodSchema(() => z.union([
  InlineSavedSecretResourceContentV1Schema,
  z.strictObject({ v: z.literal(2), name: SavedSecretSchema.shape.name,
    kind: SavedSecretSchema.shape.kind._zod.def.innerType, source: SavedSecretExternalSourceV1Schema,
    createdByPlugin: CreatedByPluginSchema }),
  z.strictObject({ v: z.literal(2), name: SavedSecretSchema.shape.name, kind: z.literal('other'),
    source: SavedSecretPasskeySourceV1Schema, createdByPlugin: CreatedByPluginSchema }),
]).check(z.superRefine((content, context) => {
  const issue = inspectAccountSettingValueBounds(
    content,
    SAVED_SECRET_RESOURCE_MAX_CONTENT_JSON_UTF8_BYTES_V1,
  );
  if (issue) context.addIssue({ code: "custom", message: issue.message });
})));

export type SavedSecretResourceContentV1 = Readonly<
  z.infer<typeof SavedSecretResourceContentV1Schema>
>;

export function describeSavedSecretResourceContentV1(content: SavedSecretResourceContentV1): SavedSecretStorageDescriptorV1 {
  if (content.v === 1) return { kind: 'value' };
  return content.source.kind === 'passkey' ? { kind: 'passkey' }
    : { kind: 'external', provider: content.source.contribution };
}

const CanonicalPaddedBase64Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BASE64_LENGTH_V1), z.refine((value) => {
  try {
    const decoded = decodeBase64(value, 'base64');
    return decoded.byteLength >= (
      ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    ) && decoded.byteLength <= SAVED_SECRET_RESOURCE_MAX_CIPHERTEXT_BYTES_V1
      && encodeBase64(decoded, 'base64') === value;
  } catch {
    return false;
  }
}, 'Expected canonical padded base64')));

export const SavedSecretResourceStoredContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: SavedSecretResourceContentV1Schema,
    storage: z.optional(SavedSecretStorageDescriptorV1Schema),
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: CanonicalPaddedBase64Schema,
    storage: z.optional(SavedSecretStorageDescriptorV1Schema),
  }),
]));

export type SavedSecretResourceStoredContentV1 = Readonly<
  z.infer<typeof SavedSecretResourceStoredContentV1Schema>
>;
