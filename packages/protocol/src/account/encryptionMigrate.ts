import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import {
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
  SealedConnectedServiceCredentialV1Schema,
} from '../connect/connectedServiceSchemas.js';
import { AccountSettingsStoredContentEnvelopeSchema } from './settings/index.js';

export const AccountEncryptionMigrateToModeSchema = AccountEncryptionModeSchema;
export type AccountEncryptionMigrateToMode = z.infer<typeof AccountEncryptionMigrateToModeSchema>;

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
        message: 'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
  });
export type AccountEncryptionMigrateKeyProof = z.infer<typeof AccountEncryptionMigrateKeyProofSchema>;

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
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'record is required for plain migrations' });
      }
      if (value.sealed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sealed must not be provided for plain migrations' });
      }
    } else {
      if (!value.sealed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sealed is required for sealed migrations' });
      }
      if (value.record) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'record must not be provided for sealed migrations' });
      }
    }
  });

export const AccountEncryptionMigrateConnectedServicesDirectiveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert_empty') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('migrate'),
      credentials: z.array(ConnectedServiceCredentialMigrationItemSchema).max(500),
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

export const AccountEncryptionMigrateAutomationsDirectiveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert_empty') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({
      action: z.literal('migrate'),
      templates: z.array(AutomationsMigrationItemSchema).max(500),
    })
    .strict(),
]);
export type AccountEncryptionMigrateAutomationsDirective = z.infer<typeof AccountEncryptionMigrateAutomationsDirectiveSchema>;

export const AccountEncryptionMigrateRequestSchema = z
  .object({
    toMode: AccountEncryptionMigrateToModeSchema,
    expectedSettingsVersion: z.number().int().min(0),
    settingsContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    connectedServices: AccountEncryptionMigrateConnectedServicesDirectiveSchema,
    automations: AccountEncryptionMigrateAutomationsDirectiveSchema,
    keyProof: AccountEncryptionMigrateKeyProofSchema.optional(),
  })
  .strict();
export type AccountEncryptionMigrateRequest = z.infer<typeof AccountEncryptionMigrateRequestSchema>;

export const AccountEncryptionMigrateSuccessResponseSchema = z
  .object({
    success: z.literal(true),
    mode: AccountEncryptionMigrateToModeSchema,
    settingsVersion: z.number().int().min(0),
  })
  .strict();
export type AccountEncryptionMigrateSuccessResponse = z.infer<typeof AccountEncryptionMigrateSuccessResponseSchema>;

export const AccountEncryptionMigrateInvalidParamsReasonSchema = z.enum(['restore_required', 'key_proof_required']);
export type AccountEncryptionMigrateInvalidParamsReason = z.infer<typeof AccountEncryptionMigrateInvalidParamsReasonSchema>;

export const AccountEncryptionMigrateBadRequestResponseSchema = z.discriminatedUnion('error', [
  z
    .object({
      error: z.literal('invalid-params'),
      reason: AccountEncryptionMigrateInvalidParamsReasonSchema.optional(),
    })
    .strict(),
  z.object({ error: z.literal('connected_services_not_empty') }).strict(),
  z.object({ error: z.literal('automations_not_empty') }).strict(),
]);
export type AccountEncryptionMigrateBadRequestResponse = z.infer<typeof AccountEncryptionMigrateBadRequestResponseSchema>;

export const AccountEncryptionMigrateForbiddenResponseSchema = z
  .object({ error: z.enum(['e2ee-required', 'plaintext-only']) })
  .strict();
export type AccountEncryptionMigrateForbiddenResponse = z.infer<typeof AccountEncryptionMigrateForbiddenResponseSchema>;

export const AccountEncryptionMigrateNotFoundResponseSchema = z.object({ error: z.literal('not_found') }).strict();
export type AccountEncryptionMigrateNotFoundResponse = z.infer<typeof AccountEncryptionMigrateNotFoundResponseSchema>;

export const AccountEncryptionMigrateConflictResponseSchema = z
  .object({ error: z.literal('version-mismatch'), currentVersion: z.number().int().min(0) })
  .strict();
export type AccountEncryptionMigrateConflictResponse = z.infer<typeof AccountEncryptionMigrateConflictResponseSchema>;

export const AccountEncryptionMigrateInternalResponseSchema = z.object({ error: z.literal('internal') }).strict();
export type AccountEncryptionMigrateInternalResponse = z.infer<typeof AccountEncryptionMigrateInternalResponseSchema>;

export const AccountEncryptionMigrateAnyErrorResponseSchema = z.union([
  AccountEncryptionMigrateBadRequestResponseSchema,
  AccountEncryptionMigrateForbiddenResponseSchema,
  AccountEncryptionMigrateNotFoundResponseSchema,
  AccountEncryptionMigrateConflictResponseSchema,
  AccountEncryptionMigrateInternalResponseSchema,
]);
export type AccountEncryptionMigrateAnyErrorResponse = z.infer<typeof AccountEncryptionMigrateAnyErrorResponseSchema>;
