import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import {
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  SealedConnectedServiceCredentialV1Schema,
} from '../connect/connectedServiceSchemas.js';
import {
  QualifiedConnectedAccountRefSchema,
} from '../connect/qualifiedConnectedAccountPersistence.js';
import {
  QualifiedConnectedAccountCredentialMetadataV4Schema,
} from '../connect/qualifiedConnectedAccountsV4.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  PluginCollectionContentEnvelopeV1Schema,
  PluginCollectionContractDigestV1Schema,
  PluginCollectionOpaqueCursorV1Schema,
  PluginCollectionRowIdV1Schema,
} from '../plugins/data/collectionsV1.js';
import {
  ContentPublicKeyFingerprintSchema,
  type ContentPublicKeyFingerprint,
} from '../machines/identity/installationIdentity.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionOwnerMetadataEnvelopeV1Schema,
} from '../sessions/metadata/sessionMetadataEnvelopesV1.js';
import {
  SESSION_ORGANIZATION_MAX_FOLDERS,
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_LABELS,
  SESSION_ORGANIZATION_MAX_TAGS,
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationLabelKindSchema,
} from '../sessions/organization/index.js';
import {
  BoundReviewCommentEventSensitiveEnvelopeV1Schema,
  ReviewCommentSensitiveMigrationSourceV1Schema,
} from '../reviews/comments/content.js';
import {
  AutomationOccurrenceEvidenceEqualityTagV1Schema,
} from '../automations/automationOccurrenceV1.js';
import {
  AutomationIdV1Schema,
} from '../automations/automationIdV1.js';
import { AutomationRunCauseSchema } from '../automations/automationRunCause.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from '../automations/automationTriggerIdentity.js';
import {
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from '../automations/automationEventV1.js';
import {
  AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS,
} from '../automations/automationTemplateEnvelope.js';
import { AccountSettingsStoredContentEnvelopeSchema } from './settings/index.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import {
  SessionDraftRecordV1Schema,
  SessionDraftStoredContentEnvelopeV1Schema,
} from '../drafts/sessionDrafts.js';

const NonNegativeSafeIntegerSchema =
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AccountEncryptionMigrateToModeSchema = AccountEncryptionModeSchema;
export type AccountEncryptionMigrateToMode = z.infer<
  typeof AccountEncryptionMigrateToModeSchema
>;

const AccountEncryptionMigratePredecessorKeyProofSchema = z
  .object({
    publicKey: z.string().min(1).max(4096),
    challenge: z.string().min(1).max(4096),
    signature: z.string().min(1).max(4096),
    contentPublicKey: z.string().min(1).max(4096).optional(),
    contentPublicKeySig: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasContentKey = typeof value.contentPublicKey === 'string';
    const hasContentSig = typeof value.contentPublicKeySig === 'string';
    if (hasContentKey !== hasContentSig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
  });

const AccountEncryptionMigrateUnsignedKeyProofShape = {
  v: z.literal(1),
  publicKey: z.string().min(1).max(4096),
  contentPublicKey: z.string().min(1).max(4096).optional(),
  contentPublicKeySig: z.string().min(1).max(4096).optional(),
} as const;

function refineAccountEncryptionMigrateContentKeyBinding(
  value: {
    contentPublicKey?: string;
    contentPublicKeySig?: string;
  },
  ctx: z.RefinementCtx,
): void {
    const hasContentKey = typeof value.contentPublicKey === 'string';
    const hasContentSig = typeof value.contentPublicKeySig === 'string';
    if (hasContentKey !== hasContentSig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
}

export const AccountEncryptionMigrateUnsignedKeyProofSchema = z
  .object(AccountEncryptionMigrateUnsignedKeyProofShape)
  .strict()
  .superRefine(refineAccountEncryptionMigrateContentKeyBinding);
export type AccountEncryptionMigrateUnsignedKeyProof = z.infer<
  typeof AccountEncryptionMigrateUnsignedKeyProofSchema
>;

export const AccountEncryptionMigrateKeyProofSchema = z
  .object({
    ...AccountEncryptionMigrateUnsignedKeyProofShape,
    signature: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine(refineAccountEncryptionMigrateContentKeyBinding);
export type AccountEncryptionMigrateKeyProof = z.infer<
  typeof AccountEncryptionMigrateKeyProofSchema
>;

const ConnectedServiceCredentialMetadataSchema = z
  .object({
    kind: z.enum(['oauth', 'token']),
    providerEmail: z.string().min(1).nullable().optional(),
    providerAccountId: z.string().min(1).nullable().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

const ConnectedServiceCredentialMigrationItemShape = {
  serviceId: ConnectedServiceIdSchema,
  profileId: ConnectedServiceProfileIdSchema,
  kind: z.enum(['plain', 'sealed']),
  record: ConnectedServiceCredentialRecordV1Schema.optional(),
  sealed: SealedConnectedServiceCredentialV1Schema.optional(),
  metadata: ConnectedServiceCredentialMetadataSchema.optional(),
} as const;

function refineConnectedServiceCredentialMigrationItem(
  value: z.infer<
    typeof AccountEncryptionMigratePredecessorConnectedServiceCredentialMigrationItemSchemaBase
  >,
  ctx: z.RefinementCtx,
): void {
    if (value.kind === 'plain') {
      if (!value.record) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'record is required for plain migrations',
        });
      }
      if (value.sealed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sealed must not be provided for plain migrations',
        });
      }
    } else {
      if (!value.sealed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'sealed is required for sealed migrations',
        });
      }
      if (value.record) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'record must not be provided for sealed migrations',
        });
      }
    }
}

const AccountEncryptionMigratePredecessorConnectedServiceCredentialMigrationItemSchemaBase =
  z.object(ConnectedServiceCredentialMigrationItemShape).strict();
const AccountEncryptionMigratePredecessorConnectedServiceCredentialMigrationItemSchema =
  AccountEncryptionMigratePredecessorConnectedServiceCredentialMigrationItemSchemaBase
    .superRefine(refineConnectedServiceCredentialMigrationItem);

const ConnectedServiceCredentialMigrationItemSchema = z
  .object({
    ...ConnectedServiceCredentialMigrationItemShape,
    expectedCredentialRevision:
      ConnectedServiceCredentialRevisionV1Schema,
  })
  .strict()
  .superRefine(refineConnectedServiceCredentialMigrationItem);

const QualifiedConnectedAccountCredentialMigrationItemSchema = z.object({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision:
    z.string().trim().min(1).max(128).nullable(),
  authenticationModeId: asProtocolZod(PluginContributionLocalIdSchema),
  replacementCredentialContentEnvelope: StoredJsonContentEnvelopeSchema,
  replacementConfigurationContentEnvelope:
    StoredJsonContentEnvelopeSchema.optional(),
  metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
}).strict().superRefine((item, context) => {
  if (
    (item.expectedConfigurationRevision === null)
    !== (item.replacementConfigurationContentEnvelope === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['replacementConfigurationContentEnvelope'],
      message:
        'Qualified configuration replacement must exactly match the existing sidecar',
    });
  }
});

export const AccountEncryptionMigrateConnectedServicesDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        credentials:
          z.array(ConnectedServiceCredentialMigrationItemSchema)
            .default([]),
        qualifiedCredentials:
          z.array(QualifiedConnectedAccountCredentialMigrationItemSchema)
            .default([]),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateConnectedServicesDirective = z.infer<
  typeof AccountEncryptionMigrateConnectedServicesDirectiveSchema
>;

const AccountEncryptionMigratePredecessorConnectedServicesDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        credentials:
          z.array(
            AccountEncryptionMigratePredecessorConnectedServiceCredentialMigrationItemSchema,
          )
            .default([]),
        qualifiedCredentials:
          z.array(QualifiedConnectedAccountCredentialMigrationItemSchema)
            .default([]),
      })
      .strict(),
  ]);

/**
 * The one declaration of how large each retained Automation private-content
 * field may be. Every reader of the same persisted field binds here — the
 * migrate wire below, and the Account transition's durable staging rows, which
 * re-parse these exact fields out of their own stored JSON. A second local
 * ceiling would make a validly persisted envelope unmigratable.
 */
export const ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS = {
  templateCiphertext: z.string().min(1).max(AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS),
  triggerDefinitionEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  triggerEvidenceEnvelope: z.string().min(1).max(220_000),
  occurrenceEvidenceEqualityTag: AutomationOccurrenceEvidenceEqualityTagV1Schema,
  executionInputEnvelope: z.string().min(1).max(220_512),
  resultEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  replyContextEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  replyHandoffReceiptEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  failureDetailEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  summaryCiphertext: z.string().min(1).max(220_000),
} as const;

const AutomationsMigrationItemShape = {
  automationId: z.string().min(1).max(256),
  templateCiphertext: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.templateCiphertext,
} as const;

const AutomationTriggerDefinitionEnvelopeMigrationItemSchema = z.object({
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  envelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerDefinitionEnvelope,
}).strict();
const AutomationTriggerDefinitionEnvelopesMigrationSchema = z.array(
  AutomationTriggerDefinitionEnvelopeMigrationItemSchema,
).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.triggerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'triggerId'],
        message: 'Automation migration cannot replace one trigger definition twice',
      });
    }
    seen.add(item.triggerId);
  });
});

const AccountEncryptionMigratePredecessorAutomationsMigrationItemSchema = z
  .object(AutomationsMigrationItemShape)
  .strict();

const AutomationsMigrationItemSchema = z
  .object({
    ...AutomationsMigrationItemShape,
    expectedTemplateVersion: NonNegativeSafeIntegerSchema,
    // Requests signed before multi-trigger Automation migration did not carry
    // this member. Preserve the exact parsed bytes; the Automation owner treats
    // omission as no submitted trigger-definition replacements and still
    // refuses a target that does not cover its current plugin-Event triggers.
    triggerDefinitionEnvelopes: AutomationTriggerDefinitionEnvelopesMigrationSchema.optional(),
  })
  .strict();

/**
 * One immutable retained-Run private-content transition. Run
 * revision is the canonical monotonic Run-row currentness boundary;
 * Automation owns the coupled envelope/tag validation and CAS while the
 * Account coordinator owns mode activation.
 */
const AutomationRunMigrationItemSchema = z
  .object({
    runId: z.string().min(1).max(256),
    expectedRunRevision: NonNegativeSafeIntegerSchema,
    triggerEvidenceEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerEvidenceEnvelope.nullable(),
    occurrenceEvidenceEqualityTag:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.occurrenceEvidenceEqualityTag.nullable(),
    executionInputEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.executionInputEnvelope.nullable(),
    resultEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    replyContextEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyContextEnvelope.nullable(),
    replyHandoffReceiptEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyHandoffReceiptEnvelope.nullable(),
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
  })
  .strict();

export const ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS = 500;

export const AccountEncryptionMigrateAutomationsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        templates: z
          .array(AutomationsMigrationItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
        // This member is intentionally wire-optional: the full directive is
        // request-bound and older signed schedule-only callers must retain
        // their exact bytes. The Automation owner normalizes absence to an
        // empty inventory and rejects any retained Run before activation.
        runs: z
          .array(AutomationRunMigrationItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS)
          .optional(),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateAutomationsDirective = z.infer<
  typeof AccountEncryptionMigrateAutomationsDirectiveSchema
>;
/**
 * Accepted Automation-migration input. The schema normalizes an omitted
 * Run inventory to an empty list for current schedule-only callers.
 */
export type AccountEncryptionMigrateAutomationsDirectiveInput = z.input<
  typeof AccountEncryptionMigrateAutomationsDirectiveSchema
>;

const AccountEncryptionMigratePredecessorAutomationsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        templates:
          z.array(
            AccountEncryptionMigratePredecessorAutomationsMigrationItemSchema,
          ).max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
      })
      .strict(),
  ]);

const AccountEncryptionMigrateMachineItemSchema = z
  .object({
    machineId: z.string().min(1).max(256),
    expectedMetadataVersion: NonNegativeSafeIntegerSchema,
    expectedDaemonStateVersion: NonNegativeSafeIntegerSchema,
    metadata: z.string().min(1).max(2_000_000),
    daemonState: z.string().min(1).max(2_000_000).nullable(),
    dataEncryptionKey: z.string().min(1).max(16_384).nullable(),
    contentPublicKeyFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const AccountEncryptionMigrateMachinesDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateMachineItemSchema).max(500),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateMachinesDirective = z.infer<
  typeof AccountEncryptionMigrateMachinesDirectiveSchema
>;

const AccountEncryptionMigrateTodoItemSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (key) => key === 'todo.index' || (
          key.startsWith('todo.')
          && key.length > 'todo.'.length
        ),
        { message: 'Todo migration keys must use the Todo namespace' },
      ),
    expectedVersion: NonNegativeSafeIntegerSchema,
    value: z.string().min(1).max(2_000_000),
  })
  .strict();

export const AccountEncryptionMigrateTodosDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateTodoItemSchema).max(1_000),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateTodosDirective = z.infer<
  typeof AccountEncryptionMigrateTodosDirectiveSchema
>;

const AccountEncryptionMigrateArtifactItemSchema = z
  .object({
    artifactId: z.string().uuid(),
    expectedHeaderVersion: NonNegativeSafeIntegerSchema,
    expectedBodyVersion: NonNegativeSafeIntegerSchema,
    header: z.string().min(1).max(4_000_000),
    body: z.string().min(1).max(4_000_000),
    dataEncryptionKey: z.string().min(1).max(16_384),
  })
  .strict();

export const AccountEncryptionMigrateArtifactsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateArtifactItemSchema).max(500),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateArtifactsDirective = z.infer<
  typeof AccountEncryptionMigrateArtifactsDirectiveSchema
>;

export const AccountEncryptionMigrateSessionItemSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    expectedMetadataLayoutVersion:
      z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    expectedMetadataVersion: NonNegativeSafeIntegerSchema,
    expectedAgentStateVersion: NonNegativeSafeIntegerSchema,
    expectedOwnerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  })
  .strict();
export type AccountEncryptionMigrateSessionItem = z.infer<
  typeof AccountEncryptionMigrateSessionItemSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS = 500;

export const AccountEncryptionMigrateSessionsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z
          .array(AccountEncryptionMigrateSessionItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateSessionsDirective = z.infer<
  typeof AccountEncryptionMigrateSessionsDirectiveSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENTS_MAX_ITEMS = 200;
export const ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENT_EVENTS_MAX_ITEMS = 2_000;

const AccountEncryptionMigrateReviewCommentEventItemSchema = z
  .object({
    eventId: z.string().min(1).max(256),
    expectedSensitiveEnvelope:
      BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    targetSensitiveEnvelope:
      BoundReviewCommentEventSensitiveEnvelopeV1Schema,
  })
  .strict();

const AccountEncryptionMigrateReviewCommentItemSchema = z
  .object({
    commentId: z.string().min(1).max(256),
    expectedServerRevision: NonNegativeSafeIntegerSchema,
    expectedBodyVersion: NonNegativeSafeIntegerSchema,
    expectedSensitiveSource:
      ReviewCommentSensitiveMigrationSourceV1Schema,
    targetSensitiveEnvelope: StoredJsonContentEnvelopeSchema,
    events: z
      .array(AccountEncryptionMigrateReviewCommentEventItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENT_EVENTS_MAX_ITEMS),
  })
  .strict();

export const AccountEncryptionMigrateReviewCommentsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z
          .array(AccountEncryptionMigrateReviewCommentItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENTS_MAX_ITEMS),
      })
      .strict()
      .superRefine((directive, context) => {
        const eventCount = directive.items.reduce(
          (count, item) => count + item.events.length,
          0,
        );
        if (
          eventCount
          > ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENT_EVENTS_MAX_ITEMS
        ) {
          context.addIssue({
            code: 'too_big',
            maximum:
              ACCOUNT_ENCRYPTION_MIGRATE_REVIEW_COMMENT_EVENTS_MAX_ITEMS,
            origin: 'array',
            inclusive: true,
            path: ['items'],
            message:
              'Review Comment migration event inventory exceeds the supported bound',
          });
        }
      }),
  ]);
export type AccountEncryptionMigrateReviewCommentsDirective = z.infer<
  typeof AccountEncryptionMigrateReviewCommentsDirectiveSchema
>;

const AccountEncryptionMigrateSessionOrganizationDisplayItemShape = {
  expectedDisplay: SessionOrganizationContentEnvelopeSchema,
  display: SessionOrganizationContentEnvelopeSchema,
} as const;

export const AccountEncryptionMigrateSessionOrganizationDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        expectedVersion: NonNegativeSafeIntegerSchema,
        folders: z.array(z.object({
          folderId:
            z.string().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
          ...AccountEncryptionMigrateSessionOrganizationDisplayItemShape,
        }).strict()).max(SESSION_ORGANIZATION_MAX_FOLDERS),
        tags: z.array(z.object({
          tagId:
            z.string().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH),
          ...AccountEncryptionMigrateSessionOrganizationDisplayItemShape,
        }).strict()).max(SESSION_ORGANIZATION_MAX_TAGS),
        labels: z.array(z.object({
          labelKind: SessionOrganizationLabelKindSchema,
          scopeKey:
            z.string().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH),
          ...AccountEncryptionMigrateSessionOrganizationDisplayItemShape,
        }).strict()).max(SESSION_ORGANIZATION_MAX_LABELS),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateSessionOrganizationDirective = z.infer<
  typeof AccountEncryptionMigrateSessionOrganizationDirectiveSchema
>;

export const AccountEncryptionMigratePetsDirectiveSchema =
  z.object({ action: z.literal('assert_empty') }).strict();
export type AccountEncryptionMigratePetsDirective = z.infer<
  typeof AccountEncryptionMigratePetsDirectiveSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES = 8_000_000;

const AccountEncryptionMigratePredecessorRequestShape = {
  toMode: AccountEncryptionMigrateToModeSchema,
  expectedSettingsVersion: NonNegativeSafeIntegerSchema,
  settingsContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  connectedServices:
    AccountEncryptionMigratePredecessorConnectedServicesDirectiveSchema,
  automations:
    AccountEncryptionMigratePredecessorAutomationsDirectiveSchema,
  keyProof: AccountEncryptionMigratePredecessorKeyProofSchema.optional(),
} as const;

function refineAccountEncryptionMigrateRequest(
  request: {
    toMode: 'plain' | 'e2ee';
    keyProof?: {
      contentPublicKey?: string;
      contentPublicKeySig?: string;
    };
    connectedServices: {
      action: string;
      qualifiedCredentials?: Array<{
        replacementCredentialContentEnvelope: { t: string };
        replacementConfigurationContentEnvelope?: { t: string };
      }>;
    };
    sessions?: {
      action: string;
      items?: Array<{
        expectedOwnerMetadata: { t: string };
        ownerMetadata: { t: string };
      }>;
    };
    reviewComments?: {
      action: string;
      items?: Array<{
        expectedSensitiveSource:
          | {
              layout: 'canonical_v1';
              envelope: { t: string };
            }
          | {
              layout: 'legacy_split_v1';
              sourceMode: 'plain' | 'e2ee';
            };
        targetSensitiveEnvelope: { t: string };
        events: Array<{
          expectedSensitiveEnvelope: { sensitive: { t: string } };
          targetSensitiveEnvelope: { sensitive: { t: string } };
        }>;
      }>;
    };
    sessionOrganization?: {
      action: string;
      folders?: Array<{
        expectedDisplay: { t: string };
        display: { t: string };
      }>;
      tags?: Array<{
        expectedDisplay: { t: string };
        display: { t: string };
      }>;
      labels?: Array<{
        expectedDisplay: { t: string };
        display: { t: string };
      }>;
    };
  },
  context: z.RefinementCtx,
  options: Readonly<{
    requireE2eeKeyProof: boolean;
    requireCompleteCurrentContentBinding: boolean;
  }>,
): void {
    if (
      request.toMode === 'e2ee'
      && (
        (options.requireE2eeKeyProof && !request.keyProof)
        || (
          options.requireCompleteCurrentContentBinding
          && request.keyProof
          && (
        !request.keyProof?.contentPublicKey
        || !request.keyProof.contentPublicKeySig
          )
        )
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['keyProof', 'contentPublicKey'],
        message:
          'e2ee migrations require a complete signed content-key binding',
      });
    }
    const targetEnvelopeKind =
      request.toMode === 'plain' ? 'plain' : 'encrypted';
    if (
      request.connectedServices.action === 'migrate'
      && request.connectedServices.qualifiedCredentials
    ) {
      request.connectedServices.qualifiedCredentials.forEach((item, index) => {
        if (
          item.replacementCredentialContentEnvelope.t !== targetEnvelopeKind
        ) {
          context.addIssue({
            code: 'custom',
            path: [
              'connectedServices',
              'qualifiedCredentials',
              index,
              'replacementCredentialContentEnvelope',
            ],
            message:
              'Qualified credential replacement must match the target account encryption mode',
          });
        }
        if (
          item.replacementConfigurationContentEnvelope
          && item.replacementConfigurationContentEnvelope.t
            !== targetEnvelopeKind
        ) {
          context.addIssue({
            code: 'custom',
            path: [
              'connectedServices',
              'qualifiedCredentials',
              index,
              'replacementConfigurationContentEnvelope',
            ],
            message:
              'Qualified configuration replacement must match the target account encryption mode',
          });
        }
      });
    }
    const sourceEnvelopeKind =
      request.toMode === 'plain' ? 'encrypted' : 'plain';
    if (request.sessions?.action === 'migrate' && request.sessions.items) {
      request.sessions.items.forEach((item, index) => {
        if (item.expectedOwnerMetadata.t !== sourceEnvelopeKind) {
          context.addIssue({
            code: 'custom',
            path: ['sessions', 'items', index, 'expectedOwnerMetadata'],
            message:
              'Session source owner metadata must match the source account encryption mode',
          });
        }
        if (item.ownerMetadata.t !== targetEnvelopeKind) {
          context.addIssue({
            code: 'custom',
            path: ['sessions', 'items', index, 'ownerMetadata'],
            message:
              'Session target owner metadata must match the target account encryption mode',
          });
        }
      });
    }
    if (
      request.reviewComments?.action === 'migrate'
      && request.reviewComments.items
    ) {
      request.reviewComments.items.forEach((item, commentIndex) => {
        const expectedSourceMode =
          item.expectedSensitiveSource.layout === 'canonical_v1'
            ? (
              item.expectedSensitiveSource.envelope.t === 'encrypted'
                ? 'e2ee'
                : 'plain'
            )
            : item.expectedSensitiveSource.sourceMode;
        if (
          expectedSourceMode !== (
            sourceEnvelopeKind === 'encrypted' ? 'e2ee' : 'plain'
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: [
              'reviewComments',
              'items',
              commentIndex,
              'expectedSensitiveSource',
            ],
            message:
              'Review Comment source content must match the source account encryption mode',
          });
        }
        if (item.targetSensitiveEnvelope.t !== targetEnvelopeKind) {
          context.addIssue({
            code: 'custom',
            path: [
              'reviewComments',
              'items',
              commentIndex,
              'targetSensitiveEnvelope',
            ],
            message:
              'Review Comment target content must match the target account encryption mode',
          });
        }
        item.events.forEach((event, eventIndex) => {
          if (
            event.expectedSensitiveEnvelope.sensitive.t
            !== sourceEnvelopeKind
          ) {
            context.addIssue({
              code: 'custom',
              path: [
                'reviewComments',
                'items',
                commentIndex,
                'events',
                eventIndex,
                'expectedSensitiveEnvelope',
              ],
              message:
                'Review Comment event source content must match the source account encryption mode',
            });
          }
          if (
            event.targetSensitiveEnvelope.sensitive.t
            !== targetEnvelopeKind
          ) {
            context.addIssue({
              code: 'custom',
              path: [
                'reviewComments',
                'items',
                commentIndex,
                'events',
                eventIndex,
                'targetSensitiveEnvelope',
              ],
              message:
                'Review Comment event target content must match the target account encryption mode',
            });
          }
        });
      });
    }
    if (
      request.sessionOrganization?.action === 'migrate'
      && request.sessionOrganization.folders
      && request.sessionOrganization.tags
      && request.sessionOrganization.labels
    ) {
      const organizationItems = [
        ...request.sessionOrganization.folders.map((item, index) => ({
          item,
          path: ['folders', index] as const,
        })),
        ...request.sessionOrganization.tags.map((item, index) => ({
          item,
          path: ['tags', index] as const,
        })),
        ...request.sessionOrganization.labels.map((item, index) => ({
          item,
          path: ['labels', index] as const,
        })),
      ];
      organizationItems.forEach(({ item, path }) => {
        if (item.expectedDisplay.t !== sourceEnvelopeKind) {
          context.addIssue({
            code: 'custom',
            path: [
              'sessionOrganization',
              ...path,
              'expectedDisplay',
            ],
            message:
              'Session Organization source display must match the source account encryption mode',
          });
        }
        if (item.display.t !== targetEnvelopeKind) {
          context.addIssue({
            code: 'custom',
            path: ['sessionOrganization', ...path, 'display'],
            message:
              'Session Organization target display must match the target account encryption mode',
          });
        }
      });
    }
}

const AccountEncryptionMigratePredecessorRequestSchemaBase = z
  .object(AccountEncryptionMigratePredecessorRequestShape)
  .strict();

/**
 * Exact prospective predecessor wire from remote-dev
 * fae505bdc6916b3c9fa7a67eac3c4c88df759e9b.
 *
 * Server ingress may admit it only while Machine, Todo, and Artifact inventories
 * are empty. New clients must use AccountEncryptionMigrateRequestSchema.
 */
export const AccountEncryptionMigratePredecessorRequestSchema =
  AccountEncryptionMigratePredecessorRequestSchemaBase.superRefine(
    (request, context) => {
      refineAccountEncryptionMigrateRequest(request, context, {
        requireE2eeKeyProof: false,
        requireCompleteCurrentContentBinding: false,
      });
    },
  );
export type AccountEncryptionMigratePredecessorRequest = z.infer<
  typeof AccountEncryptionMigratePredecessorRequestSchema
>;

export const AccountEncryptionMigrateExternalAuthProofSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    pending: z.string().min(1).max(256),
    proof: z.string().min(1).max(4096),
  })
  .strict();
export type AccountEncryptionMigrateExternalAuthProof = z.infer<
  typeof AccountEncryptionMigrateExternalAuthProofSchema
>;

/**
 * V5 is an Account-owned migration transition. Collection rows only provide
 * exact source/target evidence; they never own transition authority or state.
 */
export const AccountEncryptionMigrateTransitionIdSchema = z.string().uuid();
export type AccountEncryptionMigrateTransitionId = z.infer<
  typeof AccountEncryptionMigrateTransitionIdSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS =
  500;
export const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES =
  8 * 1024 * 1024;

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const AccountEncryptionMigrateCollectionIdentityShape = {
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  rowId: PluginCollectionRowIdV1Schema,
} as const;

const AccountEncryptionMigrateCollectionSourceShape = {
  ...AccountEncryptionMigrateCollectionIdentityShape,
  revision: PositiveSafeIntegerSchema,
  sourceEnvelope: PluginCollectionContentEnvelopeV1Schema,
  schemaVersion: PositiveSafeIntegerSchema,
  contractDigest: PluginCollectionContractDigestV1Schema,
} as const;

/** The exact Collection row state from which a transition client derives a target. */
export const AccountEncryptionMigrateCollectionInventoryItemSchema = z
  .object(AccountEncryptionMigrateCollectionSourceShape)
  .strict();
export type AccountEncryptionMigrateCollectionInventoryItem = z.infer<
  typeof AccountEncryptionMigrateCollectionInventoryItemSchema
>;

/** One staged Collection replacement, guarded by identity, revision, and contract. */
export const AccountEncryptionMigrateCollectionStageItemSchema = z
  .object({
    ...AccountEncryptionMigrateCollectionIdentityShape,
    expectedRevision: PositiveSafeIntegerSchema,
    sourceEnvelope: PluginCollectionContentEnvelopeV1Schema,
    targetEnvelope: PluginCollectionContentEnvelopeV1Schema,
    schemaVersion: PositiveSafeIntegerSchema,
    contractDigest: PluginCollectionContractDigestV1Schema,
  })
  .strict();
export type AccountEncryptionMigrateCollectionStageItem = z.infer<
  typeof AccountEncryptionMigrateCollectionStageItemSchema
>;

export const AccountEncryptionMigrateTransitionPrepareRequestSchema = z
  .object({
    toMode: AccountEncryptionMigrateToModeSchema,
    expectedAccountVersion: NonNegativeSafeIntegerSchema,
    expectedSigningKeyFingerprint: z.string().min(1).max(256).nullable(),
    expectedContentKeyFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type AccountEncryptionMigrateTransitionPrepareRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionPrepareRequestSchema
>;

/** Server-created transition facts that authorization and every stage bind to. */
export const AccountEncryptionMigrateTransitionPrepareResponseSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    fromMode: AccountEncryptionMigrateToModeSchema,
    toMode: AccountEncryptionMigrateToModeSchema,
    expectedAccountVersion: NonNegativeSafeIntegerSchema,
    expectedSigningKeyFingerprint: z.string().min(1).max(256).nullable(),
    expectedContentKeyFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fromMode === value.toMode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toMode'],
        message: 'Transition source and target Account encryption modes must differ',
      });
    }
  });
export type AccountEncryptionMigrateTransitionPrepareResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionPrepareResponseSchema
>;

const AccountEncryptionMigrateTransitionAuthorizationSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('present_user_confirmation') }).strict(),
    z.object({
      kind: z.literal('first_key'),
      keyProof: AccountEncryptionMigrateKeyProofSchema,
      externalAuthProof: AccountEncryptionMigrateExternalAuthProofSchema,
    }).strict(),
  ],
);

/**
 * This phase is mandatory before Collection inventory or staging. The Account
 * coordinator persists the accepted confirmation or first-key authorization.
 */
export const AccountEncryptionMigrateTransitionAuthorizeRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    authorization: AccountEncryptionMigrateTransitionAuthorizationSchema,
  })
  .strict();
export type AccountEncryptionMigrateTransitionAuthorizeRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizeRequestSchema
>;

/** One fixed-size inventory page from the Account-owned transition census. */
export const AccountEncryptionMigrateCollectionInventoryPageRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict();
export type AccountEncryptionMigrateCollectionInventoryPageRequest = z.infer<
  typeof AccountEncryptionMigrateCollectionInventoryPageRequestSchema
>;

export const AccountEncryptionMigrateCollectionInventoryPageSchema = z
  .object({
    items: z
      .array(AccountEncryptionMigrateCollectionInventoryItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
    nextCursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict();
export type AccountEncryptionMigrateCollectionInventoryPage = z.infer<
  typeof AccountEncryptionMigrateCollectionInventoryPageSchema
>;

function collectionStageItemIdentity(
  item: AccountEncryptionMigrateCollectionStageItem,
): string {
  return `${item.pluginId}\u0000${item.collectionId}\u0000${item.rowId}`;
}

function utf8JsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Account encryption migration stage batches must be JSON serializable');
  }
  return new TextEncoder().encode(encoded).length;
}

/**
 * A bounded batch for the Account coordinator. It is intentionally free of
 * aggregate/lifetime limits, which the Account lifecycle owner must measure.
 */
export const AccountEncryptionMigrateCollectionStageBatchRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    items: z
      .array(AccountEncryptionMigrateCollectionStageItemSchema)
      .min(1)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      const identity = collectionStageItemIdentity(item);
      if (seen.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'A transition stage batch cannot contain the same Collection row twice',
        });
      }
      seen.add(identity);
    });
    if (
      utf8JsonByteLength(value)
      > ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Collection transition stage batch exceeds the encoded 8 MiB limit',
      });
    }
  });
export type AccountEncryptionMigrateCollectionStageBatchRequest = z.infer<
  typeof AccountEncryptionMigrateCollectionStageBatchRequestSchema
>;

export const AccountEncryptionMigrateTransitionCancelRequestSchema = z
  .object({ transitionId: AccountEncryptionMigrateTransitionIdSchema })
  .strict();
export type AccountEncryptionMigrateTransitionCancelRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionCancelRequestSchema
>;

/** The only V5 Collection finalization directive; no direct payload bypass exists. */
export const AccountEncryptionMigrateCollectionDirectiveSchema = z
  .object({
    action: z.literal('staged'),
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
  })
  .strict();
export type AccountEncryptionMigrateCollectionDirective = z.infer<
  typeof AccountEncryptionMigrateCollectionDirectiveSchema
>;

/**
 * V5's closed Automation participant mirrors the Collection transition shape:
 * source facts are explicit, a target is only accepted against those facts,
 * and the Account transition remains the only lifecycle/activation owner.
 */
const AccountEncryptionMigrateAutomationDefinitionContentSchema = z
  .object({
    templateCiphertext:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.templateCiphertext,
    triggerDefinitionEnvelopes: AutomationTriggerDefinitionEnvelopesMigrationSchema,
  })
  .strict();

const AccountEncryptionMigrateAutomationRunSourceContentSchema = z
  .object({
    triggerEvidenceEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerEvidenceEnvelope.nullable(),
    occurrenceEvidenceEqualityTag:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.occurrenceEvidenceEqualityTag.nullable(),
    executionInputEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.executionInputEnvelope.nullable(),
    resultEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    replyContextEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyContextEnvelope.nullable(),
    replyHandoffReceiptEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyHandoffReceiptEnvelope.nullable(),
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
    summaryCiphertext:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.summaryCiphertext.nullable(),
  })
  .strict();

const AccountEncryptionMigrateAutomationRunTargetContentSchema = z
  .object({
    triggerEvidenceEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerEvidenceEnvelope.nullable(),
    occurrenceEvidenceEqualityTag:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.occurrenceEvidenceEqualityTag.nullable(),
    executionInputEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.executionInputEnvelope.nullable(),
    resultEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    replyContextEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyContextEnvelope.nullable(),
    replyHandoffReceiptEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyHandoffReceiptEnvelope.nullable(),
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
  })
  .strict();

export const AccountEncryptionMigrateAutomationInventoryItemSchema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('definition'),
      automationId: asProtocolZod(AutomationIdV1Schema),
      revision: NonNegativeSafeIntegerSchema,
      source: AccountEncryptionMigrateAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
      kind: z.literal('run'),
      runId: asProtocolZod(AutomationIdV1Schema),
      automationId: asProtocolZod(AutomationIdV1Schema),
      revision: NonNegativeSafeIntegerSchema,
      cause: AutomationRunCauseSchema,
      source: AccountEncryptionMigrateAutomationRunSourceContentSchema,
    }).strict(),
  ]);
export type AccountEncryptionMigrateAutomationInventoryItem = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryItemSchema
>;

export const AccountEncryptionMigrateAutomationStageItemSchema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('definition'),
      automationId: asProtocolZod(AutomationIdV1Schema),
      expectedRevision: NonNegativeSafeIntegerSchema,
      source: AccountEncryptionMigrateAutomationDefinitionContentSchema,
      target: AccountEncryptionMigrateAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
      kind: z.literal('run'),
      runId: asProtocolZod(AutomationIdV1Schema),
      automationId: asProtocolZod(AutomationIdV1Schema),
      expectedRevision: NonNegativeSafeIntegerSchema,
      cause: AutomationRunCauseSchema,
      source: AccountEncryptionMigrateAutomationRunSourceContentSchema,
      target: AccountEncryptionMigrateAutomationRunTargetContentSchema,
    }).strict(),
  ]);
export type AccountEncryptionMigrateAutomationStageItem = z.infer<
  typeof AccountEncryptionMigrateAutomationStageItemSchema
>;

export const AccountEncryptionMigrateAutomationInventoryPageRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict();
export type AccountEncryptionMigrateAutomationInventoryPageRequest = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryPageRequestSchema
>;

export const AccountEncryptionMigrateAutomationInventoryPageSchema = z
  .object({
    items: z
      .array(AccountEncryptionMigrateAutomationInventoryItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
    nextCursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict();
export type AccountEncryptionMigrateAutomationInventoryPage = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryPageSchema
>;

function automationStageItemIdentity(
  item: AccountEncryptionMigrateAutomationStageItem,
): string {
  return item.kind === 'definition'
    ? `definition\u0000${item.automationId}`
    : `run\u0000${item.runId}`;
}

export const AccountEncryptionMigrateAutomationStageBatchRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    items: z
      .array(AccountEncryptionMigrateAutomationStageItemSchema)
      .min(1)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      const identity = automationStageItemIdentity(item);
      if (seen.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'A transition stage batch cannot contain the same Automation participant twice',
        });
      }
      seen.add(identity);
    });
    if (
      utf8JsonByteLength(value)
      > ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Automation transition stage batch exceeds the encoded 8 MiB limit',
      });
    }
  });
export type AccountEncryptionMigrateAutomationStageBatchRequest = z.infer<
  typeof AccountEncryptionMigrateAutomationStageBatchRequestSchema
>;

/** The only V5 Automation finalization directive; no direct payload bypass exists. */
export const AccountEncryptionMigrateAutomationDirectiveSchema = z
  .object({
    action: z.literal('staged'),
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
  })
  .strict();
export type AccountEncryptionMigrateAutomationDirective = z.infer<
  typeof AccountEncryptionMigrateAutomationDirectiveSchema
>;

/** Current V5 activation is a transition reference, not a second authorization. */
export const AccountEncryptionMigrateTransitionActivateRequestSchema = z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    collections: AccountEncryptionMigrateCollectionDirectiveSchema,
    automations: AccountEncryptionMigrateAutomationDirectiveSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.collections.transitionId !== value.transitionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collections', 'transitionId'],
        message: 'Collection staged directive must reference the activated transition',
      });
    }
    if (value.automations.transitionId !== value.transitionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automations', 'transitionId'],
        message: 'Automation staged directive must reference the activated transition',
      });
    }
  });
export type AccountEncryptionMigrateTransitionActivateRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionActivateRequestSchema
>;

/** Authorization and cancellation acknowledge only the Account-owned transition. */
export const AccountEncryptionMigrateTransitionAuthorizeResponseSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type AccountEncryptionMigrateTransitionAuthorizeResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizeResponseSchema
>;

export const AccountEncryptionMigrateTransitionCancelResponseSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type AccountEncryptionMigrateTransitionCancelResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionCancelResponseSchema
>;

/**
 * Aggregate stage counters describe Account-owned accepted state; the V5
 * 500-row and 8 MiB limits bound one transport batch, never the aggregate.
 */
export const AccountEncryptionMigrateCollectionStageBatchResponseSchema = z
  .object({
    success: z.literal(true),
    stagedParticipantCount: NonNegativeSafeIntegerSchema,
    stagedSourceBytes: NonNegativeSafeIntegerSchema,
    stagedTargetBytes: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigrateCollectionStageBatchResponse = z.infer<
  typeof AccountEncryptionMigrateCollectionStageBatchResponseSchema
>;

export const AccountEncryptionMigrateAutomationStageBatchResponseSchema = z
  .object({
    success: z.literal(true),
    stagedParticipantCount: NonNegativeSafeIntegerSchema,
    stagedSourceBytes: NonNegativeSafeIntegerSchema,
    stagedTargetBytes: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigrateAutomationStageBatchResponse = z.infer<
  typeof AccountEncryptionMigrateAutomationStageBatchResponseSchema
>;

/** Activation exposes only the canonical post-commit Account facts. */
export const AccountEncryptionMigrateTransitionActivateResponseSchema = z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    accountVersion: NonNegativeSafeIntegerSchema,
    updatedAt: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigrateTransitionActivateResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionActivateResponseSchema
>;

/** One Account-owned new-session draft replacement in the atomic V4 migration. */
export const AccountEncryptionMigrateSessionDraftItemSchema = z.object({
  address: z.object({
    kind: z.literal('newSession'),
    draftId: z.string().uuid(),
  }).strict(),
  expectedRevision: NonNegativeSafeIntegerSchema,
  content: SessionDraftStoredContentEnvelopeV1Schema,
}).strict();
export type AccountEncryptionMigrateSessionDraftItem = z.infer<
  typeof AccountEncryptionMigrateSessionDraftItemSchema
>;

export const AccountEncryptionMigrateSessionDraftsDirectiveSchema = z.object({
  items: z.array(AccountEncryptionMigrateSessionDraftItemSchema)
    .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.address.draftId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'address', 'draftId'],
        message: 'Account migration cannot replace the same new-session draft twice',
      });
    }
    seen.add(item.address.draftId);
  });
});
export type AccountEncryptionMigrateSessionDraftsDirective = z.infer<
  typeof AccountEncryptionMigrateSessionDraftsDirectiveSchema
>;

const AccountEncryptionMigrateCurrentRequestShape = {
  toMode: AccountEncryptionMigrateToModeSchema,
  expectedAccountVersion: NonNegativeSafeIntegerSchema,
  expectedSigningKeyFingerprint:
    z.string().min(1).max(256).nullable(),
  expectedContentKeyFingerprint:
    z.string().min(1).max(256).nullable(),
  expectedSettingsVersion: NonNegativeSafeIntegerSchema,
  settingsContent:
    AccountSettingsStoredContentEnvelopeSchema.nullable(),
  connectedServices:
    AccountEncryptionMigrateConnectedServicesDirectiveSchema,
  automations: AccountEncryptionMigrateAutomationsDirectiveSchema,
  machines: AccountEncryptionMigrateMachinesDirectiveSchema,
  todos: AccountEncryptionMigrateTodosDirectiveSchema,
  artifacts: AccountEncryptionMigrateArtifactsDirectiveSchema,
  sessions: AccountEncryptionMigrateSessionsDirectiveSchema,
  reviewComments: AccountEncryptionMigrateReviewCommentsDirectiveSchema,
  sessionOrganization:
    AccountEncryptionMigrateSessionOrganizationDirectiveSchema,
  pets: AccountEncryptionMigratePetsDirectiveSchema,
  sessionDrafts: AccountEncryptionMigrateSessionDraftsDirectiveSchema.optional(),
  externalAuthProof:
    AccountEncryptionMigrateExternalAuthProofSchema.optional(),
} as const;

export const AccountEncryptionMigrateUnsignedRequestSchema = z
  .object({
    ...AccountEncryptionMigrateCurrentRequestShape,
    keyProof: AccountEncryptionMigrateUnsignedKeyProofSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    refineAccountEncryptionMigrateRequest(request, context, {
      requireE2eeKeyProof: true,
      requireCompleteCurrentContentBinding: true,
    });
  });
export type AccountEncryptionMigrateUnsignedRequest = z.infer<
  typeof AccountEncryptionMigrateUnsignedRequestSchema
>;

export const AccountEncryptionMigrateRequestSchema = z
  .object({
    ...AccountEncryptionMigrateCurrentRequestShape,
    keyProof: AccountEncryptionMigrateKeyProofSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    refineAccountEncryptionMigrateRequest(request, context, {
      requireE2eeKeyProof: false,
      requireCompleteCurrentContentBinding: true,
    });
  });
export type AccountEncryptionMigrateRequest = z.infer<
  typeof AccountEncryptionMigrateRequestSchema
>;

const ACCOUNT_ENCRYPTION_MIGRATE_KEY_FINGERPRINT_V1_PREFIX = 'aemk1_' as const;

export function computeAccountEncryptionMigrateKeyFingerprintV1(
  publicKey: Uint8Array,
): string {
  return `${ACCOUNT_ENCRYPTION_MIGRATE_KEY_FINGERPRINT_V1_PREFIX}${encodeBase64(sha256(publicKey), 'base64url')}`;
}

export function convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
  fingerprint: ContentPublicKeyFingerprint,
): string {
  const canonical = ContentPublicKeyFingerprintSchema.parse(fingerprint);
  const digestHex = canonical.slice(canonical.indexOf(':') + 1);
  return `${ACCOUNT_ENCRYPTION_MIGRATE_KEY_FINGERPRINT_V1_PREFIX}${encodeBase64(hexToBytes(digestHex), 'base64url')}`;
}

const ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_BINDING_DIGEST_V1_PREFIX =
  'aemrb1_';
const ACCOUNT_ENCRYPTION_MIGRATE_PROOF_SIGNING_DOMAIN_V1 =
  'happier.account-encryption-migrate-proof.v1';

export const AccountEncryptionMigrateRequestBindingDigestV1Schema = z
  .string()
  .regex(/^aemrb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type AccountEncryptionMigrateRequestBindingDigestV1 = z.infer<
  typeof AccountEncryptionMigrateRequestBindingDigestV1Schema
>;

type AccountEncryptionMigrateRequestBindingParamsV1 = Readonly<{
  request: (
    | AccountEncryptionMigrateUnsignedRequest
    | AccountEncryptionMigrateRequest
  ) & Readonly<{
    externalAuthProof?: unknown;
  }>;
  accountId: string;
  sourceMode: 'plain' | 'e2ee';
}>;

function normalizeAccountEncryptionMigrateRequestBindingV1(
  params: AccountEncryptionMigrateRequestBindingParamsV1,
) {
  const accountId = z.string().trim().min(1).max(256).parse(
    params.accountId,
  );
  const sourceMode = AccountEncryptionMigrateToModeSchema.parse(
    params.sourceMode,
  );
  // The fresh external-auth artifact authorizes the already-bound digest, so it
  // is excluded before the migration request's strict schema is parsed. Its
  // strict shape remains auth-owned; every other unknown request field still
  // reaches and fails the strict migration schema below.
  const {
    externalAuthProof: _externalAuthProof,
    ...requestWithoutExternalAuthProof
  } = params.request;
  const signedRequest = AccountEncryptionMigrateRequestSchema.safeParse(
    requestWithoutExternalAuthProof,
  );
  const request = signedRequest.success
    ? AccountEncryptionMigrateUnsignedRequestSchema.parse({
        ...signedRequest.data,
        // This is the only unstable outer signature in the current request
        // schema. Future outer authorization artifacts must be excluded here
        // explicitly rather than acquiring a second request serializer.
        keyProof: signedRequest.data.keyProof
          ? {
              v: signedRequest.data.keyProof.v,
              publicKey: signedRequest.data.keyProof.publicKey,
              contentPublicKey:
                signedRequest.data.keyProof.contentPublicKey,
              contentPublicKeySig:
                signedRequest.data.keyProof.contentPublicKeySig,
            }
          : undefined,
      })
    : AccountEncryptionMigrateUnsignedRequestSchema.parse(
        requestWithoutExternalAuthProof,
      );
  if (sourceMode === request.toMode) {
    throw new Error(
      'Account encryption migration request binding requires distinct source and target modes',
    );
  }

  let proposedSigningKeyFingerprint =
    request.expectedSigningKeyFingerprint;
  let proposedContentKeyFingerprint =
    request.expectedContentKeyFingerprint;
  if (request.toMode === 'e2ee') {
    const keyProof = request.keyProof;
    if (!keyProof) {
      throw new Error(
        'Account encryption migration request binding requires an e2ee key proof',
      );
    }
    proposedSigningKeyFingerprint =
      computeAccountEncryptionMigrateKeyFingerprintV1(
        decodeBase64(keyProof.publicKey),
      );
    proposedContentKeyFingerprint = keyProof.contentPublicKey
      ? computeAccountEncryptionMigrateKeyFingerprintV1(
          decodeBase64(keyProof.contentPublicKey),
        )
      : null;
  }

  return {
    domain: ACCOUNT_ENCRYPTION_MIGRATE_PROOF_SIGNING_DOMAIN_V1,
    accountId,
    sourceMode,
    targetMode: request.toMode,
    expectedAccountVersion: request.expectedAccountVersion,
    expectedSettingsVersion: request.expectedSettingsVersion,
    currentSigningKeyFingerprint:
      request.expectedSigningKeyFingerprint,
    currentContentKeyFingerprint:
      request.expectedContentKeyFingerprint,
    proposedSigningKeyFingerprint,
    proposedContentKeyFingerprint,
    request,
  } as const;
}

function serializeAccountEncryptionMigrateRequestBindingV1(
  params: AccountEncryptionMigrateRequestBindingParamsV1,
): string {
  return createCanonicalJsonSigningInput(
    normalizeAccountEncryptionMigrateRequestBindingV1(params),
  );
}

function createAccountEncryptionMigrateRequestBindingDigestBytesV1(
  params: AccountEncryptionMigrateRequestBindingParamsV1,
): Uint8Array {
  return sha256(
    utf8ToBytes(
      serializeAccountEncryptionMigrateRequestBindingV1(params),
    ),
  );
}

export function createAccountEncryptionMigrateRequestBindingDigestV1(
  params: AccountEncryptionMigrateRequestBindingParamsV1,
): AccountEncryptionMigrateRequestBindingDigestV1 {
  return AccountEncryptionMigrateRequestBindingDigestV1Schema.parse(
    `${
      ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_BINDING_DIGEST_V1_PREFIX
    }${
      encodeBase64(
        createAccountEncryptionMigrateRequestBindingDigestBytesV1(
          params,
        ),
        'base64url',
      )
    }`,
  );
}

export function createAccountEncryptionMigrateProofSigningInputV1(
  params: Readonly<{
    request:
      | AccountEncryptionMigrateUnsignedRequest
      | AccountEncryptionMigrateRequest;
    accountId: string;
    sourceMode: 'plain' | 'e2ee';
  }>,
): Uint8Array {
  if (params.request.toMode !== 'e2ee' || !params.request.keyProof) {
    throw new Error(
      'Account encryption migration proof requires an e2ee request',
    );
  }
  return utf8ToBytes(
    `${ACCOUNT_ENCRYPTION_MIGRATE_PROOF_SIGNING_DOMAIN_V1}\u0000${
      encodeBase64(
        createAccountEncryptionMigrateRequestBindingDigestBytesV1(
          params,
        ),
        'base64url',
      )
    }`,
  );
}

export function attachAccountEncryptionMigrateProofSignatureV1(
  params: Readonly<{
    request: AccountEncryptionMigrateUnsignedRequest;
    signature: string;
  }>,
): AccountEncryptionMigrateRequest {
  const request = AccountEncryptionMigrateUnsignedRequestSchema.parse(
    params.request,
  );
  if (request.toMode !== 'e2ee' || !request.keyProof) {
    throw new Error(
      'Account encryption migration proof requires an e2ee request',
    );
  }
  return AccountEncryptionMigrateRequestSchema.parse({
    ...request,
    keyProof: {
      ...request.keyProof,
      signature: params.signature,
    },
  });
}

const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_BINDING_DIGEST_V1_PREFIX =
  'aemtb1_';
const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_PROOF_SIGNING_DOMAIN_V1 =
  'happier.account-encryption-migrate-transition-authorization-proof.v1';

export const AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema = z
  .string()
  .regex(/^aemtb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1 = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema
>;

/**
 * First-key step-up providers persist an opaque authorization binding, not a
 * route shape. V5 adds the transition-bound digest alongside the established
 * one-request digest; accepting any other prefix would detach a proof from
 * its Account transition facts.
 */
export const AccountEncryptionMigrateExternalAuthBindingDigestV1Schema = z.union([
  AccountEncryptionMigrateRequestBindingDigestV1Schema,
  AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema,
]);
export type AccountEncryptionMigrateExternalAuthBindingDigestV1 = z.infer<
  typeof AccountEncryptionMigrateExternalAuthBindingDigestV1Schema
>;

type AccountEncryptionMigrateTransitionAuthorizationBindingParamsV1 = Readonly<{
  accountId: string;
  prepared: AccountEncryptionMigrateTransitionPrepareResponse;
  request: AccountEncryptionMigrateTransitionAuthorizeRequest;
}>;

function normalizeAccountEncryptionMigrateTransitionAuthorizationBindingV1(
  params: AccountEncryptionMigrateTransitionAuthorizationBindingParamsV1,
) {
  const accountId = z.string().trim().min(1).max(256).parse(params.accountId);
  const prepared = AccountEncryptionMigrateTransitionPrepareResponseSchema.parse(
    params.prepared,
  );
  const request = AccountEncryptionMigrateTransitionAuthorizeRequestSchema.parse(
    params.request,
  );
  if (prepared.transitionId !== request.transitionId) {
    throw new Error(
      'Account encryption migration transition authorization must bind the prepared transition',
    );
  }
  if (request.authorization.kind !== 'first_key') {
    throw new Error(
      'Account encryption migration transition key proof requires first-key authorization',
    );
  }
  const keyProof = request.authorization.keyProof;
  return {
    domain:
      ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_PROOF_SIGNING_DOMAIN_V1,
    accountId,
    transitionId: prepared.transitionId,
    sourceMode: prepared.fromMode,
    targetMode: prepared.toMode,
    expectedAccountVersion: prepared.expectedAccountVersion,
    expectedSigningKeyFingerprint: prepared.expectedSigningKeyFingerprint,
    expectedContentKeyFingerprint: prepared.expectedContentKeyFingerprint,
    proposedSigningKeyFingerprint:
      computeAccountEncryptionMigrateKeyFingerprintV1(
        decodeBase64(keyProof.publicKey),
      ),
    proposedContentKeyFingerprint: keyProof.contentPublicKey
      ? computeAccountEncryptionMigrateKeyFingerprintV1(
          decodeBase64(keyProof.contentPublicKey),
        )
      : null,
    keyProof: {
      v: keyProof.v,
      publicKey: keyProof.publicKey,
      contentPublicKey: keyProof.contentPublicKey,
      contentPublicKeySig: keyProof.contentPublicKeySig,
    },
  } as const;
}

function createAccountEncryptionMigrateTransitionAuthorizationBindingDigestBytesV1(
  params: AccountEncryptionMigrateTransitionAuthorizationBindingParamsV1,
): Uint8Array {
  return sha256(
    utf8ToBytes(
      createCanonicalJsonSigningInput(
        normalizeAccountEncryptionMigrateTransitionAuthorizationBindingV1(
          params,
        ),
      ),
    ),
  );
}

export function createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1(
  params: AccountEncryptionMigrateTransitionAuthorizationBindingParamsV1,
): AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1 {
  return AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema.parse(
    `${
      ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_BINDING_DIGEST_V1_PREFIX
    }${
      encodeBase64(
        createAccountEncryptionMigrateTransitionAuthorizationBindingDigestBytesV1(
          params,
        ),
        'base64url',
      )
    }`,
  );
}

/**
 * The first-key signature and external-auth authorization share this immutable
 * transition binding. External-auth proof bytes and the outer signature are
 * deliberately excluded to avoid self-referential proof serialization.
 */
export function createAccountEncryptionMigrateTransitionAuthorizationProofSigningInputV1(
  params: AccountEncryptionMigrateTransitionAuthorizationBindingParamsV1,
): Uint8Array {
  const digest = createAccountEncryptionMigrateTransitionAuthorizationBindingDigestV1(
    params,
  );
  return utf8ToBytes(
    `${
      ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_PROOF_SIGNING_DOMAIN_V1
    }\u0000${digest.slice(
      ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_AUTHORIZATION_BINDING_DIGEST_V1_PREFIX.length,
    )}`,
  );
}

export const AccountEncryptionMigrateSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    accountVersion: NonNegativeSafeIntegerSchema,
    settingsVersion: NonNegativeSafeIntegerSchema,
    sessionDrafts: z.object({
      records: z.array(SessionDraftRecordV1Schema)
        .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
    }).strict().optional(),
  })
  .strict();
export type AccountEncryptionMigrateSuccessResponse = z.infer<
  typeof AccountEncryptionMigrateSuccessResponseSchema
>;

export const AccountEncryptionMigratePredecessorSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    settingsVersion: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigratePredecessorSuccessResponse = z.infer<
  typeof AccountEncryptionMigratePredecessorSuccessResponseSchema
>;

export const AccountEncryptionMigrateInvalidParamsReasonSchema = z.enum([
  'restore_required',
  'key_proof_required',
  'migration_inventory_changed',
]);
export type AccountEncryptionMigrateInvalidParamsReason = z.infer<
  typeof AccountEncryptionMigrateInvalidParamsReasonSchema
>;

export const AccountEncryptionMigrateBadRequestResponseSchema =
  z.discriminatedUnion('error', [
    z
      .object({
        error: z.literal('invalid-params'),
        reason: AccountEncryptionMigrateInvalidParamsReasonSchema.optional(),
      })
      .strict(),
    z.object({ error: z.literal('connected_services_not_empty') }).strict(),
    z.object({ error: z.literal('automations_not_empty') }).strict(),
    z.object({ error: z.literal('machines_not_empty') }).strict(),
    z.object({ error: z.literal('todos_not_empty') }).strict(),
    z.object({ error: z.literal('artifacts_not_empty') }).strict(),
    z.object({ error: z.literal('review_comments_not_empty') }).strict(),
    z.object({ error: z.literal('session_organization_not_empty') }).strict(),
    z.object({ error: z.literal('pets_not_empty') }).strict(),
    z.object({ error: z.literal('plugin_collections_not_empty') }).strict(),
    z.object({ error: z.literal('migration_too_large') }).strict(),
    z.object({
      error: z.literal('metadata_privacy_upgrade_required'),
    }).strict(),
  ]);
export type AccountEncryptionMigrateBadRequestResponse = z.infer<
  typeof AccountEncryptionMigrateBadRequestResponseSchema
>;

export const AccountEncryptionMigrateForbiddenResponseSchema = z
  .object({ error: z.enum(['e2ee-required', 'plaintext-only']) })
  .strict();
export type AccountEncryptionMigrateForbiddenResponse = z.infer<
  typeof AccountEncryptionMigrateForbiddenResponseSchema
>;

export const AccountEncryptionMigrateNotFoundResponseSchema = z
  .object({ error: z.literal('not_found') })
  .strict();
export type AccountEncryptionMigrateNotFoundResponse = z.infer<
  typeof AccountEncryptionMigrateNotFoundResponseSchema
>;

export const AccountEncryptionMigrateConflictResponseSchema = z
  .object({
    error: z.literal('version-mismatch'),
    currentVersion: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigrateConflictResponse = z.infer<
  typeof AccountEncryptionMigrateConflictResponseSchema
>;

export const AccountEncryptionMigrateInternalResponseSchema = z
  .object({ error: z.literal('internal') })
  .strict();
export type AccountEncryptionMigrateInternalResponse = z.infer<
  typeof AccountEncryptionMigrateInternalResponseSchema
>;

export const AccountEncryptionMigrateAnyErrorResponseSchema = z.union([
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateForbiddenResponseSchema,
  AccountEncryptionMigrateNotFoundResponseSchema,
  AccountEncryptionMigrateConflictResponseSchema,
  AccountEncryptionMigrateInternalResponseSchema,
]);
export type AccountEncryptionMigrateAnyErrorResponse = z.infer<
  typeof AccountEncryptionMigrateAnyErrorResponseSchema
>;
