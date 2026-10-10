import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema, AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema,
  AccountEncryptionMigrateConnectedConfigurationsResultV1Schema, AccountEncryptionMigrateConnectedPurposesResultV1Schema,
  type AccountEncryptionMigrateConnectedConfigurationsDirectiveV1, type AccountEncryptionMigrateConnectedPurposesDirectiveV1,
} from '../connect/connectedAccountCatalogSchemasV1.js';
import { z } from 'zod';
import { ArtifactBlobAccountEncryptionStageV1Schema } from '../artifacts/artifactBinaryV1.js';
import { classifyAccountJsonKvKey } from './accountJsonKv.js';
import { AuthoringMemoryContentV1Schema, AuthoringMemoryKeyV1Schema, AuthoringMemoryRowV1Schema, assertAuthoringMemoryValueForKeyV1 } from './authoringMemory.js';
import { AccountEncryptionMigratePromptLibraryDirectiveV1Schema, AccountEncryptionMigratePromptLibraryResultV1Schema, type AccountEncryptionMigratePromptLibraryDirectiveV1 } from '../prompts/library/promptLibraryRowsV1.js';
import { AccountEncryptionMigrateRemoteHostsDirectiveV1Schema, AccountEncryptionMigrateRemoteHostsResultV1Schema,
  type AccountEncryptionMigrateRemoteHostsDirectiveV1 } from '../remoteHosts/remoteHostSchemasV1.js';
import { AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema, AccountEncryptionMigrateNotificationChannelsResultV1Schema,
  type AccountEncryptionMigrateNotificationChannelsDirectiveV1 } from './settings/notificationChannelRecordV1.js';
import { AccountEncryptionMigrateConnectedPresentationDirectiveV1Schema, AccountEncryptionMigrateConnectedPresentationResultV1Schema,
  AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1Schema, AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema,
  type AccountEncryptionMigrateConnectedPresentationDirectiveV1, type AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1,
} from '../connect/connectedAccountPresentationSchemasV1.js';
import { ProviderConnectionsMigrationContentV1Schema } from '../providers/connections/catalogSchemasV1.js';
import { AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema, AccountEncryptionMigrateMcpServerCatalogResultV1Schema,
  type AccountEncryptionMigrateMcpServerCatalogDirectiveV1 } from '../mcp/servers/catalogSchemasV1.js';
import { AccountEncryptionMigrateAcpCatalogDirectiveV1Schema, AccountEncryptionMigrateAcpCatalogResultV1Schema, type AccountEncryptionMigrateAcpCatalogDirectiveV1 } from '../acp/catalog/catalogSchemasV1.js';
import { WorkspaceExecutionConfigContentV1Schema, WorkspaceExecutionConfigRowIdV1Schema, WorkspaceExecutionConfigRowV1Schema } from '../workspaces/workspaceExecutionConfigRowV1.js';
import { ProjectAccountRowContentV1Schema, ProjectAccountRowKeyV1Schema, ProjectAccountRowV1Schema, buildProjectAccountRowPhysicalKeyV1 } from '../projects/projectAccountRowsV1.js';
import { AccountEncryptionMigrateProfileRowsDirectiveSchema, AccountEncryptionMigrateProfileRowsResultSchema } from '../profiles/profileRecordSchemaV1.js';
import { ProjectTrustContentV1Schema, ProjectTrustRowV1Schema, QualifiedProjectTrustProjectV1Schema } from '../workspaces/projectSetup/projectTrustRowV1.js';
import { ArtifactRecipientKeyEnvelopesV1Schema } from '../artifacts/artifactAccessV1.js';
import { ArtifactQuotaExceededV1Schema } from '../artifacts/artifactActionsV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import { AccountPasswordCredentialV1Schema } from '../auth/accountPasswordCredential.js';
import { PasswordMutationChallengeProofV1Schema } from '../auth/passwordMutationChallenge.js';
import { AccountExternalAuthProofV1Schema } from '../auth/accountExternalAuthProof.js';
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
} from '../connect/qualifiedConnectedAccountProjectionsV4.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import {
  PluginCollectionContentEnvelopeV1Schema,
  PluginCollectionContractDigestV1Schema,
  PluginCollectionOpaqueCursorV1Schema,
  PluginCollectionRevisionV1Schema,
  PluginCollectionRowIdV1Schema,
  PluginCollectionSchemaVersionV1Schema,
} from '../plugins/data/collectionsV1.js';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from './encryptionKeyFingerprintV1.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionOwnerMetadataEnvelopeV1Schema,
} from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { SESSION_ORGANIZATION_MAX_FOLDERS, SESSION_ORGANIZATION_MAX_ID_LENGTH, SESSION_ORGANIZATION_MAX_KEY_LENGTH, SESSION_ORGANIZATION_MAX_LABELS, SESSION_ORGANIZATION_MAX_TAGS } from '../sessions/organization/constants.js';
import { SessionOrganizationContentEnvelopeSchema } from '../sessions/organization/contentSchemas.js';
import { SessionOrganizationLabelKindSchema } from '../sessions/organization/ordering.js';
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
  WorkflowInvocationRecordIdSchema,
  WorkflowRunIdV1Schema,
} from '../workflows/workflowIdsV1.js';
import {
  WorkflowRunAutomationOriginV1Schema,
  WorkflowRunDirectOriginV1Schema,
  WorkflowRunInvocationIndexV1Schema,
} from '../workflows/workflowProgressV1.js';
import { WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunRecipientKeyEnvelopesV1Schema } from '../workflows/workflowRunKeyV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from '../automations/automationTriggerIdentity.js';
import {
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from '../automations/automationStoredContentEnvelopeV1.js';
import {
  AUTOMATION_TEMPLATE_CIPHERTEXT_MAX_CHARS,
} from '../automations/automationTemplateEnvelope.js';
import { AccountSettingsStoredContentEnvelopeSchema } from './settings/accountSettingsStoredContentEnvelope.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { createProtocolComposableSchema, ProtocolValidationError } from '../plugins/actions/protocolComposableSchema.js';
import {
  SessionDraftRecordV1Schema,
  SessionDraftStoredContentEnvelopeV1Schema,
} from '../drafts/sessionDrafts.js';
import {
  AccountOwnedDraftAddressV2Schema,
  canonicalSessionDraftAddressV2,
  SessionDraftRecordV2Schema,
  SessionDraftStoredContentEnvelopeV2Schema,
} from '../drafts/sessionDraftsV2.js';

export {
  computeAccountEncryptionMigrateKeyFingerprintV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from './encryptionKeyFingerprintV1.js';

const NonNegativeSafeIntegerSchema =
  lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

/** Project the incumbent catalog parser through the existing neutral composition seam. */
function accountEncryptionCatalogProtocolSchema<TSchema extends z.core.$ZodType>(
  schema: TSchema & { safeParse(value: unknown): z.core.util.SafeParseResult<z.output<TSchema>> },
) {
  return lazyDefinition(() => createProtocolComposableSchema<z.input<TSchema>, z.output<TSchema>>(
    { ...z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) },
    input => {
      const parsed = schema.safeParse(input);
      return parsed.success ? { success: true, data: parsed.data } : {
        success: false,
        error: new ProtocolValidationError(parsed.error.issues.map(issue => ({
          code: issue.code, message: issue.message,
          path: issue.path.filter(part => typeof part === 'string' || typeof part === 'number'),
        }))),
      };
    },
  ));
}

export const AccountEncryptionMigrateProviderConnectionsDirectiveV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: NonNegativeSafeIntegerSchema,
  content: ProviderConnectionsMigrationContentV1Schema.nullable(),
}).strict());
export type AccountEncryptionMigrateProviderConnectionsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateProviderConnectionsDirectiveV1Schema>;
export const AccountEncryptionMigrateProviderConnectionsResultV1Schema = lazyZodSchema(() => z.object({
  row: z.object({ revision: NonNegativeSafeIntegerSchema, content: ProviderConnectionsMigrationContentV1Schema.nullable() }).strict().nullable(),
}).strict());
export type AccountEncryptionMigrateProviderConnectionsResultV1 = z.infer<typeof AccountEncryptionMigrateProviderConnectionsResultV1Schema>;

export const AccountEncryptionMigrateToModeSchema = AccountEncryptionModeSchema;
export type AccountEncryptionMigrateToMode = z.infer<
  typeof AccountEncryptionMigrateToModeSchema
>;

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

export const AccountEncryptionMigrateUnsignedKeyProofSchema = lazyZodSchema(() => z
  .object(AccountEncryptionMigrateUnsignedKeyProofShape)
  .strict()
  .superRefine(refineAccountEncryptionMigrateContentKeyBinding));
export type AccountEncryptionMigrateUnsignedKeyProof = z.infer<
  typeof AccountEncryptionMigrateUnsignedKeyProofSchema
>;

export const AccountEncryptionMigrateKeyProofSchema = lazyZodSchema(() => z
  .object({
    ...AccountEncryptionMigrateUnsignedKeyProofShape,
    signature: z.string().min(1).max(4096),
  })
  .strict()
  .superRefine(refineAccountEncryptionMigrateContentKeyBinding));
export type AccountEncryptionMigrateKeyProof = z.infer<
  typeof AccountEncryptionMigrateKeyProofSchema
>;

const ConnectedServiceCredentialMetadataSchema = lazyZodSchema(() => z
  .object({
    kind: z.enum(['oauth', 'token']),
    providerEmail: z.string().min(1).nullable().optional(),
    providerAccountId: z.string().min(1).nullable().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict());

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
    z.ZodObject<typeof ConnectedServiceCredentialMigrationItemShape>
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

const ConnectedServiceCredentialMigrationItemSchema = lazyZodSchema(() => z
  .object({
    ...ConnectedServiceCredentialMigrationItemShape,
    expectedCredentialRevision:
      ConnectedServiceCredentialRevisionV1Schema,
  })
  .strict()
  .superRefine(refineConnectedServiceCredentialMigrationItem));

const QualifiedConnectedAccountCredentialMigrationItemSchema = lazyZodSchema(() => z.object({
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
}));

export const AccountEncryptionMigrateConnectedServicesDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
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
  ]));
export type AccountEncryptionMigrateConnectedServicesDirective = z.infer<
  typeof AccountEncryptionMigrateConnectedServicesDirectiveSchema
>;

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
  failureDetailEnvelope: z.string()
    .min(1)
    .max(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES),
  summaryCiphertext: z.string().min(1).max(220_000),
} as const;

const AutomationsMigrationItemShape = {
  automationId: z.string().min(1).max(256),
  templateCiphertext: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.templateCiphertext,
} as const;

const AutomationTriggerDefinitionEnvelopeMigrationItemSchema = lazyZodSchema(() => z.object({
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  envelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerDefinitionEnvelope,
}).strict());
const AutomationTriggerDefinitionEnvelopesMigrationSchema = lazyZodSchema(() => z.array(
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
}));

const AutomationsMigrationItemSchema = lazyZodSchema(() => z
  .object({
    ...AutomationsMigrationItemShape,
    expectedTemplateVersion: NonNegativeSafeIntegerSchema,
    triggerDefinitionEnvelopes: AutomationTriggerDefinitionEnvelopesMigrationSchema,
  })
  .strict());

/**
 * One immutable retained-Run private-content transition. Run
 * revision is the canonical monotonic Run-row currentness boundary;
 * Automation owns the coupled envelope/tag validation and CAS while the
 * Account coordinator owns mode activation.
 */
export const AccountEncryptionMigrateWorkflowRunDirectiveSchema = lazyZodSchema(() => z.object({
  sourceAcceptedSnapshotEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
  acceptedSnapshotEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
  sourceCheckpointEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
  checkpointEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
  expectedDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable(),
  recipientKeyEnvelopes: WorkflowRunRecipientKeyEnvelopesV1Schema,
  invocations: z.array(z.object({
    id: WorkflowInvocationRecordIdSchema,
    expectedContentRevision: WorkflowRunInvocationIndexV1Schema.shape.contentRevision,
    sourceContentEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
    contentEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
  }).strict()),
}).strict());
export type AccountEncryptionMigrateWorkflowRunDirective = z.infer<typeof AccountEncryptionMigrateWorkflowRunDirectiveSchema>;

const AutomationRunMigrationItemSchema = lazyZodSchema(() => z
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
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
    workflow: AccountEncryptionMigrateWorkflowRunDirectiveSchema.optional(),
  })
  .strict());

export const ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS = 500;

export const AccountEncryptionMigrateAutomationsDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        templates: z
          .array(AutomationsMigrationItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
        runs: z
          .array(AutomationRunMigrationItemSchema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateAutomationsDirective = z.infer<
  typeof AccountEncryptionMigrateAutomationsDirectiveSchema
>;
/** Accepted complete Automation-migration input. */
export type AccountEncryptionMigrateAutomationsDirectiveInput = z.input<
  typeof AccountEncryptionMigrateAutomationsDirectiveSchema
>;

/** Complete current owner inventory for the active V4 transition, not V5 staging. */
export const AccountEncryptionMigrateAutomationsInventoryResponseSchema = lazyZodSchema(() => z.object({
  templates: z.array(AutomationsMigrationItemSchema).max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
  runs: z.array(AutomationRunMigrationItemSchema.omit({ workflow: true }).extend({
    automationId: z.string().min(1).nullable(),
    occurrenceKey: z.string().min(1).nullable(),
    triggerId: z.string().min(1).nullable(),
    summaryCiphertext: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.summaryCiphertext.nullable(),
    workflow: z.object({
      acceptedSnapshotEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
      checkpointEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
      keyCensus: WorkflowRunRecipientCensusResponseV1Schema,
      invocations: z.array(z.object({
        index: WorkflowRunInvocationIndexV1Schema,
        contentEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
      }).strict()),
    }).strict().optional(),
  }).strict()).max(ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS),
}).strict());
export type AccountEncryptionMigrateAutomationsInventoryResponse = z.infer<typeof AccountEncryptionMigrateAutomationsInventoryResponseSchema>;

const AccountEncryptionMigrateMachineItemSchema = lazyZodSchema(() => z
  .object({
    machineId: z.string().min(1).max(256),
    expectedMetadataVersion: NonNegativeSafeIntegerSchema,
    expectedDaemonStateVersion: NonNegativeSafeIntegerSchema,
    metadata: z.string().min(1).max(2_000_000),
    daemonState: z.string().min(1).max(2_000_000).nullable(),
    dataEncryptionKey: z.string().min(1).max(16_384).nullable(),
    contentPublicKeyFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict());

export const AccountEncryptionMigrateMachinesDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateMachineItemSchema).max(500),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateMachinesDirective = z.infer<
  typeof AccountEncryptionMigrateMachinesDirectiveSchema
>;

const AccountEncryptionMigrateTodoItemSchema = lazyZodSchema(() => z
  .object({
    key: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (key) => classifyAccountJsonKvKey(key) === 'todo',
        { message: 'Todo migration keys must use the Todo namespace' },
      ),
    expectedVersion: NonNegativeSafeIntegerSchema,
    value: z.string().min(1).max(2_000_000),
  })
  .strict());

export const AccountEncryptionMigrateTodosDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateTodoItemSchema).max(1_000),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateTodosDirective = z.infer<
  typeof AccountEncryptionMigrateTodosDirectiveSchema
>;

/** Workspace replacements share the KV CAS and whole-request transport bound. */
export const AccountEncryptionMigrateWorkspaceDirectiveSchema = lazyZodSchema(() => z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert_empty') }).strict(),
  z.object({
    action: z.literal('migrate'),
    items: z.array(AccountEncryptionMigrateTodoItemSchema.extend({
      key: z.string().min(1).max(512).refine(key => classifyAccountJsonKvKey(key) === 'workspace',
        { message: 'Workspace migration keys must use the Workspace namespace' }),
    }).strict()),
  }).strict(),
]));
export type AccountEncryptionMigrateWorkspaceDirective = z.infer<typeof AccountEncryptionMigrateWorkspaceDirectiveSchema>;

const AccountEncryptionMigrateArtifactItemSchema = lazyZodSchema(() => z
  .object({
    artifactId: z.string().uuid(),
    expectedHeaderVersion: NonNegativeSafeIntegerSchema,
    expectedBodyVersion: NonNegativeSafeIntegerSchema,
    header: z.string().min(1).max(4_000_000),
    body: z.string().min(1).max(4_000_000),
    dataEncryptionKey: z.string().min(1).max(16_384),
    expectedDataEncryptionKey: z.string().min(1).max(16_384),
    // Absent private metadata is unknown attribution for legacy documents.
    expectedProvenance: z.string().min(1).nullable().optional(),
    expectedProvenanceDataEncryptionKey: z.string().min(1).max(16_384).nullable().optional(),
    provenance: z.string().min(1).nullable().optional(),
    provenanceDataEncryptionKey: z.string().min(1).max(16_384).nullable().optional(),
    recipientKeyEnvelopes: ArtifactRecipientKeyEnvelopesV1Schema,
    blobs: z.array(z.object({
      blobId: z.string().uuid(), expectedContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      content: ArtifactBlobAccountEncryptionStageV1Schema,
    }).strict()).superRefine((blobs, ctx) => {
      if (new Set(blobs.map(blob => blob.blobId)).size !== blobs.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact blob ids must be unique' });
      }
    }),
    revisions: z.array(z.object({
      bodyVersion: NonNegativeSafeIntegerSchema.min(1),
      expectedBody: z.string().min(1),
      body: z.string().min(1),
      expectedProvenance: z.string().min(1).nullable().optional(),
      provenance: z.string().min(1).nullable().optional(),
    }).strict()).superRefine((revisions, ctx) => {
      if (new Set(revisions.map(revision => revision.bodyVersion)).size !== revisions.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact revision body versions must be unique' });
      }
    }),
  })
  .strict());

export const AccountEncryptionMigrateArtifactsDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        // Complete owner census is governed by the signed whole-request byte budget, not a list page.
        items: z.array(AccountEncryptionMigrateArtifactItemSchema),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateArtifactsDirective = z.infer<
  typeof AccountEncryptionMigrateArtifactsDirectiveSchema
>;

export const AccountEncryptionMigrateSessionItemSchema = lazyZodSchema(() => z
  .object({
    sessionId: z.string().min(1).max(256),
    expectedMetadataLayoutVersion:
      z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
    expectedMetadataVersion: NonNegativeSafeIntegerSchema,
    expectedAgentStateVersion: NonNegativeSafeIntegerSchema,
    expectedOwnerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
    ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  })
  .strict());
export type AccountEncryptionMigrateSessionItem = z.infer<
  typeof AccountEncryptionMigrateSessionItemSchema
>;

export const AccountEncryptionMigrateSessionsDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        // The Account transition is one atomic census. Its real transport
        // ceiling is the aggregate 8 MiB request bound enforced at ingress;
        // an item-count ceiling rejects otherwise valid complete inventories.
        action: z.literal('migrate'),
        items: z.array(AccountEncryptionMigrateSessionItemSchema),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateSessionsDirective = z.infer<
  typeof AccountEncryptionMigrateSessionsDirectiveSchema
>;

const AccountEncryptionMigrateReviewCommentEventItemSchema = lazyZodSchema(() => z
  .object({
    eventId: z.string().min(1).max(256),
    expectedSensitiveEnvelope:
      BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    targetSensitiveEnvelope:
      BoundReviewCommentEventSensitiveEnvelopeV1Schema,
  })
  .strict());

const AccountEncryptionMigrateReviewCommentItemSchema = lazyZodSchema(() => z
  .object({
    commentId: z.string().min(1).max(256),
    expectedServerRevision: NonNegativeSafeIntegerSchema,
    expectedBodyVersion: NonNegativeSafeIntegerSchema,
    expectedSensitiveSource:
      ReviewCommentSensitiveMigrationSourceV1Schema,
    targetSensitiveEnvelope: StoredJsonContentEnvelopeSchema,
    events: z.array(AccountEncryptionMigrateReviewCommentEventItemSchema),
  })
  .strict());

export const AccountEncryptionMigrateReviewCommentsDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        // The complete Account transition shares its aggregate request-byte
        // boundary; comment/event counts impose no additional transport bound.
        items: z.array(AccountEncryptionMigrateReviewCommentItemSchema),
      })
      .strict(),
  ]));
export type AccountEncryptionMigrateReviewCommentsDirective = z.infer<
  typeof AccountEncryptionMigrateReviewCommentsDirectiveSchema
>;

const AccountEncryptionMigrateSessionOrganizationDisplayItemShape = {
  expectedDisplay: SessionOrganizationContentEnvelopeSchema,
  display: SessionOrganizationContentEnvelopeSchema,
} as const;

export const AccountEncryptionMigrateSessionOrganizationDirectiveSchema =
  lazyZodSchema(() => z.discriminatedUnion('action', [
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
  ]));
export type AccountEncryptionMigrateSessionOrganizationDirective = z.infer<
  typeof AccountEncryptionMigrateSessionOrganizationDirectiveSchema
>;

export const AccountEncryptionMigratePetsDirectiveSchema =
  lazyZodSchema(() => z.object({ action: z.literal('assert_empty') }).strict());
export type AccountEncryptionMigratePetsDirective = z.infer<
  typeof AccountEncryptionMigratePetsDirectiveSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES = 8_000_000;

/** One Account-owned new-session draft replacement in the atomic V4 migration. */
export const AccountEncryptionMigrateSessionDraftItemSchema = lazyZodSchema(() => z.object({
  address: z.object({
    kind: z.literal('newSession'),
    draftId: z.string().uuid(),
  }).strict(),
  expectedRevision: NonNegativeSafeIntegerSchema,
  content: SessionDraftStoredContentEnvelopeV1Schema,
}).strict());
export type AccountEncryptionMigrateSessionDraftItem = z.infer<
  typeof AccountEncryptionMigrateSessionDraftItemSchema
>;

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
    artifacts?: {
      action: string;
      items?: Array<{ blobs: Array<{ content: { t: string } }> }>;
    };
    promptLibrary?: AccountEncryptionMigratePromptLibraryDirectiveV1;
    remoteHosts?: AccountEncryptionMigrateRemoteHostsDirectiveV1;
    notificationChannels?: AccountEncryptionMigrateNotificationChannelsDirectiveV1;
    connectedPresentation?: AccountEncryptionMigrateConnectedPresentationDirectiveV1;
    connectedAcknowledgements?: AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1;
    providerConnections?: AccountEncryptionMigrateProviderConnectionsDirectiveV1;
    mcpServerCatalog?: AccountEncryptionMigrateMcpServerCatalogDirectiveV1;
    acpCatalog?: AccountEncryptionMigrateAcpCatalogDirectiveV1;
    connectedConfigurations?: AccountEncryptionMigrateConnectedConfigurationsDirectiveV1;
    connectedPurposes?: AccountEncryptionMigrateConnectedPurposesDirectiveV1;
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
  }>,
): void {
    if (
      request.toMode === 'e2ee'
      && (
        (options.requireE2eeKeyProof && !request.keyProof)
        || (
          request.keyProof
          && (
            !request.keyProof.contentPublicKey
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
    for (const key of ['remoteHosts', 'notificationChannels', 'connectedPresentation', 'connectedAcknowledgements'] as const) {
      const content = request[key]?.content;
      if (content && content.t !== targetEnvelopeKind) context.addIssue({ code: 'custom',
        path: [key, 'content'], message: 'Catalog replacement must match the target Account mode' });
    }
    if (request.providerConnections?.content && request.providerConnections.content.t !== targetEnvelopeKind) {
      context.addIssue({ code: 'custom', path: ['providerConnections', 'content'], message: 'Provider catalog replacement must match the target Account mode' });
    }
    if (request.mcpServerCatalog?.content && request.mcpServerCatalog.content.t !== targetEnvelopeKind) {
      context.addIssue({ code: 'custom', path: ['mcpServerCatalog', 'content'],
        message: 'MCP catalog replacement must match the target Account mode' });
    }
    if (request.acpCatalog?.content && request.acpCatalog.content.t !== targetEnvelopeKind) {
      context.addIssue({ code: 'custom', path: ['acpCatalog', 'content'],
        message: 'ACP catalog replacement must match the target Account mode' });
    }
    for (const key of ['connectedConfigurations', 'connectedPurposes'] as const) {
      const content = request[key]?.content;
      if (content && content.t !== targetEnvelopeKind) context.addIssue({ code: 'custom',
        path: [key, 'content'], message: 'Connected catalog replacement must match the target Account mode' });
    }
    request.promptLibrary?.items.forEach((item, index) => {
      if (item.content.t !== targetEnvelopeKind) context.addIssue({ code: 'custom',
        path: ['promptLibrary', 'items', index, 'content'], message: 'Prompt catalog replacement must match the target Account mode' });
    });
    if (request.artifacts?.action === 'migrate' && request.artifacts.items) {
      request.artifacts.items.forEach((item, index) => item.blobs.forEach((blob, blobIndex) => {
        if (blob.content.t !== targetEnvelopeKind) context.addIssue({ code: 'custom',
          path: ['artifacts', 'items', index, 'blobs', blobIndex, 'content'],
          message: 'Artifact blob replacement must match the target account encryption mode' });
      }));
    }
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

export const AccountEncryptionMigrateExternalAuthProofSchema = AccountExternalAuthProofV1Schema;
export type AccountEncryptionMigrateExternalAuthProof = z.infer<
  typeof AccountEncryptionMigrateExternalAuthProofSchema
>;

/**
 * V5 is an Account-owned migration transition. Collection rows only provide
 * exact source/target evidence; they never own transition authority or state.
 */
export const AccountEncryptionMigrateTransitionIdSchema = lazyZodSchema(() => z.string().uuid());
export type AccountEncryptionMigrateTransitionId = z.infer<
  typeof AccountEncryptionMigrateTransitionIdSchema
>;

export const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS =
  500;
export const ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_STAGE_BATCH_MAX_UTF8_BYTES =
  8 * 1024 * 1024;

const AccountEncryptionMigrateCollectionIdentityShape = {
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  rowId: PluginCollectionRowIdV1Schema,
} as const;

const AccountEncryptionMigrateCollectionSourceShape = {
  ...AccountEncryptionMigrateCollectionIdentityShape,
  // The Collection owner defines this ceiling from its persisted `Int`
  // currentness columns; the transition never carries a wider revision.
  revision: PluginCollectionRevisionV1Schema,
  sourceEnvelope: PluginCollectionContentEnvelopeV1Schema,
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
} as const;

/** The exact Collection row state from which a transition client derives a target. */
export const AccountEncryptionMigrateCollectionInventoryItemSchema = lazyZodSchema(() => z
  .object(AccountEncryptionMigrateCollectionSourceShape)
  .strict());
export type AccountEncryptionMigrateCollectionInventoryItem = z.infer<
  typeof AccountEncryptionMigrateCollectionInventoryItemSchema
>;

/** One staged Collection replacement, guarded by identity, revision, and contract. */
export const AccountEncryptionMigrateCollectionStageItemSchema = lazyZodSchema(() => z
  .object({
    ...AccountEncryptionMigrateCollectionIdentityShape,
    expectedRevision: PluginCollectionRevisionV1Schema,
    sourceEnvelope: PluginCollectionContentEnvelopeV1Schema,
    targetEnvelope: PluginCollectionContentEnvelopeV1Schema,
    schemaVersion: PluginCollectionSchemaVersionV1Schema,
    contractDigest: PluginCollectionContractDigestV1Schema,
  })
  .strict());
export type AccountEncryptionMigrateCollectionStageItem = z.infer<
  typeof AccountEncryptionMigrateCollectionStageItemSchema
>;

export const AccountEncryptionMigrateTransitionPrepareRequestSchema = lazyZodSchema(() => z
  .object({
    toMode: AccountEncryptionMigrateToModeSchema,
    expectedAccountVersion: NonNegativeSafeIntegerSchema,
    expectedSigningKeyFingerprint: z.string().min(1).max(256).nullable(),
    expectedContentKeyFingerprint: z.string().min(1).max(256).nullable(),
  })
  .strict());
export type AccountEncryptionMigrateTransitionPrepareRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionPrepareRequestSchema
>;

/** Server-created transition facts that authorization and every stage bind to. */
export const AccountEncryptionMigrateTransitionPrepareResponseSchema = lazyZodSchema(() => z
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
  }));
export type AccountEncryptionMigrateTransitionPrepareResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionPrepareResponseSchema
>;

const AccountEncryptionMigrateTransitionAuthorizationSchema = lazyZodSchema(() => z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('present_user_confirmation') }).strict(),
    z.object({
      kind: z.literal('first_key'),
      keyProof: AccountEncryptionMigrateKeyProofSchema,
      externalAuthProof: AccountEncryptionMigrateExternalAuthProofSchema,
    }).strict(),
  ],
));

/**
 * A prepared replacement password credential for an Account that has one
 * enrolled. Changing the Account's mode changes which credential kind is valid,
 * so the replacement is authorized and staged here and committed by the same
 * Account mode flip — the Account is never published in one mode beside a
 * credential of the other.
 *
 * `proof` carries the purpose-bound Key Challenge the E2EE credential's own
 * signing key produced (02.05 §5.3). It is required whenever the source
 * credential is an E2EE envelope, because replacing that material must present
 * the proof the Account's current state can supply rather than relying on the
 * bearer token that authorized the transition. A Plain source credential
 * instead proves the current password through the first-key external-auth
 * proof, which already binds this whole request.
 */
export const AccountEncryptionMigrateTransitionPasswordCredentialSchema = lazyZodSchema(() => z
  .object({
    expectedRevision: z.number().int().min(1).max(2_147_483_647),
    credential: AccountPasswordCredentialV1Schema,
    proof: PasswordMutationChallengeProofV1Schema.optional(),
  })
  .strict());
export type AccountEncryptionMigrateTransitionPasswordCredential = z.infer<
  typeof AccountEncryptionMigrateTransitionPasswordCredentialSchema
>;

/**
 * This phase is mandatory before Collection inventory or staging. The Account
 * coordinator persists the accepted confirmation or first-key authorization.
 */
export const AccountEncryptionMigrateTransitionAuthorizeRequestSchema = lazyZodSchema(() => z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    authorization: AccountEncryptionMigrateTransitionAuthorizationSchema,
    passwordCredential:
      AccountEncryptionMigrateTransitionPasswordCredentialSchema.optional(),
  })
  .strict());
export type AccountEncryptionMigrateTransitionAuthorizeRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizeRequestSchema
>;

/** One fixed-size inventory page from the Account-owned transition census. */
export const AccountEncryptionMigrateCollectionInventoryPageRequestSchema = lazyZodSchema(() => z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict());
export type AccountEncryptionMigrateCollectionInventoryPageRequest = z.infer<
  typeof AccountEncryptionMigrateCollectionInventoryPageRequestSchema
>;

export const AccountEncryptionMigrateCollectionInventoryPageSchema = lazyZodSchema(() => z
  .object({
    items: z
      .array(AccountEncryptionMigrateCollectionInventoryItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
    nextCursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict());
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
export const AccountEncryptionMigrateCollectionStageBatchRequestSchema = lazyZodSchema(() => z
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
  }));
export type AccountEncryptionMigrateCollectionStageBatchRequest = z.infer<
  typeof AccountEncryptionMigrateCollectionStageBatchRequestSchema
>;

export const AccountEncryptionMigrateTransitionCancelRequestSchema = lazyZodSchema(() => z
  .object({ transitionId: AccountEncryptionMigrateTransitionIdSchema })
  .strict());
export type AccountEncryptionMigrateTransitionCancelRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionCancelRequestSchema
>;

/** The only V5 Collection finalization directive; no direct payload bypass exists. */
export const AccountEncryptionMigrateCollectionDirectiveSchema = lazyZodSchema(() => z
  .object({
    action: z.literal('staged'),
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
  })
  .strict());
export type AccountEncryptionMigrateCollectionDirective = z.infer<
  typeof AccountEncryptionMigrateCollectionDirectiveSchema
>;

/**
 * V5's closed Automation participant mirrors the Collection transition shape:
 * source facts are explicit, a target is only accepted against those facts,
 * and the Account transition remains the only lifecycle/activation owner.
 */
const AccountEncryptionMigrateAutomationDefinitionContentSchema = lazyZodSchema(() => z
  .object({
    templateCiphertext:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.templateCiphertext,
    triggerDefinitionEnvelopes: AutomationTriggerDefinitionEnvelopesMigrationSchema,
  })
  .strict());

const AccountEncryptionMigrateAutomationRunSourceContentSchema = lazyZodSchema(() => z
  .object({
    triggerEvidenceEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerEvidenceEnvelope.nullable(),
    occurrenceEvidenceEqualityTag:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.occurrenceEvidenceEqualityTag.nullable(),
    executionInputEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.executionInputEnvelope.nullable(),
    workflowAcceptedSnapshotEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    workflowCheckpointEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    resultEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    replyContextEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyContextEnvelope.nullable(),
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
    summaryCiphertext:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.summaryCiphertext.nullable(),
  })
  .strict());

const AccountEncryptionMigrateAutomationRunTargetContentSchema = lazyZodSchema(() => z
  .object({
    triggerEvidenceEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.triggerEvidenceEnvelope.nullable(),
    occurrenceEvidenceEqualityTag:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.occurrenceEvidenceEqualityTag.nullable(),
    executionInputEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.executionInputEnvelope.nullable(),
    workflowAcceptedSnapshotEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    workflowCheckpointEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    resultEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope.nullable(),
    replyContextEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.replyContextEnvelope.nullable(),
    failureDetailEnvelope:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.failureDetailEnvelope.nullable(),
    summaryCiphertext:
      ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.summaryCiphertext.nullable(),
  })
  .strict());

const AccountEncryptionMigrateWorkflowInvocationContentSchema = lazyZodSchema(() => z.object({
  contentEnvelope: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATION_CONTENT_FIELDS.resultEnvelope,
}).strict());

const AccountEncryptionMigrateRunShape = {
  kind: z.literal('run'),
  runId: WorkflowRunIdV1Schema,
  source: AccountEncryptionMigrateAutomationRunSourceContentSchema,
} as const;

const AccountEncryptionMigrateAutomationOriginShape = {
  origin: WorkflowRunAutomationOriginV1Schema,
  cause: AutomationRunCauseSchema,
} as const;

const AccountEncryptionMigrateDirectOriginShape = {
  origin: WorkflowRunDirectOriginV1Schema,
} as const;

export const AccountEncryptionMigrateAutomationInventoryItemSchema =
  lazyZodSchema(() => z.union([
    z.object({
      kind: z.literal('definition'),
      automationId: asProtocolZod(AutomationIdV1Schema),
      revision: NonNegativeSafeIntegerSchema,
      source: AccountEncryptionMigrateAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
      ...AccountEncryptionMigrateRunShape,
      ...AccountEncryptionMigrateAutomationOriginShape,
      revision: NonNegativeSafeIntegerSchema,
    }).strict(),
    z.object({
      ...AccountEncryptionMigrateRunShape,
      ...AccountEncryptionMigrateDirectOriginShape,
      revision: NonNegativeSafeIntegerSchema,
    }).strict(),
    z.object({
      kind: z.literal('workflow_invocation'),
      runId: WorkflowRunIdV1Schema,
      invocationRecordId: WorkflowInvocationRecordIdSchema,
      source: AccountEncryptionMigrateWorkflowInvocationContentSchema,
    }).strict(),
  ]));
export type AccountEncryptionMigrateAutomationInventoryItem = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryItemSchema
>;

export const AccountEncryptionMigrateAutomationStageItemSchema =
  lazyZodSchema(() => z.union([
    z.object({
      kind: z.literal('definition'),
      automationId: asProtocolZod(AutomationIdV1Schema),
      expectedRevision: NonNegativeSafeIntegerSchema,
      source: AccountEncryptionMigrateAutomationDefinitionContentSchema,
      target: AccountEncryptionMigrateAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
      ...AccountEncryptionMigrateRunShape,
      ...AccountEncryptionMigrateAutomationOriginShape,
      expectedRevision: NonNegativeSafeIntegerSchema,
      target: AccountEncryptionMigrateAutomationRunTargetContentSchema,
    }).strict(),
    z.object({
      ...AccountEncryptionMigrateRunShape,
      ...AccountEncryptionMigrateDirectOriginShape,
      expectedRevision: NonNegativeSafeIntegerSchema,
      target: AccountEncryptionMigrateAutomationRunTargetContentSchema,
    }).strict(),
    z.object({
      kind: z.literal('workflow_invocation'),
      runId: WorkflowRunIdV1Schema,
      invocationRecordId: WorkflowInvocationRecordIdSchema,
      source: AccountEncryptionMigrateWorkflowInvocationContentSchema,
      target: AccountEncryptionMigrateWorkflowInvocationContentSchema,
    }).strict(),
  ]));
export type AccountEncryptionMigrateAutomationStageItem = z.infer<
  typeof AccountEncryptionMigrateAutomationStageItemSchema
>;

export const AccountEncryptionMigrateAutomationInventoryPageRequestSchema = lazyZodSchema(() => z
  .object({
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
    cursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict());
export type AccountEncryptionMigrateAutomationInventoryPageRequest = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryPageRequestSchema
>;

export const AccountEncryptionMigrateAutomationInventoryPageSchema = lazyZodSchema(() => z
  .object({
    items: z
      .array(AccountEncryptionMigrateAutomationInventoryItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
    nextCursor: asProtocolZod(PluginCollectionOpaqueCursorV1Schema).optional(),
  })
  .strict());
export type AccountEncryptionMigrateAutomationInventoryPage = z.infer<
  typeof AccountEncryptionMigrateAutomationInventoryPageSchema
>;

function automationStageItemIdentity(
  item: AccountEncryptionMigrateAutomationStageItem,
): string {
  return item.kind === 'definition'
    ? `definition\u0000${item.automationId}`
    : item.kind === 'run'
      ? `run\u0000${item.runId}`
      : `workflow_invocation\u0000${item.runId}\u0000${item.invocationRecordId}`;
}

export const AccountEncryptionMigrateAutomationStageBatchRequestSchema = lazyZodSchema(() => z
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
  }));
export type AccountEncryptionMigrateAutomationStageBatchRequest = z.infer<
  typeof AccountEncryptionMigrateAutomationStageBatchRequestSchema
>;

/** The only V5 Automation finalization directive; no direct payload bypass exists. */
export const AccountEncryptionMigrateAutomationDirectiveSchema = lazyZodSchema(() => z
  .object({
    action: z.literal('staged'),
    transitionId: AccountEncryptionMigrateTransitionIdSchema,
  })
  .strict());
export type AccountEncryptionMigrateAutomationDirective = z.infer<
  typeof AccountEncryptionMigrateAutomationDirectiveSchema
>;

/** Current V5 activation is a transition reference, not a second authorization. */
export const AccountEncryptionMigrateTransitionActivateRequestSchema = lazyZodSchema(() => z
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
  }));
export type AccountEncryptionMigrateTransitionActivateRequest = z.infer<
  typeof AccountEncryptionMigrateTransitionActivateRequestSchema
>;

/** Authorization and cancellation acknowledge only the Account-owned transition. */
export const AccountEncryptionMigrateTransitionAuthorizeResponseSchema = lazyZodSchema(() => z
  .object({ success: z.literal(true) })
  .strict());
export type AccountEncryptionMigrateTransitionAuthorizeResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizeResponseSchema
>;

export const AccountEncryptionMigrateTransitionCancelResponseSchema = lazyZodSchema(() => z
  .object({ success: z.literal(true) })
  .strict());
export type AccountEncryptionMigrateTransitionCancelResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionCancelResponseSchema
>;

/**
 * Aggregate stage counters describe Account-owned accepted state; the V5
 * 500-row and 8 MiB limits bound one transport batch, never the aggregate.
 */
export const AccountEncryptionMigrateCollectionStageBatchResponseSchema = lazyZodSchema(() => z
  .object({
    success: z.literal(true),
    stagedParticipantCount: NonNegativeSafeIntegerSchema,
    stagedSourceBytes: NonNegativeSafeIntegerSchema,
    stagedTargetBytes: NonNegativeSafeIntegerSchema,
  })
  .strict());
export type AccountEncryptionMigrateCollectionStageBatchResponse = z.infer<
  typeof AccountEncryptionMigrateCollectionStageBatchResponseSchema
>;

export const AccountEncryptionMigrateAutomationStageBatchResponseSchema = lazyZodSchema(() => z
  .object({
    success: z.literal(true),
    stagedParticipantCount: NonNegativeSafeIntegerSchema,
    stagedSourceBytes: NonNegativeSafeIntegerSchema,
    stagedTargetBytes: NonNegativeSafeIntegerSchema,
  })
  .strict());
export type AccountEncryptionMigrateAutomationStageBatchResponse = z.infer<
  typeof AccountEncryptionMigrateAutomationStageBatchResponseSchema
>;

/** Activation exposes only the canonical post-commit Account facts. */
export const AccountEncryptionMigrateTransitionActivateResponseSchema = lazyZodSchema(() => z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    accountVersion: NonNegativeSafeIntegerSchema,
    updatedAt: NonNegativeSafeIntegerSchema,
  })
  .strict());
export type AccountEncryptionMigrateTransitionActivateResponse = z.infer<
  typeof AccountEncryptionMigrateTransitionActivateResponseSchema
>;

export const AccountEncryptionMigrateSessionDraftsDirectiveSchema = lazyZodSchema(() => z.union([
  z.object({
    items: z.array(AccountEncryptionMigrateSessionDraftItemSchema)
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
  }).strict(),
  z.object({
    v: z.literal(2),
    items: z.array(AccountEncryptionMigrateSessionDraftItemSchema.extend({
      address: AccountOwnedDraftAddressV2Schema,
      content: SessionDraftStoredContentEnvelopeV2Schema,
    }))
      .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
  }).strict(),
]).superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    const key = canonicalSessionDraftAddressV2(item.address);
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items', index, 'address', 'draftId'],
        message: 'Account migration cannot replace the same Account-owned draft twice',
      });
    }
    seen.add(key);
  });
}));
export type AccountEncryptionMigrateSessionDraftsDirective = z.infer<
  typeof AccountEncryptionMigrateSessionDraftsDirectiveSchema
>;

/** Account-owned remembered rows travel through the existing atomic switch. */
export const AccountEncryptionMigrateAuthoringMemoryDirectiveSchema = lazyZodSchema(() => z.object({
  items: z.array(z.object({
    key: AuthoringMemoryKeyV1Schema,
    expectedRevision: NonNegativeSafeIntegerSchema,
    content: AuthoringMemoryContentV1Schema,
  }).strict()),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.key)) context.addIssue({
      code: z.ZodIssueCode.custom, path: ['items', index, 'key'],
      message: 'Account migration cannot replace the same authoring memory row twice',
    });
    seen.add(item.key);
    if (item.content.t === 'plain') {
      try { assertAuthoringMemoryValueForKeyV1(item.key, item.content.v); }
      catch { context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'content'], message: 'Invalid authoring memory value for row key' }); }
    }
  });
}));
export type AccountEncryptionMigrateAuthoringMemoryDirective = z.infer<typeof AccountEncryptionMigrateAuthoringMemoryDirectiveSchema>;

export const AccountEncryptionMigrateWorkspaceExecutionConfigDirectiveSchema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ rowId: WorkspaceExecutionConfigRowIdV1Schema, expectedRevision: NonNegativeSafeIntegerSchema, content: WorkspaceExecutionConfigContentV1Schema }).strict()),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.rowId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'rowId'], message: 'Workspace config migration row ids must be unique' });
    seen.add(item.rowId);
  });
}));
export type AccountEncryptionMigrateWorkspaceExecutionConfigDirective = z.infer<typeof AccountEncryptionMigrateWorkspaceExecutionConfigDirectiveSchema>;

/** Complete replacements for the explicitly registered private Project row grammar. */
export const AccountEncryptionMigrateProjectRowsDirectiveSchema = lazyZodSchema(() => z.object({
  items: z.array(z.object({
    key: ProjectAccountRowKeyV1Schema,
    expectedRevision: NonNegativeSafeIntegerSchema,
    content: ProjectAccountRowContentV1Schema,
  }).strict()),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    const identity = buildProjectAccountRowPhysicalKeyV1(item.key);
    if (seen.has(identity)) context.addIssue({
      code: z.ZodIssueCode.custom, path: ['items', index, 'key'],
      message: 'Account migration cannot replace the same Project row twice',
    });
    seen.add(identity);
  });
}));
export type AccountEncryptionMigrateProjectRowsDirective = z.infer<typeof AccountEncryptionMigrateProjectRowsDirectiveSchema>;

export const AccountEncryptionMigrateProjectTrustDirectiveSchema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ project: QualifiedProjectTrustProjectV1Schema, expectedRevision: NonNegativeSafeIntegerSchema,
    content: ProjectTrustContentV1Schema,
  }).strict()),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    const identity = JSON.stringify([item.project.serverId, item.project.projectId]);
    if (seen.has(identity)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'project'], message: 'Account migration cannot replace the same Project Trust row twice' });
    seen.add(identity);
  });
}));
export type AccountEncryptionMigrateProjectTrustDirective = z.infer<typeof AccountEncryptionMigrateProjectTrustDirectiveSchema>;

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
  workspace: AccountEncryptionMigrateWorkspaceDirectiveSchema.optional(),
  artifacts: AccountEncryptionMigrateArtifactsDirectiveSchema,
  sessions: AccountEncryptionMigrateSessionsDirectiveSchema,
  reviewComments: AccountEncryptionMigrateReviewCommentsDirectiveSchema,
  sessionOrganization:
    AccountEncryptionMigrateSessionOrganizationDirectiveSchema,
  pets: AccountEncryptionMigratePetsDirectiveSchema,
  sessionDrafts: AccountEncryptionMigrateSessionDraftsDirectiveSchema.optional(),
  authoringMemory: AccountEncryptionMigrateAuthoringMemoryDirectiveSchema.optional(),
  promptLibrary: AccountEncryptionMigratePromptLibraryDirectiveV1Schema.optional(),
  remoteHosts: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateRemoteHostsDirectiveV1Schema))),
  notificationChannels: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateNotificationChannelsDirectiveV1Schema))),
  connectedPresentation: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateConnectedPresentationDirectiveV1Schema))),
  connectedAcknowledgements: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1Schema))),
  providerConnections: AccountEncryptionMigrateProviderConnectionsDirectiveV1Schema.optional(),
  mcpServerCatalog: AccountEncryptionMigrateMcpServerCatalogDirectiveV1Schema.optional(),
  acpCatalog: AccountEncryptionMigrateAcpCatalogDirectiveV1Schema.optional(),
  connectedConfigurations: AccountEncryptionMigrateConnectedConfigurationsDirectiveV1Schema.optional(),
  connectedPurposes: AccountEncryptionMigrateConnectedPurposesDirectiveV1Schema.optional(),
  profileRows: AccountEncryptionMigrateProfileRowsDirectiveSchema.optional(),
  workspaceExecutionConfig: AccountEncryptionMigrateWorkspaceExecutionConfigDirectiveSchema.optional(),
  projectRows: AccountEncryptionMigrateProjectRowsDirectiveSchema.optional(),
  projectTrust: AccountEncryptionMigrateProjectTrustDirectiveSchema.optional(),
  externalAuthProof:
    AccountEncryptionMigrateExternalAuthProofSchema.optional(),
  passwordCredential:
    AccountEncryptionMigrateTransitionPasswordCredentialSchema.optional(),
} as const;

export const AccountEncryptionMigrateUnsignedRequestSchema = lazyZodSchema(() => z
  .object({
    ...AccountEncryptionMigrateCurrentRequestShape,
    keyProof: AccountEncryptionMigrateUnsignedKeyProofSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    refineAccountEncryptionMigrateRequest(request, context, {
      requireE2eeKeyProof: true,
    });
  }));
export type AccountEncryptionMigrateUnsignedRequest = z.infer<
  typeof AccountEncryptionMigrateUnsignedRequestSchema
>;

export const AccountEncryptionMigrateRequestSchema = lazyZodSchema(() => z
  .object({
    ...AccountEncryptionMigrateCurrentRequestShape,
    keyProof: AccountEncryptionMigrateKeyProofSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    refineAccountEncryptionMigrateRequest(request, context, {
      requireE2eeKeyProof: false,
    });
  }));
export type AccountEncryptionMigrateRequest = z.infer<
  typeof AccountEncryptionMigrateRequestSchema
>;

const ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_BINDING_DIGEST_V1_PREFIX =
  'aemrb1_';
const ACCOUNT_ENCRYPTION_MIGRATE_PROOF_SIGNING_DOMAIN_V1 =
  'happier.account-encryption-migrate-proof.v1';

export const AccountEncryptionMigrateRequestBindingDigestV1Schema = lazyZodSchema(() => z
  .string()
  .regex(/^aemrb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/));
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
        ...(signedRequest.data.keyProof
          ? {
              keyProof: {
                v: signedRequest.data.keyProof.v,
                publicKey: signedRequest.data.keyProof.publicKey,
                contentPublicKey:
                  signedRequest.data.keyProof.contentPublicKey,
                contentPublicKeySig:
                  signedRequest.data.keyProof.contentPublicKeySig,
              },
            }
          : {}),
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

export const AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema = lazyZodSchema(() => z
  .string()
  .regex(/^aemtb1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/));
export type AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1 = z.infer<
  typeof AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema
>;

/**
 * First-key step-up providers persist an opaque authorization binding, not a
 * route shape. V5 adds the transition-bound digest alongside the established
 * one-request digest; accepting any other prefix would detach a proof from
 * its Account transition facts.
 */
export const AccountEncryptionMigrateExternalAuthBindingDigestV1Schema = lazyZodSchema(() => z.union([
  AccountEncryptionMigrateRequestBindingDigestV1Schema,
  AccountEncryptionMigrateTransitionAuthorizationBindingDigestV1Schema,
]));
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
    // The staged replacement credential is part of what the first-key signature
    // and the external-auth proof authorize. Leaving it out would let a
    // substituted password credential ride an otherwise valid authorization.
    passwordCredential: request.passwordCredential
      ? {
          expectedRevision: request.passwordCredential.expectedRevision,
          credential: request.passwordCredential.credential,
        }
      : null,
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

export const AccountEncryptionMigrateSuccessResponseSchema = lazyZodSchema(() => z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    accountVersion: NonNegativeSafeIntegerSchema,
    settingsVersion: NonNegativeSafeIntegerSchema,
    authoringMemory: z.object({ rows: z.array(AuthoringMemoryRowV1Schema) }).strict().optional(),
    promptLibrary: AccountEncryptionMigratePromptLibraryResultV1Schema.optional(),
    remoteHosts: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateRemoteHostsResultV1Schema))),
    notificationChannels: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateNotificationChannelsResultV1Schema))),
    connectedPresentation: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateConnectedPresentationResultV1Schema))),
    connectedAcknowledgements: z.optional(asProtocolZod(accountEncryptionCatalogProtocolSchema(AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema))),
    providerConnections: AccountEncryptionMigrateProviderConnectionsResultV1Schema.optional(),
    mcpServerCatalog: AccountEncryptionMigrateMcpServerCatalogResultV1Schema.optional(),
    acpCatalog: AccountEncryptionMigrateAcpCatalogResultV1Schema.optional(),
    connectedConfigurations: AccountEncryptionMigrateConnectedConfigurationsResultV1Schema.optional(),
    connectedPurposes: AccountEncryptionMigrateConnectedPurposesResultV1Schema.optional(),
    profileRows: AccountEncryptionMigrateProfileRowsResultSchema.optional(),
    workspaceExecutionConfig: z.object({ rows: z.array(WorkspaceExecutionConfigRowV1Schema) }).strict().optional(),
    projectRows: z.object({ rows: z.array(ProjectAccountRowV1Schema) }).strict().optional(),
    projectTrust: z.object({ rows: z.array(ProjectTrustRowV1Schema) }).strict().optional(),
    sessionDrafts: z.union([
      z.object({
        records: z.array(SessionDraftRecordV1Schema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
      }).strict(),
      z.object({
        v: z.literal(2),
        records: z.array(SessionDraftRecordV2Schema)
          .max(ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS),
      }).strict(),
    ]).optional(),
  })
  .strict());
export type AccountEncryptionMigrateSuccessResponse = z.infer<
  typeof AccountEncryptionMigrateSuccessResponseSchema
>;

export const AccountEncryptionMigrateInvalidParamsReasonSchema = lazyZodSchema(() => z.enum([
  'restore_required',
  'key_proof_required',
  'migration_inventory_changed',
]));
export type AccountEncryptionMigrateInvalidParamsReason = z.infer<
  typeof AccountEncryptionMigrateInvalidParamsReasonSchema
>;

export const AccountEncryptionMigrateBadRequestResponseSchema =
  lazyZodSchema(() => z.discriminatedUnion('error', [
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
  ]));
export type AccountEncryptionMigrateBadRequestResponse = z.infer<
  typeof AccountEncryptionMigrateBadRequestResponseSchema
>;

export const AccountEncryptionMigrateForbiddenResponseSchema = lazyZodSchema(() => z
  .object({ error: z.enum(['e2ee-required', 'plaintext-only']) })
  .strict());
export type AccountEncryptionMigrateForbiddenResponse = z.infer<
  typeof AccountEncryptionMigrateForbiddenResponseSchema
>;

export const AccountEncryptionMigrateNotFoundResponseSchema = lazyZodSchema(() => z
  .object({ error: z.literal('not_found') })
  .strict());
export type AccountEncryptionMigrateNotFoundResponse = z.infer<
  typeof AccountEncryptionMigrateNotFoundResponseSchema
>;

export const AccountEncryptionMigrateConflictResponseSchema = lazyZodSchema(() => z
  .object({
    error: z.literal('version-mismatch'),
    currentVersion: NonNegativeSafeIntegerSchema,
  })
  .strict());
export type AccountEncryptionMigrateConflictResponse = z.infer<
  typeof AccountEncryptionMigrateConflictResponseSchema
>;

export const AccountEncryptionMigrateInternalResponseSchema = lazyZodSchema(() => z
  .object({ error: z.literal('internal') })
  .strict());
export type AccountEncryptionMigrateInternalResponse = z.infer<
  typeof AccountEncryptionMigrateInternalResponseSchema
>;

export const AccountEncryptionMigrateAnyErrorResponseSchema = lazyZodSchema(() => z.union([
  ArtifactQuotaExceededV1Schema,
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateForbiddenResponseSchema,
  AccountEncryptionMigrateNotFoundResponseSchema,
  AccountEncryptionMigrateConflictResponseSchema,
  AccountEncryptionMigrateInternalResponseSchema,
]));
export type AccountEncryptionMigrateAnyErrorResponse = z.infer<
  typeof AccountEncryptionMigrateAnyErrorResponseSchema
>;
