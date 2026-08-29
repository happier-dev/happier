import { z } from 'zod';

import { DirectRouteGrantScopeV1Schema } from './directRouteGrantScopesV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { AuthorizedPeerEndpointRouteKindV1Schema } from './routeKind.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

export { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const DIRECT_ROUTE_GRANT_AUDIENCE_V1 = 'happier-daemon-route-grant' as const;

export const DirectRouteGrantPayloadV1Schema = z
  .object({
    v: z.literal(1),
    grantId: z.string().min(1),
    grantFamilyId: z.string().min(1).optional(),
    accountId: z.string().min(1),
    machineId: z.string().min(1),
    flowKind: PeerFlowKindV1Schema,
    routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
    scope: DirectRouteGrantScopeV1Schema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    aud: z.literal(DIRECT_ROUTE_GRANT_AUDIENCE_V1),
    endpointFingerprint: z.string().min(1).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.scope.kind !== payload.flowKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope', 'kind'],
        message: 'Grant scope kind must match flow kind',
      });
    }
    if (payload.exp <= payload.iat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exp'],
        message: 'Grant expiry must be after issue time',
      });
    }
  });

export const DirectRouteGrantSignatureV1Schema = z.object({
  keyId: z.string().min(1),
  alg: z.literal('Ed25519'),
  valueBase64Url: Base64UrlSchema,
});

export const SignedDirectRouteGrantV1Schema = z.object({
  payload: DirectRouteGrantPayloadV1Schema,
  signature: DirectRouteGrantSignatureV1Schema,
});

export type DirectRouteGrantPayloadV1 = z.infer<typeof DirectRouteGrantPayloadV1Schema>;
export type DirectRouteGrantSignatureV1 = z.infer<typeof DirectRouteGrantSignatureV1Schema>;
export type SignedDirectRouteGrantV1 = z.infer<typeof SignedDirectRouteGrantV1Schema>;

export function createDirectRouteGrantSigningInputV1(payload: DirectRouteGrantPayloadV1): string {
  return createCanonicalJsonSigningInput(DirectRouteGrantPayloadV1Schema.parse(payload));
}
