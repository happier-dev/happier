import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema, PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const PluginRequestInterceptorOriginV1Schema = lazyZodSchema(() => z.string().check(z.superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Error();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a canonical HTTP(S) origin.' });
  }
})));

export const PluginRequestInterceptorContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  origins: z.array(PluginRequestInterceptorOriginV1Schema).check(z.minLength(1)),
  methods: z.optional(z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']))),
  priority: z.optional(z.number().check(z.int())),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginRequestInterceptorContributionV1 = z.infer<typeof PluginRequestInterceptorContributionV1Schema>;
