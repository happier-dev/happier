import { z } from 'zod';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceProfileIdSchema,
  ConnectedServiceQuotaRecoveryCreditsV1Schema,
} from '../../../connect/connectedServiceSchemas.js';
import { ConnectedAccountServiceKeyIngressSchema } from '../../../connect/connectedServiceBindings.js';

export const SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID = 'runtime.usageLimitRecovery' as const;
export const SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY = 'sessionUsageLimitRecoveryV1' as const;

const SessionUsageLimitRecoveryNativeAuthSelectionV1Schema = z
  .object({
    kind: z.literal('native'),
    serviceId: ConnectedAccountServiceKeyIngressSchema.nullable().optional(),
  })
  .strict();

const SessionUsageLimitRecoveryProfileAuthSelectionV1Schema = z
  .object({
    kind: z.literal('profile'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    profileId: ConnectedServiceProfileIdSchema,
  })
  .strict();

const SessionUsageLimitRecoveryGroupAuthSelectionV1Schema = z
  .object({
    kind: z.literal('group'),
    serviceId: ConnectedAccountServiceKeyIngressSchema,
    groupId: ConnectedServiceAuthGroupIdSchema,
    profileId: ConnectedServiceProfileIdSchema.nullable(),
  })
  .strict();

export const SessionUsageLimitRecoveryAuthSelectionV1Schema = z.discriminatedUnion('kind', [
  SessionUsageLimitRecoveryNativeAuthSelectionV1Schema,
  SessionUsageLimitRecoveryProfileAuthSelectionV1Schema,
  SessionUsageLimitRecoveryGroupAuthSelectionV1Schema,
]);
export type SessionUsageLimitRecoveryAuthSelectionV1 = z.infer<
  typeof SessionUsageLimitRecoveryAuthSelectionV1Schema
>;

export const SessionUsageLimitRecoveryStatusV1Schema = z.enum([
  'armed',
  'waiting',
  'checking',
  'paused',
  'exhausted',
  'cancelled',
]);
export type SessionUsageLimitRecoveryStatusV1 = z.infer<typeof SessionUsageLimitRecoveryStatusV1Schema>;

export const SessionUsageLimitRecoveryResumePromptModeV1Schema = z.enum(['standard', 'off', 'custom']);
export type SessionUsageLimitRecoveryResumePromptModeV1 =
  z.infer<typeof SessionUsageLimitRecoveryResumePromptModeV1Schema>;

export const SessionUsageLimitRecoveryV1Schema = z
  .object({
    v: z.literal(1),
    status: SessionUsageLimitRecoveryStatusV1Schema,
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.default('standard'),
    issueFingerprint: z.string().trim().min(1),
    armedAtMs: z.number().int().nonnegative(),
    runtimeAuthRecoveryAttemptId: z.string().trim().min(1).optional(),
    resetAtMs: z.number().int().nonnegative().nullable(),
    nextCheckAtMs: z.number().int().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    lastProbeError: z.string().trim().min(1).nullable(),
    selectedAuth: SessionUsageLimitRecoveryAuthSelectionV1Schema,
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1Schema.optional(),
  })
  .strict();
export type SessionUsageLimitRecoveryV1 = z.infer<typeof SessionUsageLimitRecoveryV1Schema>;

export const SessionStateUsageLimitRecoveryValueSchema = SessionUsageLimitRecoveryV1Schema;
