import { z } from 'zod';

import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceIdSchema,
  ConnectedServiceProfileIdSchema,
} from '../../connect/connectedServiceSchemas.js';
import { ConnectedServiceLimitCategoryV1Schema } from '../../connect/connectedServiceLimitCategory.js';

export const TurnTerminalStatusV1Schema = z.enum(['completed', 'cancelled', 'failed']);
export type TurnTerminalStatusV1 = z.infer<typeof TurnTerminalStatusV1Schema>;

export const PrimaryTurnStatusV1Schema = z.union([
  z.literal('in_progress'),
  TurnTerminalStatusV1Schema,
]);
export type PrimaryTurnStatusV1 = z.infer<typeof PrimaryTurnStatusV1Schema>;

export const SessionRuntimeIssueSourceV1Schema = z.enum([
  'provider_status_error',
  'provider_process_exit',
  'provider_process_exit_after_switch',
  'provider_session_error',
  'usage_limit',
  'auth_error',
  'dependency_failure',
  'stream_error',
  'permission_blocked',
  'unknown',
]);
export type SessionRuntimeIssueSourceV1 = z.infer<typeof SessionRuntimeIssueSourceV1Schema>;

const SessionRuntimeProviderProcessExitAfterSwitchDetailsV1Schema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(128).nullable(),
    lastStderrLine: z.string().trim().min(1).max(2_000).nullable(),
    vendorResumeId: z.string().trim().min(1).max(512).nullable(),
    materializationRoot: z.string().trim().min(1).max(2_000).nullable(),
    effectiveStateMode: z.enum(['shared', 'isolated']).nullable(),
  })
  .strict();

const SessionRuntimeUsageLimitActionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('open_url'),
    labelKey: z.string().trim().min(1).optional(),
    url: z.string().url(),
  }).strict(),
  z.object({
    kind: z.literal('settings'),
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
]);

const SessionRuntimeQuotaSnapshotRefV1Schema = z
  .object({
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema.optional(),
    groupId: ConnectedServiceAuthGroupIdSchema.optional(),
    fetchedAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const SessionRuntimeUsageLimitWindowV1Schema = z
  .object({
    meterId: z.string().trim().min(1),
    scope: z.string().trim().min(1).optional(),
    remainingPct: z.number().finite().min(0).max(100).optional(),
    resetAtMs: z.number().int().nonnegative().optional(),
    status: z.string().trim().min(1).optional(),
  })
  .strict();

export const SessionRuntimeUsageLimitDetailsV1Schema = z
  .object({
    v: z.literal(1),
    resetAtMs: z.number().int().nonnegative().nullable(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    quotaScope: z.enum(['account', 'workspace', 'organization', 'model', 'provider', 'unknown']),
    recoverability: z.enum(['wait', 'switch_account', 'manual', 'unknown']),
    providerLimitId: z.string().trim().min(1).optional(),
    planType: z.string().trim().min(1).nullable().optional(),
    utilization: z.number().finite().min(0).max(100).nullable().optional(),
    limitCategory: ConnectedServiceLimitCategoryV1Schema.optional(),
    quotaSnapshotRef: SessionRuntimeQuotaSnapshotRefV1Schema.optional(),
    effectiveMeterId: z.string().trim().min(1).optional(),
    effectiveRemainingPct: z.number().finite().min(0).max(100).optional(),
    allWindows: z.array(SessionRuntimeUsageLimitWindowV1Schema).optional(),
    recoveryDecision: z
      .enum(['switching', 'waiting_for_reset', 'manual_intervention', 'not_recoverable'])
      .optional(),
    overage: z
      .object({
        status: z.enum(['allowed', 'allowed_warning', 'rejected', 'unknown']),
        resetAtMs: z.number().int().nonnegative().nullable(),
        disabledReason: z.string().trim().min(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    action: SessionRuntimeUsageLimitActionV1Schema.nullable().optional(),
    connectedService: z
      .object({
        serviceId: ConnectedServiceIdSchema,
        profileId: ConnectedServiceProfileIdSchema.nullable(),
        groupId: ConnectedServiceAuthGroupIdSchema.nullable(),
        groupExhausted: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type SessionRuntimeUsageLimitDetailsV1 = z.infer<typeof SessionRuntimeUsageLimitDetailsV1Schema>;

export const SessionRuntimeTemporaryThrottleDetailsV1Schema = z
  .object({
    v: z.literal(1),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    recoverability: z.enum(['retry', 'manual', 'wait', 'unknown']),
  })
  .strict();

export type SessionRuntimeTemporaryThrottleDetailsV1 =
  z.infer<typeof SessionRuntimeTemporaryThrottleDetailsV1Schema>;

export const SessionRuntimeIssueV1Schema = z
  .object({
    v: z.literal(1),
    scope: z.literal('primary_session'),
    status: z.literal('failed'),
    code: z.string().trim().min(1).max(256),
    source: SessionRuntimeIssueSourceV1Schema,
    occurredAt: z.number().int().nonnegative(),
    sessionSeq: z.number().int().nonnegative().optional(),
    provider: z.string().trim().min(1).max(128).optional(),
    providerTurnId: z.string().trim().min(1).max(256).optional(),
    sanitizedPreview: z.string().trim().min(1).max(2_000).optional(),
    usageLimit: SessionRuntimeUsageLimitDetailsV1Schema.optional(),
    temporaryThrottle: SessionRuntimeTemporaryThrottleDetailsV1Schema.optional(),
    providerProcessExitAfterSwitch: SessionRuntimeProviderProcessExitAfterSwitchDetailsV1Schema.optional(),
  })
  .readonly();
export type SessionRuntimeIssueV1 = z.infer<typeof SessionRuntimeIssueV1Schema>;
