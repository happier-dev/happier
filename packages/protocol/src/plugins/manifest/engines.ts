import { z } from '../../zodRuntimePolicy.js';
import { validRange as semverValidRange } from 'semver';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const PluginEnginesV2Schema = lazyZodSchema(() => z.optional(z.strictObject({
  happier: z.optional(z.string().check(z.trim(), z.minLength(1), z.refine((value) => !/[x*]/i.test(value) && semverValidRange(value) !== null, 'engines.happier must be a non-wildcard semver range.'))),
})));
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;
