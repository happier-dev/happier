import { z } from 'zod';

export const VcsFreshnessSourceSchema = z.enum([
  'live-local',
  'cached-local',
  'cached-remote',
  'explicit-remote',
]);
export type VcsFreshnessSource = z.infer<typeof VcsFreshnessSourceSchema>;

export const VcsFreshnessSchema = z
  .object({
    source: VcsFreshnessSourceSchema,
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.expiresAt === undefined || value.expiresAt >= value.observedAt, {
    message: 'expiresAt must be greater than or equal to observedAt',
    path: ['expiresAt'],
  });
export type VcsFreshness = z.infer<typeof VcsFreshnessSchema>;

export const ProviderRefreshPolicySchema = z.enum([
  'cache-first',
  'stale-while-revalidate',
  'force-refresh',
  'local-only',
]);
export type ProviderRefreshPolicy = z.infer<typeof ProviderRefreshPolicySchema>;

export const VcsLocalStateFreshnessSchema = VcsFreshnessSchema.refine(
  (value) => value.source === 'live-local' || value.source === 'cached-local',
  {
    message: 'local SCM state freshness must use a local source',
    path: ['source'],
  },
);

export const VcsRemoteStateFreshnessSchema = VcsFreshnessSchema.refine(
  (value) => value.source === 'cached-remote' || value.source === 'explicit-remote',
  {
    message: 'remote SCM state freshness must use a remote source',
    path: ['source'],
  },
);
