import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const SessionContinuationResumePromptModeV1Schema = lazyZodSchema(() => z.enum(['standard', 'off', 'custom']));
export type SessionContinuationResumePromptModeV1 =
  z.infer<typeof SessionContinuationResumePromptModeV1Schema>;

export const SessionContinuationRecoverySelectionKindV1Schema = lazyZodSchema(() => z.enum([
  'profile',
  'group',
]));
export type SessionContinuationRecoverySelectionKindV1 =
  z.infer<typeof SessionContinuationRecoverySelectionKindV1Schema>;

export const SessionContinuationRecoveryIdentityV1Schema = lazyZodSchema(() => z.strictObject({
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    selectionKind: SessionContinuationRecoverySelectionKindV1Schema,
    groupId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    failureFingerprint: z.optional(z.string().check(z.trim(), z.minLength(1))),
    targetGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
  }).check(z.superRefine((identity, ctx) => {
    if (identity.selectionKind === 'group' && !identity.groupId) {
      ctx.addIssue({
        code: "custom",
        message: 'group continuation recovery identity requires groupId',
        path: ['groupId'],
      });
    }
    if (identity.selectionKind === 'profile' && !identity.profileId) {
      ctx.addIssue({
        code: "custom",
        message: 'profile continuation recovery identity requires profileId',
        path: ['profileId'],
      });
    }
    if (identity.selectionKind === 'profile' && identity.groupId) {
      ctx.addIssue({
        code: "custom",
        message: 'profile continuation recovery identity must not include groupId',
        path: ['groupId'],
      });
    }
  })));
export type SessionContinuationRecoveryIdentityV1 =
  z.infer<typeof SessionContinuationRecoveryIdentityV1Schema>;
