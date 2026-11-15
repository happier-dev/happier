import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema } from '../url.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const BrowserStoragePersistenceV1Schema = lazyZodSchema(() => z.enum(['ephemeral', 'session', 'persistent', 'plugin']));
export type BrowserStoragePersistenceV1 = z.infer<typeof BrowserStoragePersistenceV1Schema>;

export const BrowserStoragePartitionStateV1Schema = lazyZodSchema(() => z.enum(['active', 'purging', 'unusable']));
export type BrowserStoragePartitionStateV1 = z.infer<typeof BrowserStoragePartitionStateV1Schema>;

export const BrowserStorageAccessPolicyV1Schema = lazyZodSchema(() => z.enum(['deny', 'metadataOnly', 'allow']));
export type BrowserStorageAccessPolicyV1 = z.infer<typeof BrowserStorageAccessPolicyV1Schema>;

export const BrowserCookiePolicyV1Schema = lazyZodSchema(() => z.enum(['deny', 'session', 'persist']));
export type BrowserCookiePolicyV1 = z.infer<typeof BrowserCookiePolicyV1Schema>;

export const BrowserStoragePartitionV1Schema = lazyZodSchema(() => z.strictObject({
    partitionId: IdSchema,
    profileId: IdSchema,
    originKey: BrowserHttpOriginV1Schema,
    targetKind: BrowserViewTargetKindV1Schema,
    persistence: BrowserStoragePersistenceV1Schema,
    state: z.optional(BrowserStoragePartitionStateV1Schema),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
    disabledReasons: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  }).check(z.superRefine((partition, context) => {
    if (partition.state === 'unusable' && (partition.disabledReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ['disabledReasons'],
        message: 'Unusable browser storage partitions require at least one disabled reason.',
      });
    }
  })));
export type BrowserStoragePartitionV1 = z.infer<typeof BrowserStoragePartitionV1Schema>;

export const BrowserStoragePolicyV1Schema = lazyZodSchema(() => z.strictObject({
    mode: BrowserProfileStorageModeV1Schema,
    clearOnClose: z._default(z.boolean(), true),
    partitionPersistence: z.optional(BrowserStoragePersistenceV1Schema),
    cookies: z._default(z.optional(BrowserCookiePolicyV1Schema), 'deny'),
    localStorage: z._default(z.optional(BrowserStorageAccessPolicyV1Schema), 'metadataOnly'),
    sessionStorage: z._default(z.optional(BrowserStorageAccessPolicyV1Schema), 'metadataOnly'),
    indexedDb: z._default(z.optional(BrowserStorageAccessPolicyV1Schema), 'metadataOnly'),
    cacheStorage: z._default(z.optional(BrowserStorageAccessPolicyV1Schema), 'metadataOnly'),
    downloadsPersistence: z._default(z.enum(['deny', 'prompt', 'persist']), 'prompt'),
  }));
export type BrowserStoragePolicyV1 = z.infer<typeof BrowserStoragePolicyV1Schema>;
