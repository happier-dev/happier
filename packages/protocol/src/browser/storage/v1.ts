import { z } from 'zod';

import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema } from '../url.js';

const IdSchema = z.string().trim().min(1).max(256);

export const BrowserStoragePersistenceV1Schema = z.enum(['ephemeral', 'session', 'persistent', 'plugin']);
export type BrowserStoragePersistenceV1 = z.infer<typeof BrowserStoragePersistenceV1Schema>;

export const BrowserStoragePartitionStateV1Schema = z.enum(['active', 'purging', 'unusable']);
export type BrowserStoragePartitionStateV1 = z.infer<typeof BrowserStoragePartitionStateV1Schema>;

export const BrowserStorageAccessPolicyV1Schema = z.enum(['deny', 'metadataOnly', 'allow']);
export type BrowserStorageAccessPolicyV1 = z.infer<typeof BrowserStorageAccessPolicyV1Schema>;

export const BrowserCookiePolicyV1Schema = z.enum(['deny', 'session', 'persist']);
export type BrowserCookiePolicyV1 = z.infer<typeof BrowserCookiePolicyV1Schema>;

export const BrowserStoragePartitionV1Schema = z
  .object({
    partitionId: IdSchema,
    profileId: IdSchema,
    originKey: BrowserHttpOriginV1Schema,
    targetKind: BrowserViewTargetKindV1Schema,
    persistence: BrowserStoragePersistenceV1Schema,
    state: BrowserStoragePartitionStateV1Schema.optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
    disabledReasons: z.array(z.string().trim().min(1).max(128)).optional(),
  })
  .strict()
  .superRefine((partition, context) => {
    if (partition.state === 'unusable' && (partition.disabledReasons?.length ?? 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disabledReasons'],
        message: 'Unusable browser storage partitions require at least one disabled reason.',
      });
    }
  });
export type BrowserStoragePartitionV1 = z.infer<typeof BrowserStoragePartitionV1Schema>;

export const BrowserStoragePolicyV1Schema = z
  .object({
    mode: BrowserProfileStorageModeV1Schema,
    clearOnClose: z.boolean().default(true),
    partitionPersistence: BrowserStoragePersistenceV1Schema.optional(),
    cookies: BrowserCookiePolicyV1Schema.optional().default('deny'),
    localStorage: BrowserStorageAccessPolicyV1Schema.optional().default('metadataOnly'),
    sessionStorage: BrowserStorageAccessPolicyV1Schema.optional().default('metadataOnly'),
    indexedDb: BrowserStorageAccessPolicyV1Schema.optional().default('metadataOnly'),
    cacheStorage: BrowserStorageAccessPolicyV1Schema.optional().default('metadataOnly'),
    downloadsPersistence: z.enum(['deny', 'prompt', 'persist']).default('prompt'),
  })
  .strict();
export type BrowserStoragePolicyV1 = z.infer<typeof BrowserStoragePolicyV1Schema>;
