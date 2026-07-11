import { describe, expect, it } from 'vitest';

import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  MachineLiveStreamControlV1Schema,
  MachineLiveStreamFrameV1Schema,
  MachineLiveStreamRelayAuthorizationPayloadV1Schema,
  MachineLiveStreamRelayEnvelopeV1Schema,
  MachineLiveStreamStartRequestV1Schema,
  createMachineLiveStreamRelayAuthorizationSigningInputV1,
} from './v1';

const baseStartRequest = {
  v: 1,
  streamId: 'stream_1',
  streamFamily: 'screen',
  routeKind: 'server_relay',
  sourceMachineId: 'machine_source',
  targetMachineId: 'machine_target',
  maxBitrateBps: 64_000,
  maxFramesPerSecond: 12,
  maxFrameBytes: 32_000,
  maxDurationMs: 60_000,
  maxTotalBytes: 128_000,
  authorization: {
    payload: {
      v: 1,
      grantId: 'relay_grant_1',
      accountId: 'account_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      flowKind: 'live_stream',
      routeKind: 'server_relay',
      streamId: 'stream_1',
      streamFamily: 'screen',
      maxBitrateBps: 64_000,
      maxFramesPerSecond: 12,
      maxFrameBytes: 32_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
      iat: 1_000,
      exp: 61_000,
      aud: 'happier-live-stream-relay-authorization',
    },
    signature: {
      keyId: 'relay_key_1',
      alg: 'Ed25519',
      valueBase64Url: 'AbCdEf012_-',
    },
  },
} as const;

const selfAssertedAuthorization = {
  v: 1,
  accountId: 'account_1',
  sourceMachineId: 'machine_source',
  targetMachineId: 'machine_target',
  flowKind: 'live_stream',
  routeKind: 'server_relay',
  streamId: 'stream_1',
  streamFamily: 'screen',
  maxBitrateBps: 64_000,
  maxFramesPerSecond: 12,
  maxFrameBytes: 32_000,
  maxDurationMs: 60_000,
  maxTotalBytes: 128_000,
  issuedAtMs: 1_000,
  expiresAtMs: 61_000,
} as const;

const LIVE_STREAM_LARGE_BASE64_LENGTH = 16 * 1024 * 1024;
const LIVE_STREAM_LARGE_DECODED_LENGTH = (LIVE_STREAM_LARGE_BASE64_LENGTH / 4) * 3;

describe('MachineLiveStreamV1 schemas', () => {
  it('requires positive live-stream caps on start requests', () => {
    const parsed = MachineLiveStreamStartRequestV1Schema.parse(baseStartRequest);

    expect(parsed).toMatchObject({
      streamId: 'stream_1',
      routeKind: 'server_relay',
      maxBitrateBps: 64_000,
      maxFramesPerSecond: 12,
      maxFrameBytes: 32_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    });

    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...baseStartRequest,
      maxFramesPerSecond: 0,
    }).success).toBe(false);
    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...baseStartRequest,
      maxFrameBytes: -1,
    }).success).toBe(false);
  });

  it('requires server relay start authorization bound to the stream and caps', () => {
    const { authorization: _authorization, ...missingAuthorization } = baseStartRequest;

    expect(MachineLiveStreamStartRequestV1Schema.safeParse(missingAuthorization).success).toBe(false);
    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...baseStartRequest,
      authorization: selfAssertedAuthorization,
    }).success).toBe(false);
    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...baseStartRequest,
      authorization: {
        ...baseStartRequest.authorization,
        payload: {
          ...baseStartRequest.authorization.payload,
          streamId: 'other_stream',
        },
      },
    }).success).toBe(false);
    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...baseStartRequest,
      authorization: {
        ...baseStartRequest.authorization,
        payload: {
          ...baseStartRequest.authorization.payload,
          maxFrameBytes: baseStartRequest.maxFrameBytes - 1,
        },
      },
    }).success).toBe(false);
  });

  it('carries an optional viewer socketId end-to-end across the auth payload, start request, and signing input', () => {
    // C1: the viewer (a per-tab user-scoped socket) is targeted by `viewerSocketId`.
    // The field is optional so the machine→machine path is unchanged, but when present it
    // MUST flow consistently through the signed authorization payload AND the start request,
    // or the canonical-JSON signing input drifts and every start fails authorization-mismatch.
    const viewerSocketId = 'viewer-socket-1';
    const authorizationWithViewer = {
      ...baseStartRequest.authorization,
      payload: {
        ...baseStartRequest.authorization.payload,
        viewerSocketId,
      },
    };
    const startWithViewer = {
      ...baseStartRequest,
      viewerSocketId,
      authorization: authorizationWithViewer,
    };

    const parsed = MachineLiveStreamStartRequestV1Schema.parse(startWithViewer);
    expect(parsed.viewerSocketId).toBe(viewerSocketId);
    expect(parsed.authorization?.payload.viewerSocketId).toBe(viewerSocketId);

    // The signed payload must embed the viewer id so the server cannot be tricked into
    // re-targeting a stream at a different tab/socket than the one the grant was minted for.
    const signingInput = createMachineLiveStreamRelayAuthorizationSigningInputV1(
      authorizationWithViewer.payload,
    );
    expect(signingInput).toContain(viewerSocketId);
    expect(MachineLiveStreamRelayAuthorizationPayloadV1Schema.parse(
      authorizationWithViewer.payload,
    ).viewerSocketId).toBe(viewerSocketId);

    // A start request whose top-level viewerSocketId disagrees with the signed payload is rejected
    // by the cross-field superRefine (mirrors the existing caps/stream-id binding checks).
    expect(MachineLiveStreamStartRequestV1Schema.safeParse({
      ...startWithViewer,
      viewerSocketId: 'viewer-socket-other',
    }).success).toBe(false);

    // The base machine→machine path (no viewer socket) still parses identically.
    expect(MachineLiveStreamStartRequestV1Schema.safeParse(baseStartRequest).success).toBe(true);
  });

  it('routes relay envelopes to a viewer socket when present', () => {
    const parsed = MachineLiveStreamRelayEnvelopeV1Schema.parse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'frame',
        frame: {
          v: 1,
          streamId: 'stream_1',
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'metadata',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'e30=',
          payloadSizeBytes: 2,
        },
      },
    });

    expect(parsed.viewerSocketId).toBe('viewer-socket-1');
  });

  it('accepts ack controls with explicit receive credit', () => {
    const parsed = MachineLiveStreamControlV1Schema.parse({
      v: 1,
      streamId: 'stream_1',
      kind: 'ack',
      nextSequence: 8,
      windowFrames: 2,
      windowBytes: 65_536,
    });

    expect(parsed).toEqual({
      v: 1,
      streamId: 'stream_1',
      kind: 'ack',
      nextSequence: 8,
      windowFrames: 2,
      windowBytes: 65_536,
    });
  });

  it('rejects invalid frame sequence and payload encoding', () => {
    const validFrame = {
      v: 1,
      streamId: 'stream_1',
      sequence: 1,
      timestampMs: 1_000,
      payloadKind: 'image_keyframe',
      payloadEncoding: 'binary_base64',
      payloadBase64: 'AQID',
      payloadSizeBytes: 3,
    } as const;

    expect(MachineLiveStreamFrameV1Schema.parse(validFrame).payloadSizeBytes).toBe(3);
    expect(MachineLiveStreamFrameV1Schema.safeParse({ ...validFrame, sequence: 0 }).success).toBe(false);
    expect(MachineLiveStreamFrameV1Schema.safeParse({
      ...validFrame,
      payloadBase64: 'not base64!',
    }).success).toBe(false);
    expect(MachineLiveStreamFrameV1Schema.safeParse({
      ...validFrame,
      payloadBase64: Buffer.from(new Uint8Array(64)).toString('base64'),
      payloadSizeBytes: 1,
    }).success).toBe(false);
  });

  it('validates canonical live-stream frame payloads at 16 MiB without overflowing the regex stack', () => {
    const payloadBase64 = 'A'.repeat(LIVE_STREAM_LARGE_BASE64_LENGTH);

    let parsed: ReturnType<typeof MachineLiveStreamFrameV1Schema.safeParse> | undefined;
    expect(() => {
      parsed = MachineLiveStreamFrameV1Schema.safeParse({
        v: 1,
        streamId: 'stream_1',
        sequence: 1,
        timestampMs: 1_000,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64,
        payloadSizeBytes: LIVE_STREAM_LARGE_DECODED_LENGTH,
      });
    }).not.toThrow();
    expect(parsed?.success).toBe(true);
  });

  it('requires canonical padded base64 for live-stream frame payload and AAD fields', () => {
    const frame = {
      v: 1,
      streamId: 'stream_1',
      sequence: 1,
      timestampMs: 1_000,
      payloadKind: 'image_keyframe',
      payloadEncoding: 'binary_base64',
      payloadBase64: 'AQID',
      payloadSizeBytes: 3,
    } as const;

    expect(MachineLiveStreamFrameV1Schema.safeParse({
      ...frame,
      encryption: {
        alg: 'xchacha20poly1305',
        aadBase64: 'AA==',
      },
    }).success).toBe(true);
    expect(MachineLiveStreamFrameV1Schema.safeParse({
      ...frame,
      payloadBase64: 'AQI',
    }).success).toBe(false);
    expect(MachineLiveStreamFrameV1Schema.safeParse({
      ...frame,
      encryption: {
        alg: 'xchacha20poly1305',
        aadBase64: 'AA=A',
      },
    }).success).toBe(false);
  });

  it('uses a live-stream-specific socket event and relay envelope', () => {
    expect(MACHINE_LIVE_STREAM_SOCKET_EVENT).toBe('machines.liveStream.v1');

    const parsed = MachineLiveStreamRelayEnvelopeV1Schema.parse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'frame',
        frame: {
          v: 1,
          streamId: 'stream_1',
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'metadata',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'e30=',
          payloadSizeBytes: 2,
        },
      },
    });

    expect(parsed.message.kind).toBe('frame');
  });

  it('accepts typed input sideband control envelopes', () => {
    const parsed = MachineLiveStreamRelayEnvelopeV1Schema.parse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'sideband_control',
        control: {
          v: 1,
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'event_1',
          leaseId: 'lease_1',
          kind: 'tap',
          x: 0.5,
          y: 0.25,
        },
      },
    });

    expect(parsed.message.kind).toBe('sideband_control');
    expect(MachineLiveStreamRelayEnvelopeV1Schema.safeParse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'sideband_control',
        control: {
          v: 1,
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'event_1',
          kind: 'tap',
          x: 1.5,
          y: 0.25,
        },
      },
    }).success).toBe(false);
  });

  it('rejects untyped fields on sideband control relay messages', () => {
    expect(MachineLiveStreamRelayEnvelopeV1Schema.safeParse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'sideband_control',
        payload: { arbitrary: true },
        control: {
          v: 1,
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'event_1',
          leaseId: 'lease_1',
          kind: 'tap',
          x: 0.5,
          y: 0.25,
        },
      },
    }).success).toBe(false);
  });

  it('supports start responses and rejects unsafe metering payload details', () => {
    expect(MachineLiveStreamRelayEnvelopeV1Schema.safeParse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'start_response',
        startResponse: {
          v: 1,
          streamId: 'stream_1',
          accepted: true,
          routeKind: 'server_relay',
          caps: baseStartRequest,
        },
      },
    }).success).toBe(true);

    expect(MachineLiveStreamRelayEnvelopeV1Schema.safeParse({
      v: 1,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      message: {
        kind: 'metering',
        metering: {
          v: 1,
          streamId: 'stream_1',
          bytesSent: 8,
          bytesRelayed: 8,
          framesSent: 1,
          framesDropped: 0,
          movingBitrateBps: 64,
          framesPerSecond: 1,
          payloadBase64: 'c2VudGluZWw=',
        },
      },
    }).success).toBe(false);
  });
});
