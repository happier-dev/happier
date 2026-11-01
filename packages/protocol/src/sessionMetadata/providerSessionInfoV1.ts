import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PROVIDER_SESSION_INFO_PROVIDER_MAX = 128;
export const PROVIDER_SESSION_INFO_SESSION_ID_MAX = 1_024;
export const PROVIDER_SESSION_INFO_TITLE_MAX = 1_024;
export const PROVIDER_SESSION_INFO_UPDATED_AT_MAX = 64;

export const ProviderSessionTitleSchema = lazySchema(() => z.string().trim().min(1).max(PROVIDER_SESSION_INFO_TITLE_MAX));
export const ProviderSessionUpdatedAtSchema = lazySchema(() => z.string()
  .max(PROVIDER_SESSION_INFO_UPDATED_AT_MAX)
  .datetime({ offset: true }));

export function createProviderSessionInfoV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    provider: zod.string().trim().min(1).max(PROVIDER_SESSION_INFO_PROVIDER_MAX),
    sessionId: zod.string().min(1).max(PROVIDER_SESSION_INFO_SESSION_ID_MAX),
    observedAt: zod.number().int().nonnegative(),
    title: zod.string().trim().min(1).max(PROVIDER_SESSION_INFO_TITLE_MAX).nullable().optional(),
    updatedAt: zod.string().max(PROVIDER_SESSION_INFO_UPDATED_AT_MAX).datetime({ offset: true }).nullable().optional(),
  }).strict();
}

export const ProviderSessionInfoV1Schema = lazySchema(() => createProviderSessionInfoV1Schema(z));
export type ProviderSessionInfoV1 = z.infer<typeof ProviderSessionInfoV1Schema>;
