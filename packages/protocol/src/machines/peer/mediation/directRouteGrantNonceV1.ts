import { z } from 'zod';

import { PeerFlowKindV1Schema } from './flowKind.js';
import { AuthorizedPeerEndpointRouteKindV1Schema } from './routeKind.js';

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const PeerRouteNonceProofV1Schema = z.object({
  v: z.literal(1),
  grantId: z.string().min(1),
  routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
  flowKind: PeerFlowKindV1Schema,
  endpointFingerprint: z.string().min(1).optional(),
  nonceBase64Url: Base64UrlSchema,
  signatureBase64Url: Base64UrlSchema,
});

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
