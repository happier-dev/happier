import { z } from 'zod';

export const SESSION_CONTINUATION_RECOVERY_METADATA_KEY = 'sessionContinuationRecoveryV1' as const;

export const SessionContinuationResumePromptModeV1Schema = z.enum(['standard', 'off', 'custom']);
export type SessionContinuationResumePromptModeV1 =
  z.infer<typeof SessionContinuationResumePromptModeV1Schema>;

export const SessionContinuationReplayModeV1Schema = z.enum([
  'continuation_prompt',
  'retry_original_user_message',
  'suppress',
]);
export type SessionContinuationReplayModeV1 =
  z.infer<typeof SessionContinuationReplayModeV1Schema>;

export const SessionContinuationRecoverySelectionKindV1Schema = z.enum([
  'profile',
  'group',
]);
export type SessionContinuationRecoverySelectionKindV1 =
  z.infer<typeof SessionContinuationRecoverySelectionKindV1Schema>;

export const SessionContinuationRecoveryIdentityV1Schema = z
  .object({
    serviceId: z.string().trim().min(1),
    selectionKind: SessionContinuationRecoverySelectionKindV1Schema,
    groupId: z.string().trim().min(1).optional(),
    profileId: z.string().trim().min(1).optional(),
    failureFingerprint: z.string().trim().min(1).optional(),
    targetGeneration: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((identity, ctx) => {
    if (identity.selectionKind === 'group' && !identity.groupId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'group continuation recovery identity requires groupId',
        path: ['groupId'],
      });
    }
    if (identity.selectionKind === 'profile' && !identity.profileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profile continuation recovery identity requires profileId',
        path: ['profileId'],
      });
    }
    if (identity.selectionKind === 'profile' && identity.groupId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profile continuation recovery identity must not include groupId',
        path: ['groupId'],
      });
    }
  });
export type SessionContinuationRecoveryIdentityV1 =
  z.infer<typeof SessionContinuationRecoveryIdentityV1Schema>;

export const SessionContinuationRecoveryAttemptStatusV1Schema = z.enum([
  'pending_provider_context',
  'sending',
  'awaiting_provider_activity',
  'provider_activity_observed',
  'provider_activity_timeout',
  'sent',
  'suppressed_no_interrupted_turn',
  'suppressed_newer_user_input',
  'retry_required',
  'continuity_failed',
]);
export type SessionContinuationRecoveryAttemptStatusV1 =
  z.infer<typeof SessionContinuationRecoveryAttemptStatusV1Schema>;

export const SessionContinuationRecoveryAttemptV1Schema = z
  .object({
    v: z.literal(1),
    attemptId: z.string().trim().min(1),
    status: SessionContinuationRecoveryAttemptStatusV1Schema,
    failureAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    resumePromptMode: SessionContinuationResumePromptModeV1Schema,
    replayMode: SessionContinuationReplayModeV1Schema.optional(),
    recoveryIdentity: SessionContinuationRecoveryIdentityV1Schema.optional(),
    continuationRequired: z.boolean().optional(),
    sentAtMs: z.number().int().nonnegative().optional(),
    errorCode: z.string().trim().min(1).optional(),
  })
  .strict();
export type SessionContinuationRecoveryAttemptV1 =
  z.infer<typeof SessionContinuationRecoveryAttemptV1Schema>;

export const SessionContinuationRecoveryV1Schema = z
  .object({
    v: z.literal(1),
    attemptsById: z.record(z.string().trim().min(1), SessionContinuationRecoveryAttemptV1Schema),
  })
  .strict();
export type SessionContinuationRecoveryV1 = z.infer<typeof SessionContinuationRecoveryV1Schema>;

const blockingStatuses = new Set<SessionContinuationRecoveryAttemptStatusV1>([
  'pending_provider_context',
  'sending',
  'awaiting_provider_activity',
]);

export function isSessionContinuationRecoveryBlockingPendingDrain(metadata: unknown): boolean {
  const recovery = readSessionContinuationRecoveryFromMetadata(metadata);
  if (!recovery) return false;
  return Object.values(recovery.attemptsById).some((attempt) => blockingStatuses.has(attempt.status));
}

export function readSessionContinuationRecoveryFromMetadata(metadata: unknown): SessionContinuationRecoveryV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const recovery = (metadata as Record<string, unknown>)[SESSION_CONTINUATION_RECOVERY_METADATA_KEY];
  const parsed = SessionContinuationRecoveryV1Schema.safeParse(recovery);
  return parsed.success ? parsed.data : null;
}
