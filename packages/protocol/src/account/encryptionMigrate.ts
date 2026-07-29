import { z } from 'zod';

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
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { AccountSettingsStoredContentEnvelopeSchema } from './settings/index.js';

const NonNegativeSafeIntegerSchema =
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AccountEncryptionMigrateToModeSchema = AccountEncryptionModeSchema;
export type AccountEncryptionMigrateToMode = z.infer<
  typeof AccountEncryptionMigrateToModeSchema
>;

export const AccountEncryptionMigrateKeyProofSchema = z
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

const ConnectedServiceCredentialMigrationItemSchema = z
  .object({
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    kind: z.enum(['plain', 'sealed']),
    record: ConnectedServiceCredentialRecordV1Schema.optional(),
    sealed: SealedConnectedServiceCredentialV1Schema.optional(),
    metadata: ConnectedServiceCredentialMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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
  });

const QualifiedConnectedAccountCredentialMigrationItemSchema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision:
    z.string().trim().min(1).max(128).nullable(),
  authenticationModeId: PluginContributionLocalIdSchema,
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
            .max(500)
            .default([]),
        qualifiedCredentials:
          z.array(QualifiedConnectedAccountCredentialMigrationItemSchema)
            .max(500)
            .default([]),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateConnectedServicesDirective = z.infer<
  typeof AccountEncryptionMigrateConnectedServicesDirectiveSchema
>;

const AutomationsMigrationItemSchema = z
  .object({
    automationId: z.string().min(1),
    templateCiphertext: z.string().min(1),
  })
  .strict();

export const AccountEncryptionMigrateAutomationsDirectiveSchema =
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('assert_empty') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z
      .object({
        action: z.literal('migrate'),
        templates: z.array(AutomationsMigrationItemSchema).max(500),
      })
      .strict(),
  ]);
export type AccountEncryptionMigrateAutomationsDirective = z.infer<
  typeof AccountEncryptionMigrateAutomationsDirectiveSchema
>;

export const AccountEncryptionMigrateRequestSchema = z
  .object({
    toMode: AccountEncryptionMigrateToModeSchema,
    expectedSettingsVersion: NonNegativeSafeIntegerSchema,
    settingsContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    connectedServices:
      AccountEncryptionMigrateConnectedServicesDirectiveSchema,
    automations: AccountEncryptionMigrateAutomationsDirectiveSchema,
    keyProof: AccountEncryptionMigrateKeyProofSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.toMode === 'e2ee'
      && (
        !request.keyProof?.contentPublicKey
        || !request.keyProof.contentPublicKeySig
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['keyProof', 'contentPublicKey'],
        message:
          'e2ee migrations require a complete signed content-key binding',
      });
    }
    if (request.connectedServices.action !== 'migrate') return;
    const expectedEnvelopeKind =
      request.toMode === 'plain' ? 'plain' : 'encrypted';
    request.connectedServices.qualifiedCredentials.forEach((item, index) => {
      if (
        item.replacementCredentialContentEnvelope.t !== expectedEnvelopeKind
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
          !== expectedEnvelopeKind
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
  });
export type AccountEncryptionMigrateRequest = z.infer<
  typeof AccountEncryptionMigrateRequestSchema
>;

export const AccountEncryptionMigrateSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    settingsVersion: NonNegativeSafeIntegerSchema,
  })
  .strict();
export type AccountEncryptionMigrateSuccessResponse = z.infer<
  typeof AccountEncryptionMigrateSuccessResponseSchema
>;

export const AccountEncryptionMigrateInvalidParamsReasonSchema = z.enum([
  'restore_required',
  'key_proof_required',
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
