import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const BrowserProfileStorageModeV1Schema = lazyZodSchema(() => z.enum(['ephemeral', 'session', 'user', 'plugin']));
export type BrowserProfileStorageModeV1 = z.infer<typeof BrowserProfileStorageModeV1Schema>;

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

export const BrowserProfileLifecycleStateV1Schema = lazyZodSchema(() => z.enum(['active', 'purging', 'unusable']));
export type BrowserProfileLifecycleStateV1 = z.infer<typeof BrowserProfileLifecycleStateV1Schema>;

export const BrowserProfilePurgeFailureReasonCodeV1Schema = lazyZodSchema(() => z.enum([
  'disk_purge_failed',
  'permission_denied',
  'profile_in_use',
  'storage_owner_unavailable',
  'unknown',
]));
export type BrowserProfilePurgeFailureReasonCodeV1 = z.infer<
  typeof BrowserProfilePurgeFailureReasonCodeV1Schema
>;

export const BrowserProfilePurgeFailureV1Schema = lazyZodSchema(() => z.strictObject({
    reasonCode: BrowserProfilePurgeFailureReasonCodeV1Schema,
    message: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    occurredAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type BrowserProfilePurgeFailureV1 = z.infer<typeof BrowserProfilePurgeFailureV1Schema>;

export const BrowserProfileOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: IdSchema }),
  z.strictObject({ kind: z.literal('user'), id: IdSchema }),
  z.strictObject({
    kind: z.literal('plugin'),
    id: IdSchema,
    contributionId: z.optional(IdSchema),
  }),
]));
export type BrowserProfileOwnerV1 = z.infer<typeof BrowserProfileOwnerV1Schema>;

export const BrowserProfileV1Schema = lazyZodSchema(() => z.strictObject({
    profileId: IdSchema,
    storageMode: BrowserProfileStorageModeV1Schema,
    owner: BrowserProfileOwnerV1Schema,
    displayName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    createdAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    updatedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    lifecycleState: z.optional(BrowserProfileLifecycleStateV1Schema),
    disabledReasons: z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)))),
    purgeFailure: z.optional(BrowserProfilePurgeFailureV1Schema),
    cleanupOnSessionClose: z._default(z.boolean(), true),
  }).check(z.superRefine((profile, context) => {
    if (profile.storageMode === 'plugin' && profile.owner.kind !== 'plugin') {
      context.addIssue({
        code: "custom",
        path: ['owner'],
        message: 'Plugin browser storage profiles must be plugin-owned.',
      });
    }
    if (profile.lifecycleState === 'unusable' && (profile.disabledReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ['disabledReasons'],
        message: 'Unusable browser profiles require at least one disabled reason.',
      });
    }
  })));
export type BrowserProfileV1 = z.infer<typeof BrowserProfileV1Schema>;

export * from './loginsV1.js';
export * from './importCookiesV1.js';
