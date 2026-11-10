import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PeerFlowKindV1Schema } from './flowKind.js';
import { AuthorizedPeerEndpointRouteKindV1Schema } from './routeKind.js';

const Base64UrlSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]+$/)));

export const PeerRouteNonceProofV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  grantId: z.string().check(z.minLength(1)),
  routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
  flowKind: PeerFlowKindV1Schema,
  endpointFingerprint: z.optional(z.string().check(z.minLength(1))),
  nonceBase64Url: Base64UrlSchema,
  signatureBase64Url: Base64UrlSchema,
}));

export type PeerRouteNonceProofV1 = z.infer<typeof PeerRouteNonceProofV1Schema>;

export function createPeerRouteNonceSigningInputV1(input: Readonly<{
  grantId: string;
  routeKind: string;
  flowKind: string;
  endpointFingerprint?: string;
  nonceBase64Url: string;
}>): string {
  return [
    'happier-peer-route-nonce-v1',
    input.grantId,
    input.routeKind,
    input.flowKind,
    input.endpointFingerprint ?? '',
    input.nonceBase64Url,
  ].join('\0');
}
