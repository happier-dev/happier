import { z } from 'zod';

import { readCanonicalPaddedBase64DecodedLength } from '../../../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../directRouteGrantV1.js';
import { MachineLiveStreamControlSidebandV1Schema } from './controlV1.js';

export const MACHINE_LIVE_STREAM_SOCKET_EVENT = 'machines.liveStream.v1' as const;
export const MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 = 'happier-live-stream-relay-authorization' as const;

const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();
const Base64Schema = z.string().superRefine((value, context) => {
  if (readCanonicalPaddedBase64DecodedLength(value) !== null) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid base64 payload',
  });
});
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export function getMachineLiveStreamPayloadDecodedByteLength(payloadBase64: string): number {
  return readCanonicalPaddedBase64DecodedLength(payloadBase64) ?? 0;
}

const MachineLiveStreamCapsV1Shape = {
  maxBitrateBps: PositiveIntSchema,
  maxFramesPerSecond: PositiveIntSchema,
  maxFrameBytes: PositiveIntSchema,
  maxDurationMs: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema.optional(),
} as const;

export const MachineLiveStreamCapsV1Schema = z.object(MachineLiveStreamCapsV1Shape).passthrough();

export const MachineLiveStreamRelayCapsV1Schema = z
  .object({
    ...MachineLiveStreamCapsV1Shape,
    maxTotalBytes: PositiveIntSchema,
    maxConcurrentStreamsPerAccount: PositiveIntSchema,
    maxConcurrentStreamsPerSocket: PositiveIntSchema,
    maxConcurrentStreamsPerMachine: PositiveIntSchema,
  })
  .passthrough();

export const MachineLiveStreamRouteKindV1Schema = z.enum(['loopback_direct', 'server_relay']);
export const MachineLiveStreamPayloadKindV1Schema = z.enum(['image_delta', 'image_keyframe', 'metadata']);

export const MachineLiveStreamRelayAuthorizationPayloadV1Schema = z
  .object({
    v: z.literal(1),
    grantId: z.string().min(1),
    accountId: z.string().min(1),
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    flowKind: z.literal('live_stream'),
    routeKind: z.literal('server_relay'),
    streamId: z.string().min(1),
    streamFamily: z.string().min(1),
    // Optional per-tab viewer target (C1). When the watcher is a user-scoped browser
    // socket rather than a peer machine, the grant is minted bound to that socket id so the
    // server can deliver frames to the exact tab (`io.to(viewerSocketId)`) instead of a
    // machine room the viewer never joins. Omitted for the legacy machine→machine path; it
    // is part of the canonical-JSON signing input, so when present it must be identical at
    // mint, start-request, and handler-verify time.
    viewerSocketId: z.string().min(1).optional(),
    ...MachineLiveStreamCapsV1Shape,
    iat: NonNegativeIntSchema,
    exp: PositiveIntSchema,
    aud: z.literal(MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    if (payload.exp <= payload.iat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exp'],
        message: 'Live-stream relay authorization must expire after issuance',
      });
    }
  });

export const MachineLiveStreamRelayAuthorizationSignatureV1Schema = z.object({
  keyId: z.string().min(1),
  alg: z.literal('Ed25519'),
  valueBase64Url: Base64UrlSchema,
});

export const MachineLiveStreamRelayAuthorizationV1Schema = z
  .object({
    payload: MachineLiveStreamRelayAuthorizationPayloadV1Schema,
    signature: MachineLiveStreamRelayAuthorizationSignatureV1Schema,
  })
  .passthrough();

export function createMachineLiveStreamRelayAuthorizationSigningInputV1(
  payload: MachineLiveStreamRelayAuthorizationPayloadV1,
): string {
  return createCanonicalJsonSigningInput(MachineLiveStreamRelayAuthorizationPayloadV1Schema.parse(payload));
}

export const MachineLiveStreamStartRequestV1Schema = z
  .object({
    v: z.literal(1),
    streamId: z.string().min(1),
    streamFamily: z.string().min(1),
    routeKind: MachineLiveStreamRouteKindV1Schema,
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    viewerSocketId: z.string().min(1).optional(),
    ...MachineLiveStreamCapsV1Shape,
    authorization: MachineLiveStreamRelayAuthorizationV1Schema.optional(),
  })
  .passthrough()
  .superRefine((request, ctx) => {
    const authorization = request.authorization;
    if (request.routeKind === 'server_relay' && !authorization) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization'],
        message: 'Server-routed live-stream starts require relay authorization',
      });
      return;
    }
    if (!authorization) return;

    const payload = authorization.payload;
    const expected = {
      sourceMachineId: request.sourceMachineId,
      targetMachineId: request.targetMachineId,
      routeKind: request.routeKind,
      streamId: request.streamId,
      streamFamily: request.streamFamily,
      maxBitrateBps: request.maxBitrateBps,
      maxFramesPerSecond: request.maxFramesPerSecond,
      maxFrameBytes: request.maxFrameBytes,
      maxDurationMs: request.maxDurationMs,
      maxTotalBytes: request.maxTotalBytes,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (payload[key as keyof typeof expected] === value) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'payload', key],
        message: 'Live-stream relay authorization must match the start request',
      });
    }
    // The viewer target is part of the signed grant; the start request must not re-point a
    // grant minted for one tab at a different socket (C1). `undefined` on both sides is the
    // legacy machine→machine path and matches.
    if (request.viewerSocketId !== payload.viewerSocketId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization', 'payload', 'viewerSocketId'],
        message: 'Live-stream relay authorization must match the start request',
      });
    }
  });

export const MachineLiveStreamStartResponseV1Schema = z.discriminatedUnion('accepted', [
  z
    .object({
      v: z.literal(1),
      streamId: z.string().min(1),
      accepted: z.literal(true),
      routeKind: MachineLiveStreamRouteKindV1Schema,
      caps: MachineLiveStreamCapsV1Schema,
      expiresAtMs: PositiveIntSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      v: z.literal(1),
      streamId: z.string().min(1),
      accepted: z.literal(false),
      routeKind: MachineLiveStreamRouteKindV1Schema.optional(),
      disabledReason: z.string().min(1),
    })
    .passthrough(),
]);

export const MachineLiveStreamFrameV1Schema = z
  .object({
    v: z.literal(1),
    streamId: z.string().min(1),
    sequence: PositiveIntSchema,
    timestampMs: NonNegativeIntSchema,
    payloadKind: MachineLiveStreamPayloadKindV1Schema,
    payloadEncoding: z.literal('binary_base64'),
    payloadBase64: Base64Schema,
    payloadSizeBytes: NonNegativeIntSchema,
    encryption: z
      .object({
        alg: z.string().min(1),
        aadBase64: Base64Schema,
        keyId: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((frame, ctx) => {
    const decodedBytes = getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
    if (decodedBytes === frame.payloadSizeBytes) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payloadSizeBytes'],
      message: 'Live-stream frame advisory size must match decoded payload bytes',
    });
  });

const UNSAFE_STREAM_DETAIL_KEYS = new Set([
  'payload',
  'payloadBase64',
  'imageData',
  'screenshot',
  'grantToken',
  'token',
  'nonceBase64Url',
  'endpointUrlWithToken',
]);

function rejectUnsafeStreamDetailKeys(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of Object.keys(value)) {
    if (!UNSAFE_STREAM_DETAIL_KEYS.has(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: 'Live-stream metadata must not contain payload, grant, token, or nonce material',
    });
  }
}

export const MachineLiveStreamMeteringV1Schema = z
  .object({
    v: z.literal(1),
    streamId: z.string().min(1),
    routeKind: MachineLiveStreamRouteKindV1Schema.optional(),
    bytesSent: NonNegativeIntSchema.optional(),
    bytesRelayed: NonNegativeIntSchema.optional(),
    bytesDropped: NonNegativeIntSchema.optional(),
    framesSent: NonNegativeIntSchema.optional(),
    framesDropped: NonNegativeIntSchema.optional(),
    movingBitrateBps: NonNegativeIntSchema,
    framesPerSecond: NonNegativeIntSchema,
    nextAction: z.enum(['continue', 'pause', 'require_keyframe', 'stop']).optional(),
    reasonCode: z.string().min(1).optional(),
    maxBitrateBps: PositiveIntSchema.optional(),
    maxFramesPerSecond: PositiveIntSchema.optional(),
    maxFrameBytes: PositiveIntSchema.optional(),
    maxDurationMs: PositiveIntSchema.optional(),
    maxTotalBytes: PositiveIntSchema.optional(),
  })
  .passthrough()
  .superRefine(rejectUnsafeStreamDetailKeys);

const BaseControlSchema = z.object({
  v: z.literal(1),
  streamId: z.string().min(1),
});

export const MachineLiveStreamControlV1Schema = z.discriminatedUnion('kind', [
  BaseControlSchema.extend({
    kind: z.literal('pause'),
    reasonCode: z.string().min(1),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('resume'),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('ack'),
    nextSequence: PositiveIntSchema,
    // Flow-control contract (L1): the daemon `framePump` starts with unbounded local send
    // credit because the server relay is the bounded network window owner. A socket-precise
    // viewer sends `ack` after delivered frames; the server validates the viewer socket id,
    // replenishes its bounded relay window from these optional credit fields (or its configured
    // defaults), drains queued frames, and forwards the ack to the daemon for diagnostics/local
    // pump credit. A viewer path without a socket id must fail closed before relay open.
    windowFrames: NonNegativeIntSchema.optional(),
    windowBytes: NonNegativeIntSchema.optional(),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('stop'),
    reasonCode: z.string().min(1).optional(),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('cap_exceeded'),
    reasonCode: z.string().min(1),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('grant_expiring'),
    expiresAtMs: PositiveIntSchema,
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('grant_refresh_denied'),
    reasonCode: z.string().min(1),
  }).passthrough(),
  BaseControlSchema.extend({
    kind: z.literal('keyframe_required'),
    reasonCode: z.string().min(1),
  }).passthrough(),
]);

export const MachineLiveStreamRelayEnvelopeV1Schema = z
  .object({
    v: z.literal(1),
    sourceMachineId: z.string().min(1),
    targetMachineId: z.string().min(1),
    // Optional per-tab viewer target (C1). The source daemon echoes the `viewerSocketId` it
    // received in the signed start so the relay can deliver frames/controls to the exact
    // viewer socket. Omitted on the legacy machine→machine path.
    viewerSocketId: z.string().min(1).optional(),
    message: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('start'), startRequest: MachineLiveStreamStartRequestV1Schema }).passthrough(),
      z.object({ kind: z.literal('start_response'), startResponse: MachineLiveStreamStartResponseV1Schema }).passthrough(),
      z.object({ kind: z.literal('frame'), frame: MachineLiveStreamFrameV1Schema }).passthrough(),
      z.object({ kind: z.literal('control'), control: MachineLiveStreamControlV1Schema }).passthrough(),
      z.object({ kind: z.literal('sideband_control'), control: MachineLiveStreamControlSidebandV1Schema }).strict(),
      z.object({ kind: z.literal('receipt'), receipt: z.unknown() }).passthrough(),
      z.object({ kind: z.literal('metering'), metering: MachineLiveStreamMeteringV1Schema }).passthrough(),
    ]),
  })
  .passthrough();

export type MachineLiveStreamCapsV1 = z.infer<typeof MachineLiveStreamCapsV1Schema>;
export type MachineLiveStreamRouteKindV1 = z.infer<typeof MachineLiveStreamRouteKindV1Schema>;
export type MachineLiveStreamPayloadKindV1 = z.infer<typeof MachineLiveStreamPayloadKindV1Schema>;
export type MachineLiveStreamRelayAuthorizationPayloadV1 = z.infer<typeof MachineLiveStreamRelayAuthorizationPayloadV1Schema>;
export type MachineLiveStreamRelayAuthorizationSignatureV1 = z.infer<typeof MachineLiveStreamRelayAuthorizationSignatureV1Schema>;
export type MachineLiveStreamRelayAuthorizationV1 = z.infer<typeof MachineLiveStreamRelayAuthorizationV1Schema>;
export type MachineLiveStreamStartRequestV1 = z.infer<typeof MachineLiveStreamStartRequestV1Schema>;
export type MachineLiveStreamStartResponseV1 = z.infer<typeof MachineLiveStreamStartResponseV1Schema>;
export type MachineLiveStreamFrameV1 = z.infer<typeof MachineLiveStreamFrameV1Schema>;
export type MachineLiveStreamMeteringV1 = z.infer<typeof MachineLiveStreamMeteringV1Schema>;
export type MachineLiveStreamControlV1 = z.infer<typeof MachineLiveStreamControlV1Schema>;
export type MachineLiveStreamRelayEnvelopeV1 = z.infer<typeof MachineLiveStreamRelayEnvelopeV1Schema>;
export type MachineLiveStreamRelayCaps = z.infer<typeof MachineLiveStreamRelayCapsV1Schema>;
