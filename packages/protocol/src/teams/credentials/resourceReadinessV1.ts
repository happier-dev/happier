import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../../connect/connectedServiceUxDiagnostics.js';
import { TeamCredentialUsageLimitMetricV1Schema } from './usageV1.js';

/** Safe, content-free readiness reported by the credential-resource owner. */
export const TeamCredentialResourceReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({ kind: z.literal('resource_corrupt') }),
  z.strictObject({ kind: z.literal('resource_unavailable') }),
  z.strictObject({ kind: z.literal('source_unavailable'),
    reason: z.optional(z.literal(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired)),
  }),
  z.strictObject({
    kind: z.literal('broker_unavailable'),
    // Content-free observation only; never grants resource or broker authority.
    reason: z.optional(z.enum([
      'application_unavailable', 'model_unavailable',
      'projection_unavailable', 'response_invalid', 'not_granted', 'incompatible', 'catalog_empty',
    ])),
  }),
  z.strictObject({ kind: z.literal('update_required') }),
  z.strictObject({ kind: z.literal('policy_denied') }),
  z.strictObject({
    kind: z.literal('limit_reached'),
    // The one metric vocabulary: the limit owner decides with it, the catalog
    // read copies the denial's metric into this readiness, and the picker
    // labels it. A second spelling here makes the whole catalog entry throw.
    metric: TeamCredentialUsageLimitMetricV1Schema,
    resetsAtUtc: z.string().check(z.iso.datetime()),
  }),
]));
export type TeamCredentialResourceReadinessV1 = z.infer<typeof TeamCredentialResourceReadinessV1Schema>;

