import { z } from 'zod';

import { SignedDirectRouteGrantV2Schema } from '../directRouteGrantV2.js';
import { PeerRouteEphemeralProofV2Schema } from '../ephemeralPeerRouteProofV2.js';
import { PEER_MEDIATION_RECEIPTS } from '../receipts.js';
import { MachineLiveStreamStartRequestV1Schema } from './v1.js';

export const PEER_MACHINE_LIVE_STREAM_DIRECT_START_PATH_V2 = '/peer-mediation/v2/live-stream/start' as const;

export const PeerMachineLiveStreamDirectStartRequestV2Schema = z.object({
  v: z.literal(2),
  streamId: z.string().min(1),
  streamFamily: z.string().min(1),
  routeKind: z.literal('loopback_direct'),
  flowKind: z.literal('live_stream'),
  endpointFingerprint: z.string().min(1),
  grant: SignedDirectRouteGrantV2Schema,
  proof: PeerRouteEphemeralProofV2Schema,
  startRequest: MachineLiveStreamStartRequestV1Schema,
}).strict();

export const PeerMachineLiveStreamDirectStartResponseV2Schema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(2),
    ok: z.literal(true),
    receipt: z.literal(PEER_MEDIATION_RECEIPTS.streamStarted),
    streamId: z.string().min(1),
    routeKind: z.literal('loopback_direct'),
    expiresAtMs: z.number().int().positive(),
  }).strict(),
  z.object({
    v: z.literal(2),
    ok: z.literal(false),
    receipt: z.literal(PEER_MEDIATION_RECEIPTS.routeFallback),
    reasonCode: z.string().min(1),
  }).strict(),
]);

export type PeerMachineLiveStreamDirectStartRequestV2 = z.infer<typeof PeerMachineLiveStreamDirectStartRequestV2Schema>;
export type PeerMachineLiveStreamDirectStartResponseV2 = z.infer<typeof PeerMachineLiveStreamDirectStartResponseV2Schema>;
