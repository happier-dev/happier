import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
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

/** Wire acceptance only; never Account mode, consent or feature-enabled authority. */
export const ACCOUNT_SETTINGS_REMOTE_ALERT_POLICY_HTTP_HEADER = 'x-happier-account-settings-protocols';
export const ACCOUNT_SETTINGS_REMOTE_ALERT_POLICY_HTTP_VALUE = 'remote-alert-policy-v1';
/** Read-only currentness for the Settings version carried by the response. */
export const ACCOUNT_SETTINGS_REMOTE_ALERT_POLICY_STATUS_HTTP_HEADER = 'x-happier-account-remote-alert-policy-status';

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

export const AccountSettingsV2GetResponseSchema = lazyZodSchema(() => z.strictObject({
    content: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
    version: z.number().check(z.int(), z.minimum(0)),
  }));

export type AccountSettingsV2GetResponse = z.infer<typeof AccountSettingsV2GetResponseSchema>;

/**
 * Route admission validates the structural request before the write-bound
 * schema classifies an otherwise valid but oversized envelope.
 */
export const AccountSettingsV2UpdateRequestAdmissionSchema = lazyZodSchema(() => z.strictObject({
    content: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
    expectedVersion: z.number().check(z.int(), z.minimum(0)),
    expectedProfileTransferRevision: z.optional(ProfileReferenceGuardRevisionV1Schema),
    remoteAlertPolicy: z.optional(z.nullable(AccountRemoteAlertPolicyV1Schema)),
  }));

export const AccountSettingsV2UpdateRequestSchema = lazyZodSchema(() => z.strictObject({
    content: z.nullable(AccountSettingsStoredContentEnvelopeWriteSchema),
    expectedVersion: z.number().check(z.int(), z.minimum(0)),
    expectedProfileTransferRevision: z.optional(ProfileReferenceGuardRevisionV1Schema),
    remoteAlertPolicy: z.optional(z.nullable(AccountRemoteAlertPolicyV1Schema)),
  }));

export type AccountSettingsV2UpdateRequest = z.infer<typeof AccountSettingsV2UpdateRequestSchema>;

export const AccountSettingsV2UpdateResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(false), error: z.literal('profile-transfer-mismatch'),
    currentProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema }),
  z.object({
    success: z.literal(true),
    version: z.number().check(z.int(), z.minimum(0)),
  }),
  z.object({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    currentVersion: z.number().check(z.int(), z.minimum(0)),
    currentContent: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
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

export const AccountSettingsV2HistoryListResponseSchema = lazyZodSchema(() => z.strictObject({
    snapshots: z.array(z.object({
        version: z.number().check(z.int(), z.minimum(0)),
        createdAt: z.string().check(z.iso.datetime()),
        contentKind: AccountSettingsV2HistoryContentKindV1Schema,
        byteLength: z.number().check(z.int(), z.minimum(0)),
    })),
}));
export type AccountSettingsV2HistoryListResponse = z.infer<typeof AccountSettingsV2HistoryListResponseSchema>;

export const AccountSettingsV2HistoryDetailResponseSchema = lazyZodSchema(() => z.strictObject({
    content: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
    version: z.number().check(z.int(), z.minimum(0)),
    createdAt: z.string().check(z.iso.datetime()),
}));
export type AccountSettingsV2HistoryDetailResponse = z.infer<typeof AccountSettingsV2HistoryDetailResponseSchema>;

/** Private exact-version transport. Action observations contain versions, never these envelopes. */
export const AccountSettingsHistorySavedSecretTransferV1Schema = lazyZodSchema(() => {
  const destination = z.object({ resourceId: z.string().check(z.refine(id => {
    try { formatSharedSavedSecretRefV1(id); return true; } catch { return false; }
  })), expectedRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
  });
  return z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(destination, { savedSecretId: z.string().check(z.minLength(1)) })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(destination, { source: z.strictObject({ kind: z.literal('legacy-inference-openai-key') }) })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(destination, { source: z.strictObject({ kind: z.literal('notification-channel-signing-secret'), channelId: z.string().check(z.minLength(1)) }) })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(destination, { source: z.strictObject({ kind: z.literal('remote-host-ssh-credential'), hostId: z.string().check(z.minLength(1)),
      slot: z.enum(['password', 'identityPrivateKey']) }) })),
  ]);
});
export type AccountSettingsHistorySavedSecretTransferV1 = z.infer<typeof AccountSettingsHistorySavedSecretTransferV1Schema>;
/** Actual current Role retention receipts; an explicit empty inventory is still complete. */
export const AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.uuid()), expectedRevision: WorkflowArtifactRevisionV1Schema,
}));
export type AccountSettingsHistoryLegacyRoleArtifactTransferV1 = RoleArtifactRetentionReceiptV1;
/** Exact admitted private catalog rows, never caller-supplied source-root authority. */
export const AccountSettingsHistoryPrivateCatalogRevisionsV1Schema = lazyZodSchema(() => z.strictObject({
  providerConnections: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  connectedConfigurations: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  connectedPurposes: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  connectedPresentation: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  connectedAcknowledgements: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  notificationChannels: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  mcp: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  acp: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  remoteHosts: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type AccountSettingsHistoryPrivateCatalogRevisionsV1 = z.infer<typeof AccountSettingsHistoryPrivateCatalogRevisionsV1Schema>;
export const AccountSettingsV2HistoryMutationRequestSchema = lazyZodSchema(() => {
  const captured = z.strictObject({
    expectedSettingsVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
    expectedProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema,
    expectedEncryptionCurrentness: z.pick(AccountEncryptionCurrentnessResponseSchema, {
        mode: true, signingKeyFingerprint: true, contentKeyFingerprint: true,
    }),
  });
  return z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(captured, { expectedContent: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
      operation: z.strictObject({ kind: z.literal('normalize'), removedRoots: z.array(z.string().check(z.minLength(1))),
        transferredProfileIds: z.optional(z.array(ProfileRecordIdV1Schema)),
        transferredPromptLibraryKeys: z.optional(z.array(PromptLibraryCatalogKeyV1Schema)),
        savedSecretTransfers: z.optional(z.array(AccountSettingsHistorySavedSecretTransferV1Schema)),
        legacyRoleArtifactTransfers: z.optional(z.array(AccountSettingsHistoryLegacyRoleArtifactTransferV1Schema)),
        transferredPrivateCatalogRevisions: z.optional(AccountSettingsHistoryPrivateCatalogRevisionsV1Schema),
        content: z.nullable(AccountSettingsStoredContentEnvelopeWriteSchema) }) })),
    // Purge addresses the immutable retained version, including unreadable at-rest
    // data. No opening or echo of its credential bytes is needed for this intent.
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(captured, { expectedContent: z.optional(z.nullable(AccountSettingsStoredContentEnvelopeSchema)),
      operation: z.strictObject({ kind: z.literal('purge') }) })),
  ]);
});
export type AccountSettingsV2HistoryMutationRequest = z.infer<typeof AccountSettingsV2HistoryMutationRequestSchema>;
export const AccountSettingsV2HistoryMutationResponseSchema = lazyZodSchema(() => z.strictObject({
    status: z.enum(['applied', 'unchanged', 'conflict', 'not_found', 'invalid_content', 'storage_unavailable']),
}));
export type AccountSettingsV2HistoryMutationResponse = z.infer<typeof AccountSettingsV2HistoryMutationResponseSchema>;

/**
 * The retired exact-content restore operation. The server cannot classify
 * E2EE content, so it can never remain a second restore writer beside
 * client-side classification-aware restore.
 */
export const AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema = lazyZodSchema(() => z.strictObject({
    error: z.literal('account_settings_restore_client_update_required'),
}));
export type AccountSettingsV2HistoryRestoreClientUpdateRequiredResponse =
    z.infer<typeof AccountSettingsV2HistoryRestoreClientUpdateRequiredResponseSchema>;
