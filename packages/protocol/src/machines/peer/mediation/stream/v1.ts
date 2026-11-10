import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { readCanonicalPaddedBase64DecodedLength } from '../../../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';
import { MachineLiveStreamControlSidebandV1Schema } from './controlV1.js';
import { MachineLiveStreamCodecIdV1Schema, getMachineLiveStreamPayloadDecodedByteLength } from './codecsV1.js';
import { MachineLiveStreamSourceAdmissionBindingV1Schema } from './sourceAdmissionV1.js';
import { SocketRpcSessionBrowserAuthorizationContextSchema } from '../../../../sessions/access/sessionBrowserAccessV1.js';
export {
  MachineLiveStreamSourceAdmissionBindingV1Schema,
  MachineLiveStreamSourceAdmissionPayloadV1Schema,
  MachineLiveStreamSourceAdmissionV1Schema,
  type MachineLiveStreamSourceAdmissionBindingV1,
  type MachineLiveStreamSourceAdmissionPayloadV1,
  type MachineLiveStreamSourceAdmissionV1,
} from './sourceAdmissionV1.js';

export { getMachineLiveStreamPayloadDecodedByteLength } from './codecsV1.js';

export const MACHINE_LIVE_STREAM_SOCKET_EVENT = 'machines.liveStream.v1' as const;
export const MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 = 'happier-live-stream-relay-authorization' as const;

const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Base64Schema = lazyZodSchema(() => z.string().check(z.superRefine((value, context) => {
  if (readCanonicalPaddedBase64DecodedLength(value) !== null) return;
  context.addIssue({
    code: "custom",
    message: 'Invalid base64 payload',
  });
})));
const Base64UrlSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]+$/)));

const MachineLiveStreamCapsV1Shape = {
  maxBitrateBps: z.optional(PositiveIntSchema),
  maxFramesPerSecond: z.optional(PositiveIntSchema),
  maxFrameBytes: z.optional(PositiveIntSchema),
  maxDurationMs: z.optional(PositiveIntSchema),
  maxTotalBytes: z.optional(PositiveIntSchema),
} as const;

export const MachineLiveStreamCapsV1Schema = lazyZodSchema(() => z.looseObject(MachineLiveStreamCapsV1Shape));

export const MachineLiveStreamRelayCapsV1Schema = lazyZodSchema(() => z.looseObject({
    ...MachineLiveStreamCapsV1Shape,
    maxConcurrentStreamsPerAccount: z.optional(PositiveIntSchema),
    maxConcurrentStreamsPerSocket: z.optional(PositiveIntSchema),
    maxConcurrentStreamsPerMachine: z.optional(PositiveIntSchema),
  }));

export const MachineLiveStreamRouteKindV1Schema = lazyZodSchema(() => z.enum(['loopback_direct', 'server_relay']));
export const MachineLiveStreamPayloadKindV1Schema = lazyZodSchema(() => z.enum(['image_delta', 'image_keyframe', 'metadata']));

const relayAuthorizationPayloadShape = () => ({
    v: z.literal(1),
    grantId: z.string().check(z.minLength(1)),
    accountId: z.string().check(z.minLength(1)),
    sourceMachineId: z.string().check(z.minLength(1)),
    targetMachineId: z.string().check(z.minLength(1)),
    flowKind: z.literal('live_stream'),
    routeKind: z.literal('server_relay'),
    streamId: z.string().check(z.minLength(1)),
    streamFamily: z.string().check(z.minLength(1)),
    sourceId: z.optional(z.string().check(z.minLength(1))),
    // Optional per-tab viewer target (C1). When the watcher is a user-scoped browser
    // socket rather than a peer machine, the grant is minted bound to that socket id so the
    // server can deliver frames to the exact tab (`io.to(viewerSocketId)`) instead of a
    // machine room the viewer never joins. Omitted for the legacy machine→machine path; it
    // is part of the canonical-JSON signing input, so when present it must be identical at
    // mint, start-request, and handler-verify time.
    viewerSocketId: z.optional(z.string().check(z.minLength(1))),
    ...MachineLiveStreamCapsV1Shape,
    codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
    viewerCodecs: z.optional(z.array(MachineLiveStreamCodecIdV1Schema)),
    iat: NonNegativeIntSchema,
    exp: PositiveIntSchema,
    aud: z.literal(MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1),
  });

/** V1 remains the custodian carrier; V2 is a closed, exact personal-viewer admission. */
export const MachineLiveStreamRelayAuthorizationPayloadV1Schema = lazyZodSchema(() => z.union([
  z.looseObject(relayAuthorizationPayloadShape()),
  z.strictObject({
    ...relayAuthorizationPayloadShape(),
    v: z.literal(2),
    viewerAccountId: z.string().check(z.minLength(1)),
    viewerSocketId: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)),
    sourceMachineInstallationId: z.string().check(z.minLength(1)),
    personalSourceAdmission: MachineLiveStreamSourceAdmissionBindingV1Schema,
    sessionBrowserAccess: z.optional(SocketRpcSessionBrowserAuthorizationContextSchema),
  }).check(z.superRefine((payload, ctx) => {
    if (payload.targetMachineId !== payload.sourceMachineId
      || payload.viewerAccountId !== payload.personalSourceAdmission.actorAccountId
      || payload.sourceId !== payload.personalSourceAdmission.sourceId
      || payload.streamFamily !== payload.personalSourceAdmission.streamFamily) {
      ctx.addIssue({ code: 'custom', message: 'Personal viewers bind the exact admitted source and person' });
    }
    const access = payload.sessionBrowserAccess;
    if ((access !== undefined) !== (payload.personalSourceAdmission.sessionBrowserSessionId !== undefined)
      || access && (payload.streamFamily !== 'browser.streamed' || access.custodianAccountId !== payload.accountId
      || access.sessionId !== payload.personalSourceAdmission.sessionBrowserSessionId
      || access.actorAccountId !== payload.viewerAccountId || access.machineId !== payload.sourceMachineId
      || access.installationId !== payload.sourceMachineInstallationId || !access.effectiveAccess.capabilities.readTranscript)) {
      ctx.addIssue({ code: 'custom', message: 'Session Browser viewers bind the admitted Session and installation' });
    }
  })),
]).check(z.superRefine((payload, ctx) => {
    if (payload.exp <= payload.iat) {
      ctx.addIssue({
        code: "custom",
        path: ['exp'],
        message: 'Live-stream relay authorization must expire after issuance',
      });
    }
  })));

export const MachineLiveStreamRelayAuthorizationSignatureV1Schema = lazyZodSchema(() => z.object({
  keyId: z.string().check(z.minLength(1)),
  alg: z.literal('Ed25519'),
  valueBase64Url: Base64UrlSchema,
}));

export const MachineLiveStreamRelayAuthorizationV1Schema = lazyZodSchema(() => z.looseObject({
    payload: MachineLiveStreamRelayAuthorizationPayloadV1Schema,
    signature: MachineLiveStreamRelayAuthorizationSignatureV1Schema,
  }));

export function createMachineLiveStreamRelayAuthorizationSigningInputV1(
  payload: MachineLiveStreamRelayAuthorizationPayloadV1,
): string {
  return createCanonicalJsonSigningInput(MachineLiveStreamRelayAuthorizationPayloadV1Schema.parse(payload));
}

export const MachineLiveStreamStartRequestV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    streamId: z.string().check(z.minLength(1)),
    streamFamily: z.string().check(z.minLength(1)),
    sourceId: z.optional(z.string().check(z.minLength(1))),
    /** Exact source occurrence bound by plugin viewing admission. */
    sourceOccurrenceId: z.optional(z.string().check(z.minLength(1))),
    routeKind: MachineLiveStreamRouteKindV1Schema,
    sourceMachineId: z.string().check(z.minLength(1)),
    targetMachineId: z.string().check(z.minLength(1)),
    viewerSocketId: z.optional(z.string().check(z.minLength(1))),
    ...MachineLiveStreamCapsV1Shape,
    codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
    viewerCodecs: z.optional(z.array(MachineLiveStreamCodecIdV1Schema)),
    authorization: z.optional(MachineLiveStreamRelayAuthorizationV1Schema),
  }).check(z.superRefine((request, ctx) => {
    if (request.streamFamily === 'browser.streamed' && !request.sourceId) {
      ctx.addIssue({ code: "custom", path: ['sourceId'], message: 'Browser streams require the exact view source' });
    }
    const authorization = request.authorization;
    if (request.routeKind === 'server_relay' && !authorization) {
      ctx.addIssue({
        code: "custom",
        path: ['authorization'],
        message: 'Server-routed live-stream starts require relay authorization',
      });
      return;
    }
    if (!authorization) return;

    const payload = authorization.payload;
    if (payload.v === 2 && request.sourceOccurrenceId !== undefined
      && request.sourceOccurrenceId !== payload.personalSourceAdmission.sourceOccurrenceId) {
      ctx.addIssue({ code: 'custom', path: ['sourceOccurrenceId'], message: 'Personal streams bind the admitted source occurrence' });
    }
    const expected = {
      sourceMachineId: request.sourceMachineId,
      targetMachineId: request.targetMachineId,
      routeKind: request.routeKind,
      streamId: request.streamId,
      streamFamily: request.streamFamily,
      sourceId: request.sourceId,
      maxBitrateBps: request.maxBitrateBps,
      maxFramesPerSecond: request.maxFramesPerSecond,
      maxFrameBytes: request.maxFrameBytes,
      maxDurationMs: request.maxDurationMs,
      maxTotalBytes: request.maxTotalBytes,
      codecId: request.codecId,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (payload[key as keyof typeof expected] === value) continue;
      ctx.addIssue({
        code: "custom",
        path: ['authorization', 'payload', key],
        message: 'Live-stream relay authorization must match the start request',
      });
    }
    if (JSON.stringify(request.viewerCodecs) !== JSON.stringify(payload.viewerCodecs)) {
      ctx.addIssue({ code: "custom", path: ['authorization', 'payload', 'viewerCodecs'],
        message: 'Live-stream relay authorization must match the viewer codecs' });
    }
    // The viewer target is part of the signed grant; the start request must not re-point a
    // grant minted for one tab at a different socket (C1). `undefined` on both sides is the
    // legacy machine→machine path and matches.
    if (request.viewerSocketId !== payload.viewerSocketId) {
      ctx.addIssue({
        code: "custom",
        path: ['authorization', 'payload', 'viewerSocketId'],
        message: 'Live-stream relay authorization must match the start request',
      });
    }
  })));

export const MachineLiveStreamStartResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('accepted', [
  z.looseObject({
      v: z.literal(1),
      streamId: z.string().check(z.minLength(1)),
      accepted: z.literal(true),
      routeKind: MachineLiveStreamRouteKindV1Schema,
      caps: MachineLiveStreamCapsV1Schema,
      expiresAtMs: z.optional(PositiveIntSchema),
    }),
  z.looseObject({
      v: z.literal(1),
      streamId: z.string().check(z.minLength(1)),
      accepted: z.literal(false),
      routeKind: z.optional(MachineLiveStreamRouteKindV1Schema),
      disabledReason: z.string().check(z.minLength(1)),
    }),
]));

export const MachineLiveStreamFrameV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    streamId: z.string().check(z.minLength(1)),
    sequence: PositiveIntSchema,
    timestampMs: NonNegativeIntSchema,
    payloadKind: MachineLiveStreamPayloadKindV1Schema,
    payloadEncoding: z.literal('binary_base64'),
    payloadBase64: Base64Schema,
    payloadSizeBytes: NonNegativeIntSchema,
    codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
  }).check(z.superRefine((frame, ctx) => {
    const decodedBytes = getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
    if (decodedBytes === frame.payloadSizeBytes) return;
    ctx.addIssue({
      code: "custom",
      path: ['payloadSizeBytes'],
      message: 'Live-stream frame advisory size must match decoded payload bytes',
    });
  })));

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

function rejectUnsafeStreamDetailKeys(value: Record<string, unknown>, ctx: z.core.$RefinementCtx): void {
  for (const key of Object.keys(value)) {
    if (!UNSAFE_STREAM_DETAIL_KEYS.has(key)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: 'Live-stream metadata must not contain payload, grant, token, or nonce material',
    });
  }
}

export const MachineLiveStreamMeteringV1Schema = lazyZodSchema(() => z.looseObject({
    v: z.literal(1),
    streamId: z.string().check(z.minLength(1)),
    routeKind: z.optional(MachineLiveStreamRouteKindV1Schema),
    bytesSent: z.optional(NonNegativeIntSchema),
    bytesRelayed: z.optional(NonNegativeIntSchema),
    bytesDropped: z.optional(NonNegativeIntSchema),
    framesSent: z.optional(NonNegativeIntSchema),
    framesDropped: z.optional(NonNegativeIntSchema),
    movingBitrateBps: NonNegativeIntSchema,
    framesPerSecond: NonNegativeIntSchema,
    nextAction: z.optional(z.enum(['continue', 'pause', 'require_keyframe', 'stop'])),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
    maxBitrateBps: z.optional(PositiveIntSchema),
    maxFramesPerSecond: z.optional(PositiveIntSchema),
    maxFrameBytes: z.optional(PositiveIntSchema),
    maxDurationMs: z.optional(PositiveIntSchema),
    maxTotalBytes: z.optional(PositiveIntSchema),
  }).check(z.superRefine(rejectUnsafeStreamDetailKeys)));

const BaseControlSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  streamId: z.string().check(z.minLength(1)),
}));

export const MachineLiveStreamControlV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('pause'),
    reasonCode: z.string().check(z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('resume'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('ack'),
    nextSequence: PositiveIntSchema,
    // The server relay owns network credit. ACKs do not change producer sequencing or
    // capture credit; direct transports may consume them at their own carrier boundary.
    windowFrames: z.optional(NonNegativeIntSchema),
    windowBytes: z.optional(NonNegativeIntSchema),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('stop'),
    reasonCode: z.optional(z.string().check(z.minLength(1))),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('cap_exceeded'),
    reasonCode: z.string().check(z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('grant_expiring'),
    expiresAtMs: PositiveIntSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('grant_refresh_denied'),
    reasonCode: z.string().check(z.minLength(1)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(BaseControlSchema, {
    kind: z.literal('keyframe_required'),
    reasonCode: z.string().check(z.minLength(1)),
  })),
]));

const MachineLiveStreamPublicMessageSchemas = [
  z.looseObject({ kind: z.literal('start'), startRequest: MachineLiveStreamStartRequestV1Schema }),
  z.strictObject({ kind: z.literal('renew'), startRequest: MachineLiveStreamStartRequestV1Schema }),
  z.looseObject({ kind: z.literal('start_response'), startResponse: MachineLiveStreamStartResponseV1Schema }),
  z.looseObject({ kind: z.literal('control'), control: MachineLiveStreamControlV1Schema }),
  z.looseObject({ kind: z.literal('receipt'), receipt: z.unknown() }),
  z.looseObject({ kind: z.literal('metering'), metering: MachineLiveStreamMeteringV1Schema }),
] as const;

// Decoded process-local content. Never emit this schema's frame/input shapes on the socket.
export const MachineLiveStreamDecodedEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sourceMachineId: z.string().check(z.minLength(1)),
    targetMachineId: z.string().check(z.minLength(1)),
    // Optional per-tab viewer target (C1). The source daemon echoes the `viewerSocketId` it
    // received in the signed start so the relay can deliver frames/controls to the exact
    // viewer socket. Omitted on the legacy machine→machine path.
    viewerSocketId: z.optional(z.string().check(z.minLength(1))),
    message: z.discriminatedUnion('kind', [
      ...MachineLiveStreamPublicMessageSchemas,
      z.looseObject({ kind: z.literal('frame'), frame: MachineLiveStreamFrameV1Schema }),
      z.strictObject({ kind: z.literal('sideband_control'), control: MachineLiveStreamControlSidebandV1Schema }),
    ]),
  }));

const EncryptedStreamPayloadSchema = lazyZodSchema(() => z.strictObject({ t: z.literal('encrypted'), c: Base64Schema }));
export const MachineLiveStreamWireFrameV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  streamId: z.string().check(z.minLength(1)),
  sequence: PositiveIntSchema,
  timestampMs: NonNegativeIntSchema,
  payloadKind: MachineLiveStreamPayloadKindV1Schema,
  payloadEncoding: z.literal('binary_base64'),
  payloadSizeBytes: NonNegativeIntSchema,
  codecId: z.optional(MachineLiveStreamCodecIdV1Schema),
  payload: z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: Base64Schema }),
    EncryptedStreamPayloadSchema,
  ]),
}).check(z.superRefine((frame, ctx) => {
  const encoded = frame.payload.t === 'plain' ? frame.payload.v : frame.payload.c;
  if (getMachineLiveStreamPayloadDecodedByteLength(encoded) === frame.payloadSizeBytes) return;
  ctx.addIssue({ code: "custom", path: ['payloadSizeBytes'],
    message: 'Live-stream transport size must match payload bytes' });
})));

// The relay can inspect routing/metering headers, never decoded input or E2EE pixels.
export const MachineLiveStreamRelayEnvelopeV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineLiveStreamDecodedEnvelopeV1Schema, {
  message: z.discriminatedUnion('kind', [
    ...MachineLiveStreamPublicMessageSchemas,
    z.strictObject({ kind: z.literal('frame'), frame: MachineLiveStreamWireFrameV1Schema }),
    z.strictObject({ kind: z.literal('sideband_control'), control: z.strictObject({
      v: z.literal(1), streamId: z.string().check(z.minLength(1)),
      payload: z.discriminatedUnion('t', [
        z.strictObject({ t: z.literal('plain'), v: MachineLiveStreamControlSidebandV1Schema }),
        EncryptedStreamPayloadSchema,
      ]),
    }) }),
  ]),
})));

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
export type MachineLiveStreamRelayEnvelopeV1 = z.infer<typeof MachineLiveStreamDecodedEnvelopeV1Schema>;
export type MachineLiveStreamWireEnvelopeV1 = z.infer<typeof MachineLiveStreamRelayEnvelopeV1Schema>;
export type MachineLiveStreamWireFrameV1 = z.infer<typeof MachineLiveStreamWireFrameV1Schema>;
export type MachineLiveStreamRelayCaps = z.infer<typeof MachineLiveStreamRelayCapsV1Schema>;
