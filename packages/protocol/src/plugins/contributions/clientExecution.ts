import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/**
 * The one client-executable contribution target grammar. Contribution families
 * may add their own execution semantics, but artifact/module/platform facts
 * must not acquire family-local parsers.
 */
export const PluginClientExecutionPlatformV1Schema = z.enum(['web', 'ios', 'android']);
export type PluginClientExecutionPlatformV1 = z.infer<typeof PluginClientExecutionPlatformV1Schema>;

export const PluginClientExecutionPlatformsV1Schema = z.array(PluginClientExecutionPlatformV1Schema)
  .min(1)
  .max(PluginClientExecutionPlatformV1Schema.options.length)
  .superRefine((platforms, ctx) => {
    if (new Set(platforms).size !== platforms.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Client execution platforms must be unique.',
      });
    }
  });
export type PluginClientExecutionPlatformsV1 = z.infer<typeof PluginClientExecutionPlatformsV1Schema>;

export const PluginClientExecutionModulePathV1Schema = z.string().trim().min(3).max(256).startsWith('./')
  .refine(
    (path) => !path.split(/[\\/]/u).includes('..'),
    'Client execution module paths must not traverse parents.',
  );
export type PluginClientExecutionModulePathV1 = z.infer<typeof PluginClientExecutionModulePathV1Schema>;

export const PluginClientExecutionReferenceV1Schema = z.object({
  artifactId: asProtocolZod(PluginContributionLocalIdSchema),
  modulePath: PluginClientExecutionModulePathV1Schema,
  exportName: z.string().trim().min(1).max(256),
}).strict();
export type PluginClientExecutionReferenceV1 = z.infer<typeof PluginClientExecutionReferenceV1Schema>;
