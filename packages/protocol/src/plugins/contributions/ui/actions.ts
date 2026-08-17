import { z } from 'zod';

export const PluginUiFallbackRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('descriptor'),
    descriptorId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('structuredMessage'),
    descriptorId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
]);
export type PluginUiFallbackRefV1 = z.infer<typeof PluginUiFallbackRefV1Schema>;

export function isExecutablePluginUiFallbackRefV1(
  fallback: PluginUiFallbackRefV1 | undefined,
): fallback is Extract<PluginUiFallbackRefV1, { kind: 'descriptor' | 'structuredMessage' | 'hostedWeb' }> {
  return fallback?.kind === 'descriptor'
    || fallback?.kind === 'structuredMessage'
    || fallback?.kind === 'hostedWeb';
}
