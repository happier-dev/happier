import { z } from 'zod';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginAvailabilityDescriptorV2Schema, PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const PluginRequestInterceptorOriginV1Schema = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Error();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a canonical HTTP(S) origin.' });
  }
});

export const PluginRequestInterceptorContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  origins: z.array(PluginRequestInterceptorOriginV1Schema).min(1),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])).optional(),
  priority: z.number().int().optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginRequestInterceptorContributionV1 = z.infer<typeof PluginRequestInterceptorContributionV1Schema>;
