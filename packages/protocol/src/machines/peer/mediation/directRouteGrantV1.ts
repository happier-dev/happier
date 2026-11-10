import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { DirectRouteGrantScopeV1Schema } from './directRouteGrantScopesV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { AuthorizedPeerEndpointRouteKindV1Schema } from './routeKind.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

export { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

const Base64UrlSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]+$/)));

export const DIRECT_ROUTE_GRANT_AUDIENCE_V1 = 'happier-daemon-route-grant' as const;

export const DirectRouteGrantPayloadV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    grantId: z.string().check(z.minLength(1)),
    grantFamilyId: z.optional(z.string().check(z.minLength(1))),
    accountId: z.string().check(z.minLength(1)),
    machineId: z.string().check(z.minLength(1)),
    flowKind: PeerFlowKindV1Schema,
    routeKind: AuthorizedPeerEndpointRouteKindV1Schema,
    scope: DirectRouteGrantScopeV1Schema,
    iat: z.number().check(z.int(), z.nonnegative()),
    exp: z.number().check(z.int(), z.positive()),
    aud: z.literal(DIRECT_ROUTE_GRANT_AUDIENCE_V1),
    endpointFingerprint: z.optional(z.string().check(z.minLength(1))),
  }).check(z.superRefine((payload, ctx) => {
    if (payload.scope.kind !== payload.flowKind) {
      ctx.addIssue({
        code: "custom",
        path: ['scope', 'kind'],
        message: 'Grant scope kind must match flow kind',
      });
    }
    if (payload.exp <= payload.iat) {
      ctx.addIssue({
        code: "custom",
        path: ['exp'],
        message: 'Grant expiry must be after issue time',
      });
    }
    if (payload.routeKind === 'iroh_peer') {
      ctx.addIssue({
        code: "custom",
        path: ['routeKind'],
        message: 'The happier/machine/1 carrier requires a V2 ephemeral-proof grant',
      });
    }
  })));

export const DirectRouteGrantSignatureV1Schema = lazyZodSchema(() => z.strictObject({
  keyId: z.string().check(z.minLength(1)),
  alg: z.literal('Ed25519'),
  valueBase64Url: Base64UrlSchema,
}));

export const SignedDirectRouteGrantV1Schema = lazyZodSchema(() => z.strictObject({
  payload: DirectRouteGrantPayloadV1Schema,
  signature: DirectRouteGrantSignatureV1Schema,
}));

export type DirectRouteGrantPayloadV1 = z.infer<typeof DirectRouteGrantPayloadV1Schema>;
export type DirectRouteGrantSignatureV1 = z.infer<typeof DirectRouteGrantSignatureV1Schema>;
export type SignedDirectRouteGrantV1 = z.infer<typeof SignedDirectRouteGrantV1Schema>;

export function createDirectRouteGrantSigningInputV1(payload: DirectRouteGrantPayloadV1): string {
  return createCanonicalJsonSigningInput(DirectRouteGrantPayloadV1Schema.parse(payload));
}
