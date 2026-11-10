import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const PluginUiFallbackRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('descriptor'),
    descriptorId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('structuredMessage'),
    descriptorId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
  }),
  z.strictObject({
    kind: z.literal('none'),
  }),
]));
export type PluginUiFallbackRefV1 = z.infer<typeof PluginUiFallbackRefV1Schema>;

export function isExecutablePluginUiFallbackRefV1(
  fallback: PluginUiFallbackRefV1 | undefined,
): fallback is Extract<PluginUiFallbackRefV1, { kind: 'descriptor' | 'structuredMessage' | 'hostedWeb' }> {
  return fallback?.kind === 'descriptor'
    || fallback?.kind === 'structuredMessage'
    || fallback?.kind === 'hostedWeb';
}
