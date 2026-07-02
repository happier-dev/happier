import { z } from 'zod';

export const PluginSystemToolSourceV1Schema = z.enum(['system', 'user_config', 'managed']);
export type PluginSystemToolSourceV1 = z.infer<typeof PluginSystemToolSourceV1Schema>;

export const PluginSystemToolContributionV1Schema = z.object({
  toolId: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  source: PluginSystemToolSourceV1Schema.optional(),
  executablePath: z.string().trim().min(1).nullable().optional(),
  lookupNames: z.array(z.string().trim().min(1)).default([]),
  defaultArgs: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  expiresInMs: z.number().int().nonnegative().nullable().optional(),
}).strict();
export type PluginSystemToolContributionV1 = z.infer<typeof PluginSystemToolContributionV1Schema>;
