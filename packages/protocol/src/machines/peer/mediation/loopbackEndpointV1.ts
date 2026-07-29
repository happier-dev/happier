import { z } from 'zod';

import { PeerRouteNonceProofV1Schema } from './directRouteGrantNonceV1.js';
import { SignedDirectRouteGrantV1Schema } from './directRouteGrantV1.js';
import { PeerFlowKindV1Schema } from './flowKind.js';
import { PEER_MEDIATION_RECEIPTS } from './receipts.js';

const MAX_LOOPBACK_ENDPOINT_URL_LENGTH = 2048;
const PEER_LOOPBACK_PROBE_PATH_V1 = '/peer-mediation/v1/probe';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '[::1]') return true;

  const ipv4Parts = normalized.split('.');
  if (ipv4Parts.length !== 4) return false;
  const [firstPart, ...remainingParts] = ipv4Parts;
  if (firstPart !== '127') return false;
  return remainingParts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export const PeerLoopbackEndpointCandidateV1Schema = z
  .object({
    v: z.literal(1),
    routeKind: z.literal('loopback_direct'),
    url: z.string().min(1).max(MAX_LOOPBACK_ENDPOINT_URL_LENGTH),
    endpointFingerprint: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    directRouteGrantProofVerifierVersions: z.array(z.literal(2)).max(1).optional().default([]),
  })
  .superRefine((candidate, ctx) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate.url);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Loopback endpoint candidates need an absolute URL',
      });
      return;
    }

    if (parsedUrl.protocol !== 'http:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Loopback endpoint candidates must use http:',
      });
    }
    if (!isLoopbackHostname(parsedUrl.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Loopback endpoint candidates must target a loopback host',
      });
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Loopback endpoint candidates must not include URL secrets, query strings, or fragments',
      });
    }
    if (parsedUrl.pathname !== PEER_LOOPBACK_PROBE_PATH_V1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Loopback endpoint candidates must target the peer mediation probe endpoint',
      });
    }
  })
  .strict();

export const PeerLoopbackProbeRequestV1Schema = z
  .object({
    v: z.literal(1),
    grant: SignedDirectRouteGrantV1Schema,
    nonceProof: PeerRouteNonceProofV1Schema,
  })
  .strict();

export const PeerLoopbackProbeFallbackReasonCodeV1Schema = z.enum([
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
]);

export const PeerLoopbackProbeResponseV1Schema = z.discriminatedUnion('ok', [
  z
    .object({
      v: z.literal(1),
      ok: z.literal(true),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeSelected),
      routeKind: z.literal('loopback_direct'),
      flowKind: PeerFlowKindV1Schema,
      endpointFingerprint: z.string().min(1),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      ok: z.literal(false),
      receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
      reasonCode: PeerLoopbackProbeFallbackReasonCodeV1Schema,
    })
    .strict(),
]);

export type PeerLoopbackEndpointCandidateV1 = Omit<
  z.output<typeof PeerLoopbackEndpointCandidateV1Schema>,
  'directRouteGrantProofVerifierVersions'
> & Readonly<{ directRouteGrantProofVerifierVersions?: readonly 2[] }>;
export type PeerLoopbackProbeRequestV1 = z.infer<typeof PeerLoopbackProbeRequestV1Schema>;
export type PeerLoopbackProbeFallbackReasonCodeV1 = z.infer<typeof PeerLoopbackProbeFallbackReasonCodeV1Schema>;
export type PeerLoopbackProbeResponseV1 = z.infer<typeof PeerLoopbackProbeResponseV1Schema>;
