import { z } from 'zod';

const EndpointIdSchema = z.string().trim().min(1);
const HttpUrlSchema = z.string().trim().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.origin === value
      && parsed.origin !== 'null'
      && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return false;
  }
}, { message: 'hosted web endpoint origins must be absolute http or https origins' });

export const PluginHostedWebEndpointRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accessEndpoint'),
    endpointId: EndpointIdSchema,
    origin: HttpUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal('localServicePreview'),
    previewId: EndpointIdSchema,
    browserTargetId: EndpointIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'dependency_unavailable',
      'feature_disabled',
      'policy_denied',
      'revoked',
      'unknown',
    ]),
  }).strict(),
]);
export type PluginHostedWebEndpointRefV1 =
  z.infer<typeof PluginHostedWebEndpointRefV1Schema>;
