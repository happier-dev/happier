import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../../crypto/accountScopedCipherEnvelope.js';
import { AccountSettingsPersistedObjectSchema } from './accountSettingsPersistedObject.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';

const textEncoder = new TextEncoder();

export const ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES =
  getAccountScopedBlobCiphertextBase64LengthV1(ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES);

const AccountSettingsEncryptedCiphertextWriteSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.superRefine((ciphertext, context) => {
    if (textEncoder.encode(ciphertext).byteLength > ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES) {
      context.addIssue({
        code: "custom",
        message: 'Account Settings encrypted ciphertext exceeds the maximum document size',
      });
    }
  })));

const AccountSettingsPlainDocumentWriteSchema = lazyZodSchema(() => AccountSettingsPersistedObjectSchema.check(z.superRefine((document, context) => {
    let serializedDocument: string | undefined;
    try {
      serializedDocument = JSON.stringify(document);
    } catch {
      context.addIssue({
        code: "custom",
        message: 'Account Settings plain document must be JSON serializable',
      });
      return;
    }

    if (serializedDocument === undefined) {
      context.addIssue({
        code: "custom",
        message: 'Account Settings plain document must be JSON serializable',
      });
      return;
    }

    if (textEncoder.encode(serializedDocument).byteLength > ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES) {
      context.addIssue({
        code: "custom",
        message: 'Account Settings plain document exceeds the maximum document size',
      });
    }
  })));

export const AccountSettingsStoredContentEnvelopeSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: AccountSettingsPersistedObjectSchema,
  }),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1)),
  }),
]));

/**
 * The V2 write path enforces its derived ciphertext ceiling. Reads retain the
 * shared envelope schema so an oversized predecessor snapshot remains
 * available to the bounded migration reader.
 */
export const AccountSettingsStoredContentEnvelopeWriteSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: AccountSettingsPlainDocumentWriteSchema,
  }),
  z.object({
    t: z.literal('encrypted'),
    c: AccountSettingsEncryptedCiphertextWriteSchema,
  }),
]));

export type AccountSettingsStoredContentEnvelope = z.infer<typeof AccountSettingsStoredContentEnvelopeSchema>;

/** Captured Settings replacement committed atomically with an owning entity-row mutation. */
export const AccountSettingsCleanupV1Schema = lazyZodSchema(() => z.strictObject({
  expectedSettingsVersion: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  nextSettings: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
}));
export type AccountSettingsCleanupV1 = z.infer<typeof AccountSettingsCleanupV1Schema>;
