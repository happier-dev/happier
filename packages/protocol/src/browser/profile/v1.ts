import { z } from 'zod';

export const BrowserProfileStorageModeV1Schema = z.enum(['ephemeral', 'session', 'user', 'plugin']);
export type BrowserProfileStorageModeV1 = z.infer<typeof BrowserProfileStorageModeV1Schema>;

const IdSchema = z.string().trim().min(1).max(256);

export const BrowserProfileLifecycleStateV1Schema = z.enum(['active', 'purging', 'unusable']);
export type BrowserProfileLifecycleStateV1 = z.infer<typeof BrowserProfileLifecycleStateV1Schema>;

export const BrowserProfilePurgeFailureReasonCodeV1Schema = z.enum([
  'disk_purge_failed',
  'permission_denied',
  'profile_in_use',
  'storage_owner_unavailable',
  'unknown',
]);
export type BrowserProfilePurgeFailureReasonCodeV1 = z.infer<
  typeof BrowserProfilePurgeFailureReasonCodeV1Schema
>;

export const BrowserProfilePurgeFailureV1Schema = z
  .object({
    reasonCode: BrowserProfilePurgeFailureReasonCodeV1Schema,
    message: z.string().trim().min(1).max(512).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserProfilePurgeFailureV1 = z.infer<typeof BrowserProfilePurgeFailureV1Schema>;

export const BrowserProfileOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: IdSchema }).strict(),
  z.object({ kind: z.literal('user'), id: IdSchema }).strict(),
  z.object({
    kind: z.literal('plugin'),
    id: IdSchema,
    contributionId: IdSchema.optional(),
  }).strict(),
]);
export type BrowserProfileOwnerV1 = z.infer<typeof BrowserProfileOwnerV1Schema>;

export const BrowserProfileV1Schema = z
  .object({
    profileId: IdSchema,
    storageMode: BrowserProfileStorageModeV1Schema,
    owner: BrowserProfileOwnerV1Schema,
    displayName: z.string().trim().min(1).max(256).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    lifecycleState: BrowserProfileLifecycleStateV1Schema.optional(),
    disabledReasons: z.array(z.string().trim().min(1).max(128)).optional(),
    purgeFailure: BrowserProfilePurgeFailureV1Schema.optional(),
    cleanupOnSessionClose: z.boolean().default(true),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.storageMode === 'plugin' && profile.owner.kind !== 'plugin') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner'],
        message: 'Plugin browser storage profiles must be plugin-owned.',
      });
    }
    if (profile.lifecycleState === 'unusable' && (profile.disabledReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disabledReasons'],
        message: 'Unusable browser profiles require at least one disabled reason.',
      });
    }
  });
export type BrowserProfileV1 = z.infer<typeof BrowserProfileV1Schema>;
