import { z } from 'zod';

import { DirectRouteGrantScopeV1Schema } from './directRouteGrantScopesV1.js';
import { DIRECT_ROUTE_GRANT_AUDIENCE_V1, createCanonicalJsonSigningInput } from './directRouteGrantV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { DirectPeerRouteKindV1Schema } from './routeKind.js';
import { decodeCanonicalBase64UrlFixedLength } from './strictBase64Url.js';

export const PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2 = 'ephemeral_ed25519' as const;

function fixedBase64UrlSchema(decodedLength: number): z.ZodString {
  return z.string().refine(
    (value) => decodeCanonicalBase64UrlFixedLength(value, decodedLength) !== null,
    `Expected canonical unpadded base64url encoding of ${decodedLength} bytes`,
  );
}

export const DirectRouteGrantPayloadV2Schema = z
  .object({
    v: z.literal(2),
    grantId: z.string().min(1),
    grantFamilyId: z.string().min(1).optional(),
    accountId: z.string().min(1),
    machineId: z.string().min(1),
    flowKind: PeerFlowKindV1Schema,
    routeKind: DirectPeerRouteKindV1Schema,
    scope: DirectRouteGrantScopeV1Schema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    aud: z.literal(DIRECT_ROUTE_GRANT_AUDIENCE_V1),
    endpointFingerprint: z.string().min(1).optional(),
    proofKind: z.literal(PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2),
    ephemeralPublicKeyBase64Url: fixedBase64UrlSchema(32),
  })
  .strict()
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

export const DirectRouteGrantSignatureV2Schema = z
  .object({
    keyId: z.string().min(1),
    alg: z.literal('Ed25519'),
    valueBase64Url: fixedBase64UrlSchema(64),
  })
  .strict();

export const SignedDirectRouteGrantV2Schema = z
  .object({
    payload: DirectRouteGrantPayloadV2Schema,
    signature: DirectRouteGrantSignatureV2Schema,
  })
  .strict();

export const DirectRouteGrantRequestV2Schema = z
  .object({
    v: z.literal(2),
    kind: z.literal(PEER_ROUTE_EPHEMERAL_ED25519_KIND_V2),
    ephemeralPublicKeyBase64Url: fixedBase64UrlSchema(32),
    machineId: z.string().min(1),
    flowKind: PeerFlowKindV1Schema,
    routeKind: DirectPeerRouteKindV1Schema,
    endpointFingerprint: z.string().min(1),
    ttlMs: z.number().int().positive(),
    scope: DirectRouteGrantScopeV1Schema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.scope.kind !== request.flowKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope', 'kind'],
        message: 'Grant request scope kind must match flow kind',
      });
    }
  });

export type DirectRouteGrantPayloadV2 = z.infer<typeof DirectRouteGrantPayloadV2Schema>;
export type DirectRouteGrantSignatureV2 = z.infer<typeof DirectRouteGrantSignatureV2Schema>;
export type SignedDirectRouteGrantV2 = z.infer<typeof SignedDirectRouteGrantV2Schema>;
export type DirectRouteGrantRequestV2 = z.infer<typeof DirectRouteGrantRequestV2Schema>;

export function createDirectRouteGrantSigningInputV2(payload: DirectRouteGrantPayloadV2): string {
  return createCanonicalJsonSigningInput(DirectRouteGrantPayloadV2Schema.parse(payload));
}

export function createSignedDirectRouteGrantDigestInputV2(grant: SignedDirectRouteGrantV2): Uint8Array {
  const parsed = SignedDirectRouteGrantV2Schema.parse(grant);
  return new TextEncoder().encode(createCanonicalJsonSigningInput(parsed));
}
