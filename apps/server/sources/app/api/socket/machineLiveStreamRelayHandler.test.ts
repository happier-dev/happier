import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
  PeerMediationObservabilityEventV1Schema,
  createMachineLiveStreamRelayAuthorizationSigningInputV1,
  type MachineLiveStreamWireFrameV1 as MachineLiveStreamFrameV1,
  type PeerMediationObservabilityEventV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import type { machineLiveStreamRelayHandler } from './machineLiveStreamRelayHandler';
import { TEST_MACHINE_INSTALLATION_ID } from '../testkit/machineAdmissionPersistenceBoundary';

vi.mock('@/storage/db', async () => {
  const { createMachineAdmissionPersistenceBoundary } = await import('../testkit/machineAdmissionPersistenceBoundary');
  return { db: createMachineAdmissionPersistenceBoundary('user-1').db };
});

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
    payload: { t: 'plain', v: payloadBase64ForBytes(payloadSizeBytes) },
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

function startMessage(
  streamId = 'stream_1',
  authorization?: ReturnType<typeof relayAuthorization> | null,
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

function liveStreamEvents(emitted: readonly PeerMediationObservabilityEventV1[]): PeerMediationObservabilityEventV1[] {
  return emitted.filter((event) => event.flow.flowKind === 'live_stream');
}

function kindsForStream(emitted: readonly PeerMediationObservabilityEventV1[], streamId: string): string[] {
  return liveStreamEvents(emitted)
    .filter((event) => event.flow.flowId === streamId)
    .map((event) => event.kind);
}

describe('machineLiveStreamRelayHandler observability', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('refuses an invalid receipt before reading its routing data', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'invalid-receipt-source' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };
    const emit = vi.fn();
    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: () => ({ emit }) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true, relayCaps, relayAuthorizationTrustRoots, nowMs: () => 1_000,
    });
    const handle = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await expect(handle({ v: 1, sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      message: { kind: 'receipt', receipt: null },
    })).resolves.toBeUndefined();
    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR,
      expect.objectContaining({ error: 'invalid_live_stream_payload' }));
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not route start responses through consumer control admission', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'start-response-source' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };
    const emit = vi.fn();
    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: () => ({ emit }) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true, relayCaps, relayAuthorizationTrustRoots, nowMs: () => 1_000,
    });
    await expect(getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT)({
      v: 1, sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      message: { kind: 'start_response', startResponse: { v: 1, streamId: 'stream_1', accepted: false, disabledReason: 'unavailable' } },
    })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('rejects raw pixels on an E2EE Account relay before forwarding', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'e2ee-source' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };
    const emit = vi.fn();
    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: () => ({ emit }) },
      resolveAccountEncryptionMode: async () => 'e2ee',
      serverRoutedLiveStreamEnabled: true, relayCaps, relayAuthorizationTrustRoots, nowMs: () => 1_000,
    });
    const handle = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handle(startMessage());
    await handle({ v: 1, sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: {
        v: 1, streamId: 'stream_1', sequence: 1, timestampMs: 1_000,
        payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', payloadBase64: 'AQID', payloadSizeBytes: 3,
      } } });
    expect(emit.mock.calls.filter(([event]) => event === MACHINE_LIVE_STREAM_SOCKET_EVENT)).toEqual([]);
    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ error: 'invalid_live_stream_payload' }));
  });

  it('publishes flow.started then flow.ready when a server relay start is accepted', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

    await getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage());

    const lifecycle = kindsForStream(emitted, 'stream_1');
    expect(lifecycle).toEqual(['flow.started', 'flow.ready']);
    for (const event of liveStreamEvents(emitted)) {
      expect(event.flow).toMatchObject({ flowKind: 'live_stream', flowId: 'stream_1', streamId: 'stream_1' });
      expect(() => PeerMediationObservabilityEventV1Schema.parse(event)).not.toThrow();
    }
  });

  it('routes opaque E2EE frame/input bytes and refuses a plain payload on the admitted Account mode', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const emit = vi.fn();
    const source = createFakeSocket({ emit: vi.fn(), id: 'source-e2ee' });
    source.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };
    const target = createFakeSocket({ emit: vi.fn(), id: 'target-e2ee' });
    target.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-target' };
    const ctx = { io: { to: () => ({ emit }) },
      resolveAccountEncryptionMode: async (): Promise<'e2ee'> => 'e2ee',
      serverRoutedLiveStreamEnabled: true, relayCaps: { ...relayCaps, maxTotalBytes: 4096 },
      relayAuthorizationTrustRoots, nowMs: () => 1_000,
      observability: { emit: (event: PeerMediationObservabilityEventV1) => emitted.push(event) },
    };
    machineLiveStreamRelayHandler('user-1', source as unknown as LiveStreamRelaySocket, ctx);
    machineLiveStreamRelayHandler('user-1', target as unknown as LiveStreamRelaySocket, ctx);
    const handle = getSocketHandler(source, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handle(startMessage('stream_1', undefined, { maxTotalBytes: 4096 }));
    const c = payloadBase64ForBytes(32);
    const wire = { v: 1, sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ payload: { t: 'encrypted', c }, payloadSizeBytes: 32 }) } };
    await handle(wire);
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, wire);
    const input = { ...wire, message: { kind: 'sideband_control', control: {
      v: 1, streamId: 'stream_1', payload: { t: 'encrypted', c },
    } } };
    await getSocketHandler(target, MACHINE_LIVE_STREAM_SOCKET_EVENT)(input);
    expect(emit).toHaveBeenCalledWith(MACHINE_LIVE_STREAM_SOCKET_EVENT, input);
    emit.mockClear();
    await handle({ ...wire, message: { kind: 'frame', frame: frame({ sequence: 2 }) } });
    expect(emit).not.toHaveBeenCalled();
    expect(source.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ error: 'stream_payload_mode_mismatch' }));
    await handle({ ...wire, message: { kind: 'control', control: {
      v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'done',
    } } });
    expect(emitted.find((event) => event.kind === 'flow.closed')?.data).toMatchObject({ bytesRelayed: 32 });
  });

  it('publishes a flow.denied event with the reason code when authorization is forged', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

    const forged = {
      ...relayAuthorization(),
      signature: {
        keyId: 'relay-key-1',
        alg: 'Ed25519',
        valueBase64Url: Buffer.from(new Uint8Array(tweetnacl.sign.signatureLength)).toString('base64url'),
      },
    } as const;
    await getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage('stream_1', forged));

    expect(liveStreamEvents(emitted)).toEqual([
      expect.objectContaining({
        kind: 'flow.denied',
        flow: expect.objectContaining({ flowId: 'stream_1', flowKind: 'live_stream' }),
        data: expect.objectContaining({ reasonCode: 'live_stream_authorization_bad_signature' }),
      }),
    ]);
  });

  it('publishes cap.exceeded with the reason code and server byte counters when a frame trips a cap', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage());
    // First frame (4 bytes) relays under the 8-byte total cap.
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 1, payloadSizeBytes: 4 }) },
    });
    // Second frame (5 bytes) breaches the 8-byte total cap and closes the stream.
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: { kind: 'frame', frame: frame({ sequence: 2, payloadSizeBytes: 5 }) },
    });

    const capEvent = liveStreamEvents(emitted).find((event) => event.kind === 'cap.exceeded');
    expect(capEvent).toBeDefined();
    expect(capEvent?.data).toMatchObject({ reasonCode: 'max_total_bytes_exceeded' });
    expect(capEvent?.data?.bytesOut).toBe(4);
    expect(kindsForStream(emitted, 'stream_1')).toEqual([
      'flow.started',
      'flow.ready',
      'cap.exceeded',
    ]);
  });

  it('publishes flow.closed with the server byte counters on an explicit stop control', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps: { ...relayCaps, maxTotalBytes: 1_000 },
      relayAuthorizationTrustRoots,
      relayWindowFrames: 4,
      relayWindowBytes: 1_000,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

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
      message: {
        kind: 'control',
        control: { v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'viewer_closed' },
      },
    });

    const closeEvent = liveStreamEvents(emitted).find((event) => event.kind === 'flow.closed');
    expect(closeEvent).toBeDefined();
    expect(closeEvent?.data).toMatchObject({ reasonCode: 'viewer_closed', bytesOut: 3 });
    expect(kindsForStream(emitted, 'stream_1')).toContain('flow.closed');
    expect(kindsForStream(emitted, 'stream_1')).not.toContain('flow.errored');
  });

  it('publishes flow.aborted on disconnect with an active stream', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

    await getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage());
    const disconnect = getSocketHandler(socket, 'disconnect');
    disconnect();

    const abortEvent = liveStreamEvents(emitted).find((event) => event.kind === 'flow.aborted');
    expect(abortEvent).toBeDefined();
    expect(abortEvent?.data).toMatchObject({ reasonCode: 'socket_disconnected' });
  });

  it('does not emit observability events when no emitter is injected', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
    });

    // No observability emitter — the start path must not throw and must stay silent.
    await expect(
      getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT)(startMessage()),
    ).resolves.toBeUndefined();
  });

  it('keeps published live_stream events metadata-only with no payload material', async () => {
    const { machineLiveStreamRelayHandler } = await import('./machineLiveStreamRelayHandler');
    const emitted: PeerMediationObservabilityEventV1[] = [];
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' });
    socket.data = { clientType: 'machine-scoped', verifiedMachineInstallationId: TEST_MACHINE_INSTALLATION_ID,
 machineId: 'machine-source' };

    machineLiveStreamRelayHandler('user-1', socket as unknown as LiveStreamRelaySocket, {
      io: { to: vi.fn(() => ({ emit: vi.fn() })) },
      resolveAccountEncryptionMode: async () => 'plain',
      serverRoutedLiveStreamEnabled: true,
      relayCaps,
      relayAuthorizationTrustRoots,
      nowMs: () => 1_000,
      observability: { emit: (event) => emitted.push(event) },
    });

    const handler = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
    await handler(startMessage());
    await handler({
      v: 1,
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      message: {
        kind: 'frame',
        frame: frame({ sequence: 1, payload: { t: 'plain', v: 'c2VudGluZWw=' }, payloadSizeBytes: 8 }),
      },
    });

    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('c2VudGluZWw=');
    expect(serialized).not.toContain('sentinel');
    expect(serialized).not.toContain('relay-grant-stream_1');
    for (const event of liveStreamEvents(emitted)) {
      expect(event.redaction.level).toBe('metadataOnly');
      expect(event.data).not.toHaveProperty('payloadBase64');
    }
  });
});
