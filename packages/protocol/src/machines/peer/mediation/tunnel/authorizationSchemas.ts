import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod';
import { ProviderBrokerApplicationBindingV1Schema, ProviderBrokerRouteGrantPayloadV1Schema } from '../../../../providers/brokerRouteGrantV1.js';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '../../../../auth/authToken.js';
import { TeamCredentialSourceBindingV1Schema } from '../../../../teams/credentials/sourceBindingV1.js';

import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';
import { VoiceMediaApplicationKindV1Schema } from '../voiceMediaV1.js';

export const PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1 =
  'happier-tcp-tunnel-relay-authorization' as const;
export const PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH = 256;

const Base64UrlSchema = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]+$/));
const PositiveIntSchema = lazyZodSchema(() => z.number().int().positive());
const NonNegativeIntSchema = lazyZodSchema(() => z.number().int().nonnegative());

export const PeerTcpTunnelRelayAuthorizationFlowKindV1Schema = lazyZodSchema(() => z.enum([
  'tcp_tunnel',
  'voice_media',
  'provider_broker',
]));
export type PeerTcpTunnelRelayAuthorizationFlowKindV1 = z.infer<
  typeof PeerTcpTunnelRelayAuthorizationFlowKindV1Schema
>;

export const PeerTcpTunnelRelayAuthorizationDestinationV1Schema = lazyZodSchema(() => z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
}));
export type PeerTcpTunnelRelayAuthorizationDestinationV1 = z.infer<
  typeof PeerTcpTunnelRelayAuthorizationDestinationV1Schema
>;

export const ProviderBrokerExternalApiKeyRelayBindingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('external_api_key'),
  teamId: z.string().min(1),
  resourceId: z.string().min(1),
  requestId: z.string().min(1),
  externalApiKeyId: z.string().uuid(),
  operationId: z.string().uuid().nullable(),
  brokerPlacementFingerprint: ProviderBrokerRouteGrantPayloadV1Schema.shape.brokerPlacementFingerprint,
  assignedAccountId: z.string().min(1),
  assignedTeamMembershipId: z.string().min(1),
}).strict());
export const ProviderBrokerResourceTestRelayBindingV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('resource_test'),
  teamId: z.string().min(1),
  resourceId: z.string().min(1),
  requestId: z.string().min(1),
  actorAccountId: z.string().min(1),
  expectedResourceRevision: z.number().int().positive(),
  application: ProviderBrokerApplicationBindingV1Schema,
  source: TeamCredentialSourceBindingV1Schema,
  verifiedCredentialEvidence: AuthTokenAuthenticationEvidenceSnapshotV1Schema.optional(),
}).strict());
export type ProviderBrokerResourceTestRelayBindingV1 = z.infer<
  typeof ProviderBrokerResourceTestRelayBindingV1Schema
>;
export const ProviderBrokerRelayApplicationBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ProviderBrokerExternalApiKeyRelayBindingV1Schema,
  ProviderBrokerResourceTestRelayBindingV1Schema,
]));
export type ProviderBrokerRelayApplicationBindingV1 = z.infer<
  typeof ProviderBrokerRelayApplicationBindingV1Schema
>;

export const PeerTcpTunnelRelayAuthorizationSignatureV1Schema = lazyZodSchema(() => z.object({
  keyId: z.string().min(1),
  alg: z.literal('Ed25519'),
  valueBase64Url: Base64UrlSchema,
}));
export type PeerTcpTunnelRelayAuthorizationSignatureV1 = z.infer<
  typeof PeerTcpTunnelRelayAuthorizationSignatureV1Schema
>;

/**
 * Socket-lifetime-bound relay authorization. V2 is intentionally strict: the
 * source relay socket id is an admission identity, not an extensible metadata
 * bag, and every verifier signs/parses the same exact field set.
 */
export const PeerTcpTunnelRelayAuthorizationPayloadV2Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(2),
    grantId: z.string().min(1),
    accountId: z.string().min(1),
    targetMachineId: z.string().min(1),
    flowKind: PeerTcpTunnelRelayAuthorizationFlowKindV1Schema,
    routeKind: z.literal('server_relay'),
    tunnelId: z.string().min(1),
    applicationKind: VoiceMediaApplicationKindV1Schema.optional(),
    applicationAttemptId: z.string().min(1).max(256).optional(),
    applicationAuthorityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(),
    relaySocketId: z.string().min(1).max(PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH),
    destination: PeerTcpTunnelRelayAuthorizationDestinationV1Schema.strict().optional(),
    providerBroker: ProviderBrokerRelayApplicationBindingV1Schema.optional(),
    capProfileId: z.string().min(1),
    maxFrameBytes: PositiveIntSchema,
    maxIdleMs: PositiveIntSchema.optional(),
    maxDurationMs: PositiveIntSchema.optional(),
    maxTotalBytes: PositiveIntSchema.optional(),
    iat: NonNegativeIntSchema,
    exp: PositiveIntSchema,
    aud: z.literal(PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.flowKind === 'tcp_tunnel') {
      if (payload.maxIdleMs !== undefined || payload.maxDurationMs !== undefined || payload.maxTotalBytes !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxIdleMs'], message: 'TCP lifetime belongs to the consumer, not relay admission' });
      }
    } else if (payload.flowKind === 'provider_broker' && (payload.maxIdleMs === undefined || payload.maxDurationMs === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxIdleMs'], message: 'Application relay authorization requires explicit lifetime budgets' });
    }
    if (payload.exp <= payload.iat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exp'],
        message: 'TCP tunnel relay authorization must expire after issuance',
      });
    }
    const applicationFields = [
      payload.applicationKind,
      payload.applicationAttemptId,
      payload.applicationAuthorityDigest,
    ];
    if (payload.flowKind === 'voice_media' && applicationFields.some((value) => value === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['applicationKind'],
        message: 'Voice media relay authorization requires exact application authority',
      });
    }
    if (payload.flowKind === 'tcp_tunnel' && applicationFields.some((value) => value !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['applicationKind'],
        message: 'TCP tunnel relay authorization cannot carry Voice application authority',
      });
    }
    if (payload.flowKind === 'provider_broker') {
      if (payload.destination !== undefined || payload.providerBroker === undefined
        || applicationFields.some((value) => value !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerBroker'],
          message: 'Provider broker relay authorization requires only an exact application binding',
        });
      }
    } else if (payload.destination === undefined || payload.providerBroker !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['destination'],
        message: 'TCP and Voice relay authorization require only a loopback destination',
      });
    }
  }));
export type PeerTcpTunnelRelayAuthorizationPayloadV2 = z.infer<
  typeof PeerTcpTunnelRelayAuthorizationPayloadV2Schema
>;

export const PeerTcpTunnelRelayAuthorizationV2Schema = lazyZodSchema(() => z
  .object({
    payload: PeerTcpTunnelRelayAuthorizationPayloadV2Schema,
    signature: PeerTcpTunnelRelayAuthorizationSignatureV1Schema.strict(),
  })
  .strict());
export type PeerTcpTunnelRelayAuthorizationV2 = z.infer<typeof PeerTcpTunnelRelayAuthorizationV2Schema>;

/**
 * The relay authorization accepted on the wire. V1 was removed in the RU2 surfaces
 * finalization: nothing ever minted it (the only minter emits `v: 2`) and both verifiers
 * call `verifyPeerTcpTunnelRelayAuthorizationV2`, whose payload is `.strict()` on
 * `v: 2` — so a V1 object parsed here only to be rejected at verification. Keeping it
 * widened the accepted wire surface with a `.passthrough()` shape that could never succeed.
 */
export const PeerTcpTunnelRelayAuthorizationSchema = PeerTcpTunnelRelayAuthorizationV2Schema;
export type PeerTcpTunnelRelayAuthorization = z.infer<typeof PeerTcpTunnelRelayAuthorizationSchema>;

export type PeerTcpTunnelRelayAuthorizationTrustRootV1 = Readonly<{
  keyId: string;
  publicKeyBase64Url: string;
  expiresAt?: number | null;
}>;

export type VerifyPeerTcpTunnelRelayAuthorizationV2Result =
  | Readonly<{ valid: true; payload: PeerTcpTunnelRelayAuthorizationPayloadV2 }>
  | Readonly<{
      valid: false;
      reasonCode:
        | 'authorization_invalid'
        | 'authorization_expired'
        | 'authorization_not_yet_valid'
        | 'unknown_key'
        | 'invalid_public_key'
        | 'invalid_signature'
        | 'bad_signature';
    }>;

export function createPeerTcpTunnelRelayAuthorizationSigningInputV2(
  payload: PeerTcpTunnelRelayAuthorizationPayloadV2,
): string {
  return createCanonicalJsonSigningInput(PeerTcpTunnelRelayAuthorizationPayloadV2Schema.parse(payload));
}
