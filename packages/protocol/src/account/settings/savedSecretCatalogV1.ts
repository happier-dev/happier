import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  formatSharedSavedSecretRefV1,
  parseSavedSecretRefV1,
  SHARED_SAVED_SECRET_REF_V1_PREFIX,
} from './savedSecretReferenceV1.js';
import { SavedSecretResourceStoredContentV1Schema, SavedSecretStorageDescriptorV1Schema } from './savedSecretResourceContentSchemaV1.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { AccountDisplayProfileV1BaseSchema, readAccountNameFromLegacyProfileV1 } from '../accountDisplayProfileV1.js';
import { AccountRecipientEnvelopeUnavailableReasonSchema } from '../encryptionMode.js';
import { ContentPublicKeyFingerprintSchema } from '../../machines/identity/contentPublicKeyFingerprint.js';
import { ACCOUNT_CONTENT_PUBLIC_KEY_BYTES_V1 } from '../../crypto/accountContentKeyBindingFormatV1.js';

export const SavedSecretResourceEncryptionModeV1Schema = lazyZodSchema(() => z.enum(['plain', 'e2ee']));
export type SavedSecretResourceEncryptionModeV1 = z.infer<typeof SavedSecretResourceEncryptionModeV1Schema>;

export const SavedSecretCatalogMaterialStatusV1Schema = lazyZodSchema(() => z.enum([
  'ready',
  'preparing_encrypted_access',
  'recipient_mode_unsupported',
  'temporarily_unavailable',
  'access_removed',
  'deleted',
  'update_required',
]));
export type SavedSecretCatalogMaterialStatusV1 = z.infer<typeof SavedSecretCatalogMaterialStatusV1Schema>;

export const SavedSecretCatalogAccountSummaryV1Schema = lazyZodSchema(() => z.pipe((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AccountDisplayProfileV1BaseSchema, {
  kind: z.literal('account'),
  accountId: z.string().check(z.minLength(1)),
})), z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))));
export type SavedSecretCatalogAccountSummaryV1 = z.infer<typeof SavedSecretCatalogAccountSummaryV1Schema>;

export const SavedSecretCatalogAccessSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account') }),
  z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)) }),
  z.strictObject({
    kind: z.literal('group'),
    teamId: z.string().check(z.minLength(1)),
    teamName: z.string().check(z.minLength(1)),
    groupId: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)),
  }),
]));
export type SavedSecretCatalogAccessSourceV1 = z.infer<typeof SavedSecretCatalogAccessSourceV1Schema>;

export const SavedSecretCatalogAudienceV1Schema = lazyZodSchema(() => z.strictObject({
  accounts: z.array(SavedSecretCatalogAccountSummaryV1Schema),
  teams: z.array(z.strictObject({ kind: z.literal('team'), teamId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)) })),
  groups: z.array(z.strictObject({
    kind: z.literal('group'),
    teamId: z.string().check(z.minLength(1)),
    teamName: z.string().check(z.minLength(1)),
    groupId: z.string().check(z.minLength(1)),
    name: z.string().check(z.minLength(1)),
  })),
}));
export type SavedSecretCatalogAudienceV1 = z.infer<typeof SavedSecretCatalogAudienceV1Schema>;

export const SavedSecretCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  ref: z.string().check(z.minLength(1), z.maxLength(256)),
  source: z.enum(['personal', 'shared_resource']),
  relationship: z.enum(['owner', 'recipient']),
  name: z.nullable(z.string().check(z.minLength(1), z.maxLength(100))),
  kind: z.nullable(z.enum(['apiKey', 'token', 'password', 'other'])),
  /** Absent on retained encrypted rows until their next content write. */
  storage: z.optional(SavedSecretStorageDescriptorV1Schema),
  encryptionMode: z._default(z.optional(z.nullable(SavedSecretResourceEncryptionModeV1Schema)), null),
  owner: z._default(z.optional(z.nullable(SavedSecretCatalogAccountSummaryV1Schema)), null),
  accessSources: z._default(z.optional(z.array(SavedSecretCatalogAccessSourceV1Schema)), []),
  audience: z._default(z.optional(z.nullable(SavedSecretCatalogAudienceV1Schema)), null),
  /** @deprecated Use the recipient-safe `owner` projection. */
  ownerAccountId: z._default(z.optional(z.nullable(z.string().check(z.minLength(1)))), null),
  revision: z.nullable(z.number().check(z.int(), z.nonnegative())),
  materialStatus: SavedSecretCatalogMaterialStatusV1Schema,
  capabilities: z.strictObject({
    use: z.boolean(),
    rename: z.boolean(),
    rotate: z.boolean(),
    manageAccess: z.boolean(),
    delete: z.boolean(),
  }),
}));
export type SavedSecretCatalogEntryV1 = Readonly<z.infer<typeof SavedSecretCatalogEntryV1Schema>>;

/** Value-free revision identity shared by catalog pickers and admitted consumers. */
export function formatSavedSecretCatalogFingerprintV1(input: Readonly<{
  ref: string;
  source: 'personal' | 'shared_resource';
  revision: number | null;
}>): string | null {
  return input.revision === null ? null
    : `${input.source === 'personal' ? 'personal' : 'shared'}:${input.ref}:${input.revision}`;
}

const SavedSecretCatalogCorruptOwnerEntryV1Schema = lazyZodSchema(() => z.strictObject({
  materialStatus: z.literal('resource_corrupt'),
  relationship: z.literal('owner'),
  repair: z.strictObject({
    kind: z.literal('delete_resource'),
    // This is the retained database identity, not a Saved Secret reference.
    // Keep it opaque so malformed legacy bytes are never reclassified as a
    // personal id or formatted as a canonical shared-resource ref.
    resourceId: z.string(),
    expectedRevision: z.number().check(z.int()),
  }),
}));

const SavedSecretCatalogCorruptRecipientEntryV1Schema = lazyZodSchema(() => z.strictObject({
  materialStatus: z.literal('resource_corrupt'),
  relationship: z.literal('recipient'),
  repair: z.null(),
}));

export const SavedSecretCatalogCorruptEntryV1Schema = lazyZodSchema(() => z.discriminatedUnion('relationship', [
  SavedSecretCatalogCorruptOwnerEntryV1Schema,
  SavedSecretCatalogCorruptRecipientEntryV1Schema,
]));
export type SavedSecretCatalogCorruptEntryV1 = Readonly<z.infer<typeof SavedSecretCatalogCorruptEntryV1Schema>>;

export const SavedSecretCatalogResultV1Schema = lazyZodSchema(() => z.union([
  SavedSecretCatalogEntryV1Schema,
  SavedSecretCatalogCorruptEntryV1Schema,
]));
export type SavedSecretCatalogResultV1 = Readonly<z.infer<typeof SavedSecretCatalogResultV1Schema>>;

export const SavedSecretCatalogResourceV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  ownerAccountId: z.string().check(z.minLength(1)),
  displayName: z.string().check(z.minLength(1), z.maxLength(100)),
  kind: z.enum(['apiKey', 'token', 'password', 'other']),
  encryptionMode: SavedSecretResourceEncryptionModeV1Schema,
  revision: z.number().check(z.int(), z.positive()),
  storedContent: SavedSecretResourceStoredContentV1Schema,
  materialStatus: SavedSecretCatalogMaterialStatusV1Schema,
}));
export type SavedSecretCatalogResourceV1 = Readonly<z.infer<typeof SavedSecretCatalogResourceV1Schema>>;

const SavedSecretResourceRecipientEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  encryptedDataKey: z.string().check(z.refine(value => readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 'Expected one canonical encrypted data-key envelope')),
  recipientContentPublicKeyFingerprint: z.string().check(z.minLength(1)),
}));

const SavedSecretResourceHealthyMaterialV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  encryptionMode: SavedSecretResourceEncryptionModeV1Schema,
  entry: SavedSecretCatalogEntryV1Schema,
  storedContent: z.nullable(SavedSecretResourceStoredContentV1Schema),
  recipientEnvelope: z.nullable(SavedSecretResourceRecipientEnvelopeV1Schema),
}).check(z.superRefine((row, context) => {
  const ref = parseSavedSecretCatalogReferenceV1(row.entry.ref);
  if (row.entry.source !== 'shared_resource' || ref?.kind !== 'shared_resource' || ref.id !== row.resourceId) {
    context.addIssue({ code: "custom", message: 'Material identity must match the shared resource reference' });
  }
  if (row.storedContent !== null && (
    (row.encryptionMode === 'plain' && row.storedContent.t !== 'plain')
    || (row.encryptionMode === 'e2ee' && row.storedContent.t !== 'encrypted')
  )) {
    context.addIssue({ code: "custom", message: 'Material content must match the resource encryption mode' });
  }
  if (row.encryptionMode === 'plain' && row.recipientEnvelope !== null) {
    context.addIssue({ code: "custom", message: 'Plain material cannot carry a recipient envelope' });
  }
  if (row.entry.materialStatus === 'ready' && (
    row.storedContent === null
    || (row.encryptionMode === 'e2ee' && row.recipientEnvelope === null)
  )) {
    context.addIssue({ code: "custom", message: 'Ready material must contain all mode-required material' });
  }
})));
const SavedSecretResourceCorruptMaterialV1Schema = lazyZodSchema(() => z.strictObject({
  entry: SavedSecretCatalogCorruptEntryV1Schema,
}));

export const SavedSecretResourceMaterialV1Schema = lazyZodSchema(() => z.union([
  SavedSecretResourceHealthyMaterialV1Schema,
  SavedSecretResourceCorruptMaterialV1Schema,
]));
export type SavedSecretResourceMaterialV1 = Readonly<z.infer<typeof SavedSecretResourceMaterialV1Schema>>;

export const SavedSecretResourceMaterialsResponseV1Schema = lazyZodSchema(() => z.strictObject({
  resources: z.array(SavedSecretResourceMaterialV1Schema),
}));
export type SavedSecretResourceMaterialsResponseV1 = Readonly<
  z.infer<typeof SavedSecretResourceMaterialsResponseV1Schema>
>;

const CanonicalContentPublicKeyBase64Schema = lazyZodSchema(() => z.string().check(z.refine(value => readCanonicalPaddedBase64DecodedLength(value) === ACCOUNT_CONTENT_PUBLIC_KEY_BYTES_V1, 'Expected one canonical Account content public key')));

export const SavedSecretResourceEnvelopeCensusRecipientV1Schema = lazyZodSchema(() => z.strictObject({
  account: SavedSecretCatalogAccountSummaryV1Schema,
  readiness: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      contentPublicKey: CanonicalContentPublicKeyBase64Schema,
      contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema,
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reason: AccountRecipientEnvelopeUnavailableReasonSchema,
    }),
  ]),
  envelopeStatus: z.enum(['prepared', 'missing', 'stale', 'invalid']),
}));
export type SavedSecretResourceEnvelopeCensusRecipientV1 = z.infer<
  typeof SavedSecretResourceEnvelopeCensusRecipientV1Schema
>;

export const SavedSecretResourceEnvelopeCensusRequestV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1), z.maxLength(128)),
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z._default(z.optional(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(100))), 50),
}));
export type SavedSecretResourceEnvelopeCensusRequestV1 = z.infer<
  typeof SavedSecretResourceEnvelopeCensusRequestV1Schema
>;

export const SavedSecretResourceEnvelopeCensusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.positive()),
  recipients: z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema),
  nextCursor: z.nullable(z.string().check(z.minLength(1))),
}));
export type SavedSecretResourceEnvelopeCensusResponseV1 = z.infer<
  typeof SavedSecretResourceEnvelopeCensusResponseV1Schema
>;


export type SavedSecretCatalogReferenceV1 = Readonly<{
  kind: 'personal' | 'shared_resource';
  id: string;
}>;

export type SavedSecretCatalogCollisionV1 = Readonly<{
  ref: string;
  expectedUpdatedAt: number;
}>;

export type SavedSecretCatalogCollisionStateV1 = Readonly<{
  status: 'none' | 'migration_required';
  collisions: readonly SavedSecretCatalogCollisionV1[];
}>;

/**
 * Projects the reserved-reference collisions owned by the current Account
 * Settings document. This is intentionally pure: Settings CAS remains the
 * sole rekey writer, while UI and daemon bootstrap consume the same fact.
 */
export function projectSavedSecretCatalogCollisionStateV1(
  personalSecrets: readonly unknown[],
): SavedSecretCatalogCollisionStateV1 {
  const collisions: SavedSecretCatalogCollisionV1[] = [];
  for (const candidate of personalSecrets) {
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || !('id' in candidate)
      || !('updatedAt' in candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.updatedAt !== 'number'
      || !Number.isFinite(candidate.updatedAt)
    ) continue;
    const parsed = parseSavedSecretCatalogReferenceV1(candidate.id);
    if (parsed?.kind !== 'shared_resource') continue;
    collisions.push(Object.freeze({
      ref: candidate.id,
      expectedUpdatedAt: candidate.updatedAt,
    }));
  }
  return Object.freeze({
    status: collisions.length === 0 ? 'none' : 'migration_required',
    collisions: Object.freeze(collisions),
  });
}

export function parseSavedSecretCatalogReferenceV1(value: string): SavedSecretCatalogReferenceV1 | null {
  try {
    const parsed = parseSavedSecretRefV1(value);
    return parsed.kind === 'personal'
      ? { kind: 'personal', id: parsed.personalId }
      : { kind: 'shared_resource', id: parsed.resourceId };
  } catch {
    return null;
  }
}

export function formatSavedSecretCatalogReferenceV1(input: SavedSecretCatalogReferenceV1): string {
  return input.kind === 'personal'
    ? input.id
    : formatSharedSavedSecretRefV1(input.id);
}

export function isSharedSavedSecretReferenceV1(value: string): boolean {
  return value.startsWith(SHARED_SAVED_SECRET_REF_V1_PREFIX)
    && parseSavedSecretCatalogReferenceV1(value)?.kind === 'shared_resource';
}
