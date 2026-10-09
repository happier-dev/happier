import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { AccountEncryptionCurrentnessResponseSchema } from '../encryptionMode.js';
import { ProfileReferenceGuardRevisionV1Schema } from '../../profiles/profileRecordSchemaV1.js';
import { ProfileRecordIdV1Schema } from '../../profiles/v2/profileId.js';
import { formatSharedSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { PromptLibraryCatalogKeyV1Schema } from '../../prompts/library/promptLibraryRowsV1.js';
import { WorkflowArtifactRevisionV1Schema } from '../../workflows/workflowDefinitionV1.js';
import type { RoleArtifactRetentionReceiptV1 } from '../../prompts/roles/accountRoleActions.js';

import {
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES,
  AccountSettingsStoredContentEnvelopeSchema,
  AccountSettingsStoredContentEnvelopeWriteSchema,
} from './accountSettingsStoredContentEnvelope.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES } from './catalog/accountSettingBounds.js';
import {
  ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES,
  AccountRemoteAlertPolicyV1Schema,
} from './accountRemoteAlertPolicy.js';

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
      expectedProfileTransferRevision: Number.MAX_SAFE_INTEGER,
    })
    - ACCOUNT_SETTINGS_V2_EMPTY_PLAIN_DOCUMENT_UTF8_BYTES,
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES
    + serializedUtf8ByteLength({
      content: { t: 'encrypted', c: '' },
      expectedVersion: ACCOUNT_SETTINGS_V2_WIRE_EXPECTED_VERSION_CEILING,
      expectedProfileTransferRevision: Number.MAX_SAFE_INTEGER,
    }),
) + ACCOUNT_REMOTE_ALERT_POLICY_MAX_UTF8_BYTES
  + serializedUtf8ByteLength({ remoteAlertPolicy: null }) - serializedUtf8ByteLength(null) - 1;

export const AccountSettingsV2GetResponseSchema = lazyZodSchema(() => z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
  })
  .strict());

export type AccountSettingsV2GetResponse = z.infer<typeof AccountSettingsV2GetResponseSchema>;

/**
 * Route admission validates the structural request before the write-bound
 * schema classifies an otherwise valid but oversized envelope.
 */
export const AccountSettingsV2UpdateRequestAdmissionSchema = lazyZodSchema(() => z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    expectedVersion: z.number().int().min(0),
    expectedProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema.optional(),
    remoteAlertPolicy: AccountRemoteAlertPolicyV1Schema.nullable().optional(),
  })
  .strict());

export const AccountSettingsV2UpdateRequestSchema = lazyZodSchema(() => z
  .object({
    content: AccountSettingsStoredContentEnvelopeWriteSchema.nullable(),
    expectedVersion: z.number().int().min(0),
    expectedProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema.optional(),
    remoteAlertPolicy: AccountRemoteAlertPolicyV1Schema.nullable().optional(),
  })
  .strict());

export type AccountSettingsV2UpdateRequest = z.infer<typeof AccountSettingsV2UpdateRequestSchema>;

export const AccountSettingsV2UpdateResponseSchema = lazyZodSchema(() => z.union([
  z.object({ success: z.literal(false), error: z.literal('profile-transfer-mismatch'),
    currentProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema }).strict(),
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
]));

export type AccountSettingsV2UpdateResponse = z.infer<typeof AccountSettingsV2UpdateResponseSchema>;

/**
 * History snapshots are stored-envelope facts, never decrypted content. The
 * listing exposes version/time/content kind/byte length only (SET-11), and the
 * detail response supplies the exact recorded envelope a current client opens
 * in its recorded mode for classification-aware restore (SET-07).
 */
export const AccountSettingsV2HistoryContentKindV1Schema = lazyZodSchema(() => z.enum(['encrypted', 'plain', 'empty']));
export type AccountSettingsV2HistoryContentKindV1 = z.infer<typeof AccountSettingsV2HistoryContentKindV1Schema>;

export const AccountSettingsV2HistoryListResponseSchema = lazyZodSchema(() => z.object({
    snapshots: z.array(z.object({
        version: z.number().int().min(0),
        createdAt: z.string().datetime(),
        contentKind: AccountSettingsV2HistoryContentKindV1Schema,
        byteLength: z.number().int().min(0),
    })),
}).strict());
export type AccountSettingsV2HistoryListResponse = z.infer<typeof AccountSettingsV2HistoryListResponseSchema>;

export const AccountSettingsV2HistoryDetailResponseSchema = lazyZodSchema(() => z.object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
    createdAt: z.string().datetime(),
}).strict());
export type AccountSettingsV2HistoryDetailResponse = z.infer<typeof AccountSettingsV2HistoryDetailResponseSchema>;

/** Private exact-version transport. Action observations contain versions, never these envelopes. */
export const AccountSettingsHistorySavedSecretTransferV1Schema = lazyZodSchema(() => {
  const destination = z.object({ resourceId: z.string().refine(id => {
    try { formatSharedSavedSecretRefV1(id); return true; } catch { return false; }
  }), expectedRevision: z.number().int().nonnegative().safe(),
  });
  return z.union([
    destination.extend({ savedSecretId: z.string().min(1) }).strict(),
    destination.extend({ source: z.object({ kind: z.literal('legacy-inference-openai-key') }).strict() }).strict(),
  ]);
});
export type AccountSettingsHistorySavedSecretTransferV1 = z.infer<typeof AccountSettingsHistorySavedSecretTransferV1Schema>;
/** Actual current Role retention receipts; an explicit empty inventory is still complete. */
export const AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema = lazyZodSchema(() => z.object({
  artifactId: z.string().uuid(), expectedRevision: WorkflowArtifactRevisionV1Schema,
}).strict());
export type AccountSettingsHistoryLegacyRoleArtifactTransferV1 = RoleArtifactRetentionReceiptV1;
export const AccountSettingsV2HistoryMutationRequestSchema = lazyZodSchema(() => {
  const captured = z.object({
    expectedSettingsVersion: z.number().int().nonnegative().safe(),
    expectedProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema,
    expectedEncryptionCurrentness: AccountEncryptionCurrentnessResponseSchema.pick({
        mode: true, signingKeyFingerprint: true, contentKeyFingerprint: true,
    }),
  }).strict();
  return z.union([
    captured.extend({ expectedContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
      operation: z.object({ kind: z.literal('normalize'), removedRoots: z.array(z.string().min(1)),
        transferredProfileIds: z.array(ProfileRecordIdV1Schema).optional(),
        transferredPromptLibraryKeys: z.array(PromptLibraryCatalogKeyV1Schema).optional(),
        savedSecretTransfers: z.array(AccountSettingsHistorySavedSecretTransferV1Schema).optional(),
        legacyRoleArtifactTransfers: z.array(AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema).optional(),
        content: AccountSettingsStoredContentEnvelopeWriteSchema.nullable() }).strict() }).strict(),
    // Purge addresses the immutable retained version, including unreadable at-rest
    // data. No opening or echo of its credential bytes is needed for this intent.
    captured.extend({ expectedContent: AccountSettingsStoredContentEnvelopeSchema.nullable().optional(),
      operation: z.object({ kind: z.literal('purge') }).strict() }).strict(),
  ]);
});
export type AccountSettingsV2HistoryMutationRequest = z.infer<typeof AccountSettingsV2HistoryMutationRequestSchema>;
export const AccountSettingsV2HistoryMutationResponseSchema = lazyZodSchema(() => z.object({
    status: z.enum(['applied', 'unchanged', 'conflict', 'not_found', 'invalid_content', 'storage_unavailable']),
}).strict());
export type AccountSettingsV2HistoryMutationResponse = z.infer<typeof AccountSettingsV2HistoryMutationResponseSchema>;

/**
 * The retired exact-content restore operation. The server cannot classify
 * E2EE content, so it can never remain a second restore writer beside
 * client-side classification-aware restore.
 */
export const AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema = lazyZodSchema(() => z.object({
    error: z.literal('account_settings_restore_client_update_required'),
}).strict());
export type AccountSettingsV2HistoryRestoreClientUpdateRequiredResponse =
    z.infer<typeof AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema>;
