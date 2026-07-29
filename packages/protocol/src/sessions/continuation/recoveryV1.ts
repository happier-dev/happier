import { z } from 'zod';

export const SessionContinuationResumePromptModeV1Schema = z.enum(['standard', 'off', 'custom']);
export type SessionContinuationResumePromptModeV1 =
  z.infer<typeof SessionContinuationResumePromptModeV1Schema>;

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
