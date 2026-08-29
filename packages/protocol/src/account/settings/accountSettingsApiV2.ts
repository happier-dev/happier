import { z } from 'zod';

import {
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES,
  AccountSettingsStoredContentEnvelopeSchema,
  AccountSettingsStoredContentEnvelopeWriteSchema,
} from './accountSettingsStoredContentEnvelope.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';

const textEncoder = new TextEncoder();

function serializedUtf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Account Settings V2 request ceiling must be JSON serializable');
  }
  return textEncoder.encode(serialized).byteLength;
}

const ACCOUNT_SETTINGS_V2_WIRE_EXPECTED_VERSION_CEILING = Number.MAX_VALUE;
const ACCOUNT_SETTINGS_V2_EMPTY_PLAIN_DOCUMENT_UTF8_BYTES = serializedUtf8ByteLength({});

/**
 * The raw V2 route accepts the largest canonical request which the write
 * schema can admit. Equivalent whitespace-padded or escape-heavy wire forms
 * are intentionally rejected before JSON parsing.
 */
export const ACCOUNT_SETTINGS_V2_UPDATE_REQUEST_MAX_UTF8_BYTES = Math.max(
  ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES
    + serializedUtf8ByteLength({
      content: { t: 'plain', v: {} },
      expectedVersion: ACCOUNT_SETTINGS_V2_WIRE_EXPECTED_VERSION_CEILING,
    })
    - ACCOUNT_SETTINGS_V2_EMPTY_PLAIN_DOCUMENT_UTF8_BYTES,
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES
    + serializedUtf8ByteLength({
      content: { t: 'encrypted', c: '' },
      expectedVersion: ACCOUNT_SETTINGS_V2_WIRE_EXPECTED_VERSION_CEILING,
    }),
);

export const AccountSettingsV2GetResponseSchema = z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
  })
  .strict();

export type AccountSettingsV2GetResponse = z.infer<typeof AccountSettingsV2GetResponseSchema>;

/**
 * Route admission validates the structural request before the write-bound
 * schema classifies an otherwise valid but oversized envelope.
 */
export const AccountSettingsV2UpdateRequestAdmissionSchema = z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const AccountSettingsV2UpdateRequestSchema = z
  .object({
    content: AccountSettingsStoredContentEnvelopeWriteSchema.nullable(),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export type AccountSettingsV2UpdateRequest = z.infer<typeof AccountSettingsV2UpdateRequestSchema>;

export const AccountSettingsV2UpdateResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    version: z.number().int().min(0),
  }),
  z.object({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    currentVersion: z.number().int().min(0),
    currentContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  }),
  z.object({
    success: z.literal(false),
    error: z.literal('invalid'),
    reason: z.literal('tooLarge'),
  }),
]);

export type AccountSettingsV2UpdateResponse = z.infer<typeof AccountSettingsV2UpdateResponseSchema>;

/**
 * History snapshots are stored-envelope facts, never decrypted content. The
 * listing exposes version/time/content kind/byte length only (SET-11), and the
 * detail response supplies the exact recorded envelope a current client opens
 * in its recorded mode for classification-aware restore (SET-07).
 */
export const AccountSettingsV2HistoryContentKindV1Schema = z.enum(['encrypted', 'plain', 'empty']);
export type AccountSettingsV2HistoryContentKindV1 = z.infer<typeof AccountSettingsV2HistoryContentKindV1Schema>;

export const AccountSettingsV2HistoryListResponseSchema = z.object({
    snapshots: z.array(z.object({
        version: z.number().int().min(0),
        createdAt: z.string().datetime(),
        contentKind: AccountSettingsV2HistoryContentKindV1Schema,
        byteLength: z.number().int().min(0),
    })),
}).strict();
export type AccountSettingsV2HistoryListResponse = z.infer<typeof AccountSettingsV2HistoryListResponseSchema>;

export const AccountSettingsV2HistoryDetailResponseSchema = z.object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
    createdAt: z.string().datetime(),
}).strict();
export type AccountSettingsV2HistoryDetailResponse = z.infer<typeof AccountSettingsV2HistoryDetailResponseSchema>;

/**
 * The retired exact-content restore operation. The server cannot classify
 * E2EE content, so it can never remain a second restore writer beside
 * client-side classification-aware restore.
 */
export const AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema = z.object({
    error: z.literal('account_settings_restore_client_update_required'),
}).strict();
export type AccountSettingsV2HistoryRestoreClientUpdateRequiredResponse =
    z.infer<typeof AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema>;
