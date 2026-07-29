import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
  MachineLiveStreamFrameV1Schema,
  PEER_MEDIATION_RECEIPTS,
  createMachineLiveStreamRelayAuthorizationSigningInputV1,
  type MachineLiveStreamFrameV1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import tweetnacl from 'tweetnacl';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import type { machineLiveStreamRelayHandler } from './machineLiveStreamRelayHandler';

type LiveStreamRelaySocket = Parameters<typeof machineLiveStreamRelayHandler>[1];

function payloadBase64ForBytes(bytes: number): string {
  return Buffer.from(new Uint8Array(bytes)).toString('base64');
}

function frame(overrides: Partial<MachineLiveStreamFrameV1> = {}): MachineLiveStreamFrameV1 {
  const payloadSizeBytes = overrides.payloadSizeBytes ?? 3;
  return {
    v: 1,
    streamId: 'stream_1',
    sequence: 1,
    timestampMs: 1_000,
    payloadKind: 'image_keyframe',
    payloadEncoding: 'binary_base64',
    payloadBase64: payloadBase64ForBytes(payloadSizeBytes),
    payloadSizeBytes,
    ...overrides,
  };
}

type LiveStreamCaps = Readonly<{
  maxBitrateBps: number;
  maxFramesPerSecond: number;
  maxFrameBytes: number;
  maxDurationMs: number;
  maxTotalBytes: number;
}>;

function liveStreamCaps(overrides: Partial<LiveStreamCaps> = {}): LiveStreamCaps {
  return {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 8,
    ...overrides,
  };
}

const relaySigningKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const relayAuthorizationTrustRoots = [{
  keyId: 'relay-key-1',
  publicKeyBase64Url: Buffer.from(relaySigningKeyPair.publicKey).toString('base64url'),
}] as const;

function relayAuthorization(
  streamId = 'stream_1',
  caps: LiveStreamCaps = liveStreamCaps(),
  validity: Partial<Readonly<{ iat: number; exp: number }>> = {},
) {
  const payload = {
    v: 1 as const,
    grantId: `relay-grant-${streamId}`,
    accountId: 'user-1',
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-target',
    flowKind: 'live_stream' as const,
    routeKind: 'server_relay' as const,
    streamId,
    streamFamily: 'screen',
    ...caps,
    iat: validity.iat ?? 900,
    exp: validity.exp ?? 61_000,
    aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
  };
  const signingInput = Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), 'utf8');
  return {
    payload,
    signature: {
      keyId: 'relay-key-1',
      alg: 'Ed25519',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, relaySigningKeyPair.secretKey)).toString('base64url'),
    },
  };
}

function selfAssertedRelayAuthorization(streamId = 'stream_1', caps: LiveStreamCaps = liveStreamCaps()) {
  return {
    v: 1,
    accountId: 'user-1',
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-target',
    flowKind: 'live_stream',
    routeKind: 'server_relay',
    streamId,
    streamFamily: 'screen',
    ...caps,
    issuedAtMs: 900,
    expiresAtMs: 61_000,
  };
}

function startMessage(
  streamId = 'stream_1',
  authorization?: ReturnType<typeof relayAuthorization> | ReturnType<typeof selfAssertedRelayAuthorization> | null,
  capOverrides: Partial<LiveStreamCaps> = {},
) {
  const caps = liveStreamCaps(capOverrides);
  const resolvedAuthorization = authorization === undefined ? relayAuthorization(streamId, caps) : authorization;
  return {
    v: 1,
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-target',
    message: {
      kind: 'start',
      startRequest: {
        v: 1,
        streamId,
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        ...caps,
        ...(resolvedAuthorization ? { authorization: resolvedAuthorization } : {}),
      },
    },
  } as const;
}

const relayCaps = {
  maxBitrateBps: 64_000,
  maxFramesPerSecond: 12,
  maxFrameBytes: 32_000,
  maxDurationMs: 60_000,
  maxTotalBytes: 8,
  maxConcurrentStreamsPerAccount: 2,
  maxConcurrentStreamsPerSocket: 1,
  maxConcurrentStreamsPerMachine: 1,
} as const;

const verifyUserOneViewerSocketOwnership = async ({ accountId }: Readonly<{
  accountId: string;
  socketId: string;
}>): Promise<boolean> => accountId === 'user-1';

function viewerRelayAuthorization(
  viewerSocketId: string,
  streamId = 'stream_1',
  caps: LiveStreamCaps = liveStreamCaps(),
  validity: Partial<Readonly<{ iat: number; exp: number }>> = {},
) {
  const base = relayAuthorization(streamId, caps, validity);
  const payload = { ...base.payload, viewerSocketId };
  const signingInput = Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), 'utf8');
  return {
    payload,
    signature: {
      keyId: 'relay-key-1',
      alg: 'Ed25519',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, relaySigningKeyPair.secretKey)).toString('base64url'),
    },
  };
}

function viewerStartMessage(
  viewerSocketId: string,
  streamId = 'stream_1',
  capOverrides: Partial<LiveStreamCaps> = {},
  validity: Partial<Readonly<{ iat: number; exp: number }>> = {},
) {
  const caps = liveStreamCaps(capOverrides);
  const authorization = viewerRelayAuthorization(viewerSocketId, streamId, caps, validity);
  return {
    v: 1,
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-target',
    viewerSocketId,
    message: {
      kind: 'start',
      startRequest: {
        v: 1,
        streamId,
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        viewerSocketId,
        ...caps,
        authorization,
      },
    },
  } as const;
}

function selfTargetRelayAuthorization(streamId = 'stream_1', caps: LiveStreamCaps = liveStreamCaps()) {
  const base = relayAuthorization(streamId, caps);
  const payload = { ...base.payload, targetMachineId: 'machine-source' };
  const signingInput = Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), 'utf8');
  return {
    payload,
    signature: {
      keyId: 'relay-key-1',
      alg: 'Ed25519',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, relaySigningKeyPair.secretKey)).toString('base64url'),
    },
  };
}

function selfTargetStartMessage(streamId = 'stream_1', capOverrides: Partial<LiveStreamCaps> = {}) {
  const caps = liveStreamCaps(capOverrides);
  const authorization = selfTargetRelayAuthorization(streamId, caps);
  return {
    v: 1,
    sourceMachineId: 'machine-source',
    targetMachineId: 'machine-source',
    message: {
      kind: 'start',
      startRequest: {
        v: 1,
        streamId,
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-source',
        ...caps,
        authorization,
      },
    },
  } as const;
}

function emittedFrames(emit: ReturnType<typeof vi.fn>): MachineLiveStreamFrameV1[] {
  const frames: MachineLiveStreamFrameV1[] = [];
  for (const [event, payload] of emit.mock.calls) {
    if (event !== MACHINE_LIVE_STREAM_SOCKET_EVENT) continue;
    const parsed = MachineLiveStreamFrameV1Schema.safeParse(
      (payload as { message?: { kind?: unknown; frame?: unknown } }).message?.frame,
    );
    if (parsed.success) frames.push(parsed.data);
  }
  return frames;
}

describe('machineLiveStreamRelayHandler', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('rejects server-routed live stream by default without leaking frame payloads', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const socketEmit = vi.fn();
    // Socket.IO is a platform boundary; the server socket testkit provides the minimal real event surface.
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn() },
      serverRoutedLiveStreamEnabled: false,
      relayCaps: null,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'frame',
        frame: frame({
          payloadBase64: 'c2VudGluZWw=',
          payloadSizeBytes: 8,
        }),
      },
    });

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'server_routed_live_stream_disabled',
    });
    expect(JSON.stringify(socketEmit.mock.calls)).not.toContain('c2VudGluZWw=');
    expect(JSON.stringify(socketEmit.mock.calls)).not.toContain('sentinel');
  });

  it('relays stream frames under caps and emits a cap control when total bytes are exceeded', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    // Socket.IO is a platform boundary; the server socket testkit provides the minimal real event surface.
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage());
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadSizeBytes: 4 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadSizeBytes: 5 }) },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: expect.objectContaining({ kind: 'frame' }),
    }));
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'max_total_bytes_exceeded',
    });
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'control',
        control: expect.objectContaining({
          kind: 'pause',
          reasonCode: 'max_total_bytes_exceeded',
        }),
      }),
    }));
  });

  it('rejects server relay start without stream authorization', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', null));

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'invalid_live_stream_payload',
    });
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
  });

  it('rejects server relay authorization bound to another account', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    const authorization = relayAuthorization();
    await handler(startMessage('stream_1', {
      ...authorization,
      payload: {
        ...authorization.payload,
        accountId: 'other-user',
      },
    }));

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_authorization_mismatch',
    });
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
  });

  it('rejects self-asserted relay authorization objects', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', selfAssertedRelayAuthorization()));

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'invalid_live_stream_payload',
    });
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
  });

  it('rejects forged signed relay authorization before opening relay state', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const forgedAuthorization = {
      ...relayAuthorization(),
      signature: {
        keyId: 'relay-key-1',
        alg: 'Ed25519',
        valueBase64Url: Buffer.from(new Uint8Array(tweetnacl.sign.signatureLength)).toString('base64url'),
      },
    } as const;
    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', forgedAuthorization));

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_authorization_bad_signature',
    });
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
  });

  it('rejects a viewer grant whose signed viewerSocketId payload is tampered', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const caps = liveStreamCaps({ maxTotalBytes: 1_000 });
    const authorization = viewerRelayAuthorization('viewer-socket-1', 'stream_1', caps);

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-2',
      message: {
        kind: 'start',
        startRequest: {
          v: 1,
          streamId: 'stream_1',
          streamFamily: 'screen',
          routeKind: 'server_relay',
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          viewerSocketId: 'viewer-socket-2',
          ...caps,
          authorization: {
            ...authorization,
            payload: {
              ...authorization.payload,
              viewerSocketId: 'viewer-socket-2',
            },
          },
        },
      },
    });

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_authorization_bad_signature',
    });
    expect(to).not.toHaveBeenCalledWith('viewer-socket-2');
  });

  it('rejects frame payloads whose advisory size understates decoded bytes', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage());
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'frame',
        frame: frame({
          payloadBase64: payloadBase64ForBytes(64),
          payloadSizeBytes: 1,
        }),
      },
    });

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'invalid_live_stream_payload',
    });
    expect(emit).not.toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({ kind: 'frame' }),
    }));
  });

  it('emits bandwidth capped receipts when relay window pressure drops deltas', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 1,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, ctx);

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 3, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    expect(socketEmit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'receipt',
        receipt: expect.objectContaining({
          id: PEER_MEDIATION_RECEIPTS.streamBandwidthCapped,
          streamId: 'stream_1',
          routeKind: 'server_relay',
          reasonCode: 'relay_window_pressure',
          framesDropped: 1,
          bytesDropped: 3,
        }),
      }),
    }));
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);
    expect(JSON.stringify(socketEmit.mock.calls)).not.toContain('payloadBase64');
  });

  it('throttles repeated bandwidth capped receipts within the cap interval', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 1,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, ctx);

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 3, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 4, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    const cappedReceipts = socketEmit.mock.calls.filter(([, payload]) =>
      JSON.stringify(payload).includes(PEER_MEDIATION_RECEIPTS.streamBandwidthCapped),
    );
    expect(cappedReceipts).toHaveLength(1);
  });

  it('drains queued relay frames only after a target ack advertises credit', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceEmit = vi.fn();
    const targetEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);

    const targetHandler = getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await targetHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'ack',
          nextSequence: 2,
          windowFrames: 1,
          windowBytes: 1_000,
        },
      },
    });

    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1, 2]);
  });

  it('routes typed sideband input control from the target machine to the source machine', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const targetSocket = createFakeSocket({ emit: vi.fn(), id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, ctx);

    await getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }),
    );
    await getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'sideband_control',
        control: {
          v: 1,
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'tap_1',
          leaseId: 'lease_1',
          kind: 'tap',
          x: 0.25,
          y: 0.75,
        },
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'sideband_control',
        control: expect.objectContaining({ kind: 'tap', eventId: 'tap_1' }),
      }),
    }));
  });

  it('reports live_stream_start_required for legacy target ack controls without relay state', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const targetEmit = vi.fn();
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };

    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    await getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'ack',
          nextSequence: 2,
          windowFrames: 1,
          windowBytes: 1_000,
        },
      },
    });

    expect(targetEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_start_required',
    });
    expect(to).not.toHaveBeenCalled();
  });

  it('preserves legacy target-machine controls without relay state by forwarding them to the source machine', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const targetEmit = vi.fn();
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };

    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    await getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'stop',
          reasonCode: 'target_stopped',
        },
      },
    });

    expect(targetEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_control_required',
    }));
    expect(to).toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'control',
        control: expect.objectContaining({ kind: 'stop', reasonCode: 'target_stopped' }),
      }),
    }));
  });

  it('ignores stale target ack controls without draining queued frames', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceEmit = vi.fn();
    const targetEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    const targetHandler = getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await targetHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'ack',
          nextSequence: 1,
          windowFrames: 1,
          windowBytes: 1_000,
        },
      },
    });

    expect(targetEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'stale_live_stream_ack',
    });
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);
  });

  it('closes relay state and refuses to drain queued frames after authorization expiry', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceEmit = vi.fn();
    const targetEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };
    let nowMs = 1_000;
    const caps = liveStreamCaps({ maxTotalBytes: 1_000 });
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => nowMs,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(startMessage('stream_1', relayAuthorization('stream_1', caps, { exp: 1_500 }), {
      maxTotalBytes: 1_000,
    }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);

    nowMs = 1_600;
    const targetHandler = getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await targetHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'ack',
          nextSequence: 2,
          windowFrames: 1,
          windowBytes: 1_000,
        },
      },
    });

    expect(targetEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_authorization_expired',
    });
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);
  });

  it('notifies the minted viewer socket when a viewer-targeted stream expires on frame ingress', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const viewerSocket = createFakeSocket({ emit: vi.fn(), id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    let nowMs = 1_000;
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => nowMs,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage(
      'viewer-socket-1',
      'stream_1',
      { maxTotalBytes: 1_000 },
      { exp: 1_100 },
    ));

    nowMs = 1_101;
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_authorization_expired',
    });
    expect(to).toHaveBeenCalledWith('viewer-socket-1');
    expect(emitByRoom.get('viewer-socket-1')).toHaveBeenCalledWith(
      MACHINE_LIVE_STREAM_SOCKET_EVENT,
      expect.objectContaining({
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        viewerSocketId: 'viewer-socket-1',
        message: {
          kind: 'control',
          control: expect.objectContaining({
            kind: 'stop',
            streamId: 'stream_1',
            reasonCode: 'live_stream_authorization_expired',
          }),
        },
      }),
    );
  });

  it('requests keyframe resync when relay pressure leaves no keyframe', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 1,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, ctx);

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1', undefined, { maxTotalBytes: 1_000 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 3, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'control',
        control: expect.objectContaining({
          kind: 'keyframe_required',
          reasonCode: 'relay_window_pressure',
        }),
      }),
    }));
  });

  it('requires a live-stream start before relaying frames', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    // Socket.IO is a platform boundary; the server socket testkit provides the minimal real event surface.
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadSizeBytes: 4 }) },
    });

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_start_required',
    });
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
  });

  it('enforces concurrent stream caps per source socket', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    // Socket.IO is a platform boundary; the server socket testkit provides the minimal real event surface.
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' });
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxConcurrentStreamsPerSocket: 1,
      },
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage('stream_1'));
    await handler(startMessage('stream_2'));

    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'max_concurrent_streams_per_socket_exceeded',
    });
  });

  it('enforces concurrent stream caps when another socket tries to attach to stale stream state', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();
    const firstSocket = createFakeSocket({ emit: firstEmit, id: 'source-socket-1' });
    firstSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const secondSocket = createFakeSocket({ emit: secondEmit, id: 'source-socket-2' });
    secondSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxConcurrentStreamsPerAccount: 1,
        maxConcurrentStreamsPerSocket: 1,
        maxConcurrentStreamsPerMachine: 1,
      },
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', firstSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', secondSocket as unknown as LiveStreamRelaySocket, ctx);

    await getSocketHandler(firstSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage('stream_1'));
    await getSocketHandler(secondSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage('stream_1'));

    expect(secondEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'max_concurrent_streams_per_account_exceeded',
    });
  });

  it('prunes expired stream state before running concurrency checks for a replacement start', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();
    const firstSocket = createFakeSocket({ emit: firstEmit, id: 'source-socket-1' });
    firstSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const secondSocket = createFakeSocket({ emit: secondEmit, id: 'source-socket-2' });
    secondSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    let nowMs = 1_000;
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxConcurrentStreamsPerAccount: 1,
        maxConcurrentStreamsPerSocket: 1,
        maxConcurrentStreamsPerMachine: 1,
      },
      relayAuthorizationTrustRoots,
      nowMs: () => nowMs,
    };

    machineLiveStreamRelayHandler('user-1', firstSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', secondSocket as unknown as LiveStreamRelaySocket, ctx);

    await getSocketHandler(firstSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      startMessage('stream_1', relayAuthorization('stream_1', liveStreamCaps(), { exp: 1_100 })),
    );
    nowMs = 1_101;
    await getSocketHandler(secondSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      startMessage('stream_1', relayAuthorization('stream_1', liveStreamCaps(), { iat: 1_100, exp: 2_000 })),
    );

    expect(secondEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'max_concurrent_streams_per_account_exceeded',
    });
    expect(secondEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: expect.stringMatching(/concurrent/),
    }));
  });

  it('does not count expired streams against concurrency caps for a different stream id', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const to = vi.fn(() => ({ emit: vi.fn() }));
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();
    const firstSocket = createFakeSocket({ emit: firstEmit, id: 'source-socket-1' });
    firstSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    const secondSocket = createFakeSocket({ emit: secondEmit, id: 'source-socket-2' });
    secondSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };
    let nowMs = 1_000;
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxConcurrentStreamsPerAccount: 1,
        maxConcurrentStreamsPerSocket: 1,
        maxConcurrentStreamsPerMachine: 1,
      },
      relayAuthorizationTrustRoots,
      nowMs: () => nowMs,
    };

    machineLiveStreamRelayHandler('user-1', firstSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', secondSocket as unknown as LiveStreamRelaySocket, ctx);

    await getSocketHandler(firstSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      startMessage('stream_1', relayAuthorization('stream_1', liveStreamCaps(), { exp: 1_100 })),
    );
    nowMs = 1_101;
    await getSocketHandler(secondSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      startMessage('stream_2', relayAuthorization('stream_2', liveStreamCaps(), { iat: 1_100, exp: 2_000 })),
    );

    expect(secondEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: expect.stringMatching(/concurrent/),
    }));
  });

  it('delivers viewer-targeted frames to the per-tab viewer socket, not the target machine room', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    expect(to).toHaveBeenCalledWith('viewer-socket-1');
    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({ kind: 'frame' }),
    }));
  });

  it('fails closed instead of relaying viewer-path controls to the source machine room when viewerSocketId is missing', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    await getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'pause',
          reasonCode: 'viewer_unreachable',
        },
      },
    });

    expect(to).not.toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'viewer_socket_required',
    });
    expect(sourceEmit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'receipt',
        receipt: expect.objectContaining({
          routeKind: 'server_relay',
          flowKind: 'live_stream',
          reasonCode: 'viewer_socket_required',
        }),
      }),
    }));
  });

  it('fails closed instead of delivering no-state self-target controls to an envelope viewerSocketId', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    await getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      viewerSocketId: 'viewer-socket-evil',
      message: {
        kind: 'control',
        control: {
          v: 1,
          streamId: 'stream_1',
          kind: 'pause',
          reasonCode: 'viewer_unreachable',
        },
      },
    });

    expect(to).not.toHaveBeenCalledWith('viewer-socket-evil');
    expect(to).not.toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'viewer_socket_required',
    });
  });

  it('fails closed instead of relaying source controls to a target machine after viewer state is gone', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const viewerSocket = createFakeSocket({ emit: vi.fn(), id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    getSocketHandler(viewerSocket, 'disconnect')();
    to.mockClear();
    sourceEmit.mockClear();

    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'pause', reasonCode: 'viewer_unreachable' },
      },
    });

    expect(to).not.toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'live_stream_start_required',
    });
  });

  it('fails closed instead of relaying viewer-path frames to the source machine room when viewerSocketId is missing', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    });

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(selfTargetStartMessage('stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    expect(to).not.toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(emitByRoom.get('machine:machine-source:user-1')).toBeUndefined();
    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'viewer_socket_required',
    });
    expect(sourceEmit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'receipt',
        receipt: expect.objectContaining({
          streamId: 'stream_1',
          routeKind: 'server_relay',
          flowKind: 'live_stream',
          reasonCode: 'viewer_socket_required',
        }),
      }),
    }));
  });

  it('emits viewer_socket_required when an ack-drained self-target frame cannot reach a viewer', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
    });

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(selfTargetStartMessage('stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 1, windowFrames: 0, windowBytes: 1_000 },
      },
    });
    sourceEmit.mockClear();
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    sourceEmit.mockClear();

    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-source',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 1, windowFrames: 1, windowBytes: 1_000 },
      },
    });

    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-live-stream',
      error: 'viewer_socket_required',
    });
    expect(sourceEmit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, expect.objectContaining({
      message: expect.objectContaining({
        kind: 'receipt',
        receipt: expect.objectContaining({
          streamId: 'stream_1',
          reasonCode: 'viewer_socket_required',
        }),
      }),
    }));
  });

  it('routes cap-failure controls to the server-held viewer socket, not a self-asserted envelope socket', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const socket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 5 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 5 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-2',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 6 }) },
    });

    expect(to).toHaveBeenCalledWith('viewer-socket-1');
    expect(to).not.toHaveBeenCalledWith('viewer-socket-2');
    expect(emitByRoom.get('viewer-socket-1')).toHaveBeenCalledWith(
      MACHINE_LIVE_STREAM_SOCKET_EVENT,
      expect.objectContaining({
        viewerSocketId: 'viewer-socket-1',
        message: expect.objectContaining({
          kind: 'control',
          control: expect.objectContaining({
            kind: 'pause',
            reasonCode: 'max_total_bytes_exceeded',
          }),
        }),
      }),
    );
  });

  it('accepts ack/control from a user-scoped viewer socket without machine scoping', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const viewerEmit = vi.fn();
    const viewerSocket = createFakeSocket({ emit: viewerEmit, id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    // Only the first keyframe drains until the viewer advertises credit.
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);

    // The viewer (a user-scoped socket whose id matches the minted viewerSocketId) acks.
    const viewerHandler = getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await viewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });

    expect(viewerEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'machine_scoped_socket_required',
    }));
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1, 2]);
  });

  it('rejects ack/control from a different viewer tab than the one minted for the stream', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const wrongViewerEmit = vi.fn();
    const wrongViewerSocket = createFakeSocket({ emit: wrongViewerEmit, id: 'viewer-socket-2' });
    wrongViewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', wrongViewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    const wrongViewerHandler = getSocketHandler(wrongViewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await wrongViewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-2',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });

    expect(wrongViewerEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_ack_required',
    }));
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1]);
  });

  it('rejects stop/control from a different viewer tab without closing the stream', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const viewerEmit = vi.fn();
    const viewerSocket = createFakeSocket({ emit: viewerEmit, id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    const wrongViewerEmit = vi.fn();
    const wrongViewerSocket = createFakeSocket({ emit: wrongViewerEmit, id: 'viewer-socket-2' });
    wrongViewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', wrongViewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    const wrongViewerHandler = getSocketHandler(wrongViewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await wrongViewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-2',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'stolen-tab-stop' },
      },
    });

    expect(wrongViewerEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_control_required',
    }));

    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });
    const viewerHandler = getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await viewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });

    expect(viewerEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'live_stream_start_required',
    }));
    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1, 2]);
  });

  it('rejects ack/control from the target machine for a viewer-minted stream', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const targetEmit = vi.fn();
    const targetSocket = createFakeSocket({ emit: targetEmit, id: 'target-socket' });
    targetSocket.data = { clientType: 'machine-scoped', machineId: 'machine-target' };
    const viewerSocket = createFakeSocket({ emit: vi.fn(), id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', targetSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadKind: 'image_delta', payloadSizeBytes: 3 }) },
    });

    const targetHandler = getSocketHandler(targetSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await targetHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });
    await targetHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'target-machine-stop' },
      },
    });

    expect(targetEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_ack_required',
    }));
    expect(targetEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_control_required',
    }));

    const viewerHandler = getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await viewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });

    expect(emittedFrames(emit).map((sentFrame) => sentFrame.sequence)).toEqual([1, 2]);
  });

  it('reports live_stream_start_required for viewer controls after relay state is gone', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const viewerEmit = vi.fn();
    const viewerSocket = createFakeSocket({ emit: viewerEmit, id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };

    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const viewerHandler = getSocketHandler(viewerSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await viewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'ack', nextSequence: 2, windowFrames: 1, windowBytes: 1_000 },
      },
    });
    await viewerHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: {
        kind: 'sideband_control',
        control: {
          v: 1,
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'tap_1',
          leaseId: 'lease_1',
          kind: 'tap',
          x: 0.25,
          y: 0.75,
        },
      },
    });

    expect(viewerEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'live_stream_start_required',
    }));
    expect(viewerEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_ack_required',
    }));
    expect(viewerEmit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'target_machine_control_required',
    }));
  });

  it('tears down a viewer-targeted stream when the minted viewer socket disconnects', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceEmit = vi.fn();
    const sourceSocket = createFakeSocket({ emit: sourceEmit, id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const viewerSocket = createFakeSocket({ emit: vi.fn(), id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);

    const sourceHandler = getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await sourceHandler(viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }));

    getSocketHandler(viewerSocket, 'disconnect')();

    expect(to).toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(emitByRoom.get('machine:machine-source:user-1')).toHaveBeenCalledWith(
      MACHINE_LIVE_STREAM_SOCKET_EVENT,
      expect.objectContaining({
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        viewerSocketId: 'viewer-socket-1',
        message: {
          kind: 'control',
          control: expect.objectContaining({
            kind: 'stop',
            streamId: 'stream_1',
            reasonCode: 'viewer_disconnected',
          }),
        },
      }),
    );

    await sourceHandler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-socket-1',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    expect(sourceEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({
      error: 'live_stream_start_required',
    }));
  });

  it('notifies the minted viewer socket when the source machine disconnects', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const sourceSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    sourceSocket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };
    const viewerSocket = createFakeSocket({ emit: vi.fn(), id: 'viewer-socket-1' });
    viewerSocket.data = { clientType: 'user-scoped' };
    const ctx = {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    };

    machineLiveStreamRelayHandler('user-1', sourceSocket as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', viewerSocket as unknown as LiveStreamRelaySocket, ctx);

    await getSocketHandler(sourceSocket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(
      viewerStartMessage('viewer-socket-1', 'stream_1', { maxTotalBytes: 1_000 }),
    );

    getSocketHandler(sourceSocket, 'disconnect')();

    expect(to).toHaveBeenCalledWith('viewer-socket-1');
    expect(emitByRoom.get('viewer-socket-1')).toHaveBeenCalledWith(
      MACHINE_LIVE_STREAM_SOCKET_EVENT,
      expect.objectContaining({
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        viewerSocketId: 'viewer-socket-1',
        message: {
          kind: 'control',
          control: expect.objectContaining({
            kind: 'stop',
            streamId: 'stream_1',
            reasonCode: 'socket_disconnected',
          }),
        },
      }),
    );
  });

  it('isolates two viewer tabs so each receives only its own stream', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitByRoom = new Map<string, ReturnType<typeof vi.fn>>();
    const to = vi.fn((room: string) => {
      let emit = emitByRoom.get(room);
      if (!emit) {
        emit = vi.fn();
        emitByRoom.set(room, emit);
      }
      return { emit };
    });
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to },
      serverRoutedLiveStreamEnabled: true,
      relayCaps: {
        ...relayCaps,
        maxConcurrentStreamsPerSocket: 2,
        maxConcurrentStreamsPerAccount: 2,
        maxConcurrentStreamsPerMachine: 2,
        maxTotalBytes: 1_000,
      },
      relayAuthorizationTrustRoots,
      verifyViewerSocketOwnership: verifyUserOneViewerSocketOwnership,
      nowMs: () => 1_000,
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(viewerStartMessage('viewer-tab-a', 'stream_a', { maxTotalBytes: 1_000 }));
    await handler(viewerStartMessage('viewer-tab-b', 'stream_b', { maxTotalBytes: 1_000 }));
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-tab-a',
      message: { kind: 'frame', frame: frame({ streamId: 'stream_a', sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      viewerSocketId: 'viewer-tab-b',
      message: { kind: 'frame', frame: frame({ streamId: 'stream_b', sequence: 1, payloadKind: 'image_keyframe', payloadSizeBytes: 3 }) },
    });

    const tabAFrames = emittedFrames(emitByRoom.get('viewer-tab-a') ?? vi.fn());
    const tabBFrames = emittedFrames(emitByRoom.get('viewer-tab-b') ?? vi.fn());
    expect(tabAFrames.map((f) => f.streamId)).toEqual(['stream_a']);
    expect(tabBFrames.map((f) => f.streamId)).toEqual(['stream_b']);
  });
});
