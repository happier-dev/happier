import { z } from '../../zodRuntimePolicy.js';

const EndpointIdSchema = z.string().check(z.trim(), z.minLength(1));
const HttpUrlSchema = z.string().check(z.trim(), z.url(), z.refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.origin === value
      && parsed.origin !== 'null'
      && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return false;
  }
}, { message: 'hosted web endpoint origins must be absolute http or https origins' }));

export const PluginHostedWebEndpointRefV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accessEndpoint'),
    endpointId: EndpointIdSchema,
    origin: HttpUrlSchema,
  }),
  z.strictObject({
    kind: z.literal('localServicePreview'),
    previewId: EndpointIdSchema,
    browserTargetId: z.optional(EndpointIdSchema),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'dependency_unavailable',
      'feature_disabled',
      'policy_denied',
      'revoked',
      'unknown',
    ]),
  }),
]);
export type PluginHostedWebEndpointRefV1 =
  z.infer<typeof PluginHostedWebEndpointRefV1Schema>;
