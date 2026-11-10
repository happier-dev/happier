import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/**
 * The one client-executable contribution target grammar. Contribution families
 * may add their own execution semantics, but artifact/module/platform facts
 * must not acquire family-local parsers.
 */
export const PluginClientExecutionPlatformV1Schema = lazyZodSchema(() => z.enum(['web', 'ios', 'android']));
export type PluginClientExecutionPlatformV1 = z.infer<typeof PluginClientExecutionPlatformV1Schema>;

export const PluginClientExecutionPlatformsV1Schema = lazyZodSchema(() => z.array(PluginClientExecutionPlatformV1Schema).check(z.minLength(1), z.maxLength(PluginClientExecutionPlatformV1Schema.options.length), z.superRefine((platforms, ctx) => {
    if (new Set(platforms).size !== platforms.length) {
      ctx.addIssue({
        code: "custom",
        message: 'Client execution platforms must be unique.',
      });
    }
  })));
export type PluginClientExecutionPlatformsV1 = z.infer<typeof PluginClientExecutionPlatformsV1Schema>;

export const PluginClientExecutionReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: asProtocolZod(PluginContributionLocalIdSchema),
  exportName: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));
export type PluginClientExecutionReferenceV1 = z.infer<typeof PluginClientExecutionReferenceV1Schema>;
