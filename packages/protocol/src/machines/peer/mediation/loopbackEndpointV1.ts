import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PeerRouteNonceProofV1Schema } from './directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema } from './directRouteGrantV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { PEER_MEDIATION_RECEIPTS } from './receipts.js';
import { isLiteralLoopbackHostname } from '../../../server/urls/loopbackHostname.js';

const MAX_LOOPBACK_ENDPOINT_URL_LENGTH = 2048;

export const PeerLoopbackEndpointCandidateV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z
  .object({
    v: z.literal(1),
    routeKind: z.literal('loopback_direct'),
    url: z.string().check(z.minLength(1), z.maxLength(MAX_LOOPBACK_ENDPOINT_URL_LENGTH)),
    endpointFingerprint: z.string().check(z.minLength(1)),
    expiresAt: z.number().check(z.int(), z.nonnegative()),
  }).check(z.superRefine((candidate, ctx) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate.url);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Loopback endpoint candidates need an absolute URL',
      });
      return;
    }

    if (parsedUrl.protocol !== 'http:') {
      ctx.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Loopback endpoint candidates must use http:',
      });
    }
    if (!isLiteralLoopbackHostname(parsedUrl.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Loopback endpoint candidates must target a loopback host',
      });
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      ctx.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Loopback endpoint candidates must not include URL secrets, query strings, or fragments',
      });
    }
    if (parsedUrl.pathname !== '/') {
      ctx.addIssue({
        code: "custom",
        path: ['url'],
        message: 'Loopback endpoint candidates must publish the listener base URL',
      });
    }
  }))));

export const PeerLoopbackProbeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    grant: SignedDirectRouteGrantV1Schema,
    nonceProof: PeerRouteNonceProofV1Schema,
  }));

export const PeerLoopbackProbeFallbackReasonCodeV1Schema = lazyZodSchema(() => z.enum([
  'grant_invalid',
  'grant_unknown_key',
  'grant_bad_signature',
  'grant_expired',
  'grant_not_yet_valid',
  'grant_revoked',
  'grant_account_mismatch',
  'grant_machine_mismatch',
  'grant_flow_mismatch',
  'grant_route_mismatch',
  'grant_endpoint_mismatch',
  'nonce_invalid',
  'nonce_binding_mismatch',
  'nonce_bad_signature',
]));

export const PeerLoopbackProbeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
      v: z.literal(1),
      ok: z.literal(true),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeSelected),
      routeKind: z.literal('loopback_direct'),
      flowKind: PeerFlowKindV1Schema,
      endpointFingerprint: z.string().check(z.minLength(1)),
    }),
  z.strictObject({
      v: z.literal(1),
      ok: z.literal(false),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
      reasonCode: PeerLoopbackProbeFallbackReasonCodeV1Schema,
    }),
]));

export type PeerLoopbackEndpointCandidateV1 = z.output<typeof PeerLoopbackEndpointCandidateV1Schema>;
export type PeerLoopbackProbeRequestV1 = z.infer<typeof PeerLoopbackProbeRequestV1Schema>;
export type PeerLoopbackProbeFallbackReasonCodeV1 = z.infer<typeof PeerLoopbackProbeFallbackReasonCodeV1Schema>;
export type PeerLoopbackProbeResponseV1 = z.infer<typeof PeerLoopbackProbeResponseV1Schema>;
