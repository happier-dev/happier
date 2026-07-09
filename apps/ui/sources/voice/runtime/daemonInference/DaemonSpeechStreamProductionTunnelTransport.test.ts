import {
  PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
  PEER_MEDIATION_RECEIPTS,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_STREAM_PATH,
  type PeerTcpTunnelRelayAuthorizationV1,
  type PeerRouteNonceProofV1,
  type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());
const resolveRuntimeFeatureDecisionMock = vi.hoisted(() => vi.fn());
const resolvePeerLoopbackRouteAvailabilityMock = vi.hoisted(() => vi.fn());
const openPeerTcpTunnelMock = vi.hoisted(() => vi.fn());
const resolveTargetServerMock = vi.hoisted(() => vi.fn());
const readEndpointFromMachineStateMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const storageGetStateMock = vi.hoisted(() => vi.fn());
const createServerScopedRelaySocketMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
  getReadyServerFeatures: (...args: any[]) => getReadyServerFeaturesMock(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  },
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  resolveRuntimeFeatureDecision: (...args: any[]) => resolveRuntimeFeatureDecisionMock(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/loopback/resolvePeerLoopbackRouteAvailability', () => ({
  resolvePeerLoopbackRouteAvailability: (...args: any[]) => resolvePeerLoopbackRouteAvailabilityMock(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/tunnel/client', () => ({
  openPeerTcpTunnel: (...args: any[]) => openPeerTcpTunnelMock(...args),
}));

vi.mock('@/sync/domains/machines/peer/mediation/stream/productionRouteHttp', () => ({
  resolveTargetServer: (...args: any[]) => resolveTargetServerMock(...args),
  readEndpointFromMachineState: (...args: any[]) => readEndpointFromMachineStateMock(...args),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: {
    getCredentialsForServerUrl: (...args: any[]) => getCredentialsForServerUrlMock(...args),
  },
  isLegacyAuthCredentials: () => true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => storageGetStateMock(),
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRelaySocket', () => ({
  createServerScopedRelaySocket: (...args: unknown[]) => createServerScopedRelaySocketMock(...args),
}));

describe('DaemonSpeechStreamProductionTunnelTransport', () => {
  const grant = {
    payload: {
      grantId: 'grant-1',
    },
  } as unknown as SignedDirectRouteGrantV1;
  const nonceProof = {
    v: 1,
    grantId: 'grant-1',
    routeKind: 'loopback_direct',
    flowKind: 'tcp_tunnel',
    endpointFingerprint: 'fingerprint-1',
    nonceBase64Url: 'nonce',
    signatureBase64Url: 'signature',
  } satisfies PeerRouteNonceProofV1;

  beforeEach(() => {
    vi.resetModules();
    getReadyServerFeaturesMock.mockReset();
    resolveRuntimeFeatureDecisionMock.mockReset();
    resolvePeerLoopbackRouteAvailabilityMock.mockReset();
    openPeerTcpTunnelMock.mockReset();
    resolveTargetServerMock.mockReset();
    readEndpointFromMachineStateMock.mockReset();
    getCredentialsForServerUrlMock.mockReset();
    storageGetStateMock.mockReset();
    createServerScopedRelaySocketMock.mockReset();
    vi.unstubAllGlobals();

    resolveTargetServerMock.mockReturnValue({
      serverId: 'server-1',
      serverUrl: 'https://relay.test',
    });
    readEndpointFromMachineStateMock.mockReturnValue({
      url: 'http://127.0.0.1:39001/peer-mediation/v1/probe',
      endpointFingerprint: 'fingerprint-1',
    });
    storageGetStateMock.mockReturnValue({
      profile: { id: 'user-1' },
      machineListByServerId: {
        'server-1': [{
          id: 'machine-1',
          daemonState: {
            httpPort: 3005,
          },
        }],
      },
      machines: {},
    });
    getCredentialsForServerUrlMock.mockResolvedValue({
      token: 'token-1',
      secret: 'seed',
    });
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
            machines: {
              tunnel: {
                enabled: true,
                directPeer: { enabled: true },
                serverRouted: { enabled: true },
              },
              liveStream: {
                enabled: true,
                directPeer: { enabled: true },
                serverRouted: { enabled: true },
              },
            },
          },
          capabilities: {
            machines: {
              tunnel: {
            directPeer: {
              allowedPorts: [3005],
              maxIdleMs: 30_000,
              maxDurationMs: 300_000,
            },
                serverRouted: {
                  supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
                },
              },
              liveStream: {
                serverRouted: {
                  caps: {
                    maxBitrateBps: 128_000,
                    maxFramesPerSecond: 50,
                    maxFrameBytes: 8_192,
                    maxDurationMs: 60_000,
                    maxTotalBytes: 960_000,
                    maxConcurrentStreamsPerAccount: 2,
                    maxConcurrentStreamsPerSocket: 1,
                    maxConcurrentStreamsPerMachine: 2,
                  },
                  disabledReason: null,
                },
              },
            },
          },
        });
    resolveRuntimeFeatureDecisionMock.mockResolvedValue({
      featureId: 'machines.tunnel.directPeer',
      state: 'enabled',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime', serverId: 'server-1' },
    });
    resolvePeerLoopbackRouteAvailabilityMock.mockResolvedValue({
      kind: 'selected',
      receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
      routeKind: 'loopback_direct',
      flowKind: 'tcp_tunnel',
      endpointFingerprint: 'fingerprint-1',
      grant,
      nonceProof,
    });
  });

  it('opens a binary_frame_v2 direct tunnel and sends PCM through the tunnel stream', async () => {
    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: Readonly<{
        v: 1;
        kind: 'data';
        tunnelId: string;
        direction: 'daemon_to_client';
        sequence: number;
        payloadBase64: string;
      }>;
    }>) => void) | null = null;
    const sendSubstreamDataFrame = vi.fn(async (
      substreamId: string,
      frame: Readonly<{ tunnelId: string; sequence: number }>,
    ) => {
      queueMicrotask(() => {
        substreamHandler?.({
          substreamId,
          frame: {
            v: 1,
            kind: 'data',
            tunnelId: frame.tunnelId,
            direction: 'daemon_to_client',
            sequence: frame.sequence,
            payloadBase64: encodeBase64(new TextEncoder().encode(JSON.stringify({
              ok: true,
              streamId: 'stream-1',
              generation: 7,
              ackSeq: frame.sequence,
              events: [],
            }))),
          },
        });
      });
    });
    const sendSubstreamFrame = vi.fn();
    const close = vi.fn();
    openPeerTcpTunnelMock.mockImplementation(async (input) => ({
      ok: true,
      routeKind: 'loopback_direct',
      response: {
        v: 1,
        tunnelId: input.open.tunnelId,
        streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        initialWindowBytes: 1024 * 1024,
        maxFrameBytes: 64 * 1024,
      },
      stream: {
        sendFrame: vi.fn(),
        onFrame: vi.fn(() => () => {}),
        sendSubstreamOpen: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame,
        onSubstreamFrame: vi.fn((handler) => {
          substreamHandler = handler;
          return () => {
            if (substreamHandler === handler) substreamHandler = null;
          };
        }),
        close,
      },
    }));
    const compatibilityTransport = {
      start: vi.fn(async (payload) => ({
        ok: true as const,
        requestId: payload.requestId,
        streamId: 'stream-1',
        generation: 7,
        ackSeq: -1,
        format: payload.format,
      })),
      chunk: vi.fn(),
      finish: vi.fn(async (payload) => ({
        ok: true as const,
        streamId: payload.streamId,
        generation: payload.generation,
        ackSeq: payload.finalSeq,
        finalText: 'hello',
        language: 'en',
        modelPackId: 'stt-pack-1',
        events: [],
      })),
      cancel: vi.fn(),
    };

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        sessionId: 'voice-home-session',
        machineId: 'machine-1',
        basePath: '/voice-home',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport,
    });

    expect(selection).not.toBeNull();
    expect(openPeerTcpTunnelMock).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        tunnelId: 'voice-stt:machine-1:request-1',
        routeKind: 'loopback_direct',
        destination: { host: '127.0.0.1', port: 3005 },
        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
        allowV1Fallback: false,
        grant,
        nonceProof,
      }),
    }));

    const carrierFrame = selection!.carrierAdapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 7,
      seq: 0,
      pcm16Bytes: new Uint8Array([1, 2, 3]),
    });
    expect(carrierFrame).toMatchObject({
      kind: 'binary_tunnel_frame_v2',
      frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    });

    await expect(selection!.transport.chunk({
      streamId: 'stream-1',
      generation: 7,
      seq: 0,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      events: [],
    });

    expect(compatibilityTransport.chunk).not.toHaveBeenCalled();
    expect(sendSubstreamDataFrame).toHaveBeenCalledWith(
      'daemon.voiceInference.stt.stream-1.7',
      {
        tunnelId: 'voice-stt:machine-1:request-1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBytes: new Uint8Array([1, 2, 3]),
      },
    );
    expect(sendSubstreamFrame).not.toHaveBeenCalled();

    await selection!.transport.finish({
      streamId: 'stream-1',
      generation: 7,
      finalSeq: 0,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns null without opening a tunnel when the target server cannot be resolved', async () => {
    resolveTargetServerMock.mockReturnValue(null);

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        sessionId: 'voice-home-session',
        machineId: 'machine-1',
        basePath: '/voice-home',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport: {
        start: vi.fn(),
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    expect(selection).toBeNull();
    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });

  it('opens a binary_frame_v2 server-relay tunnel with relay authorization when direct route is unavailable', async () => {
    resolvePeerLoopbackRouteAvailabilityMock.mockResolvedValue({
      kind: 'fallback',
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'topology_unavailable',
    });
    resolveRuntimeFeatureDecisionMock.mockImplementation(async ({ featureId }: { featureId: string }) => ({
      featureId,
      state: 'enabled',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime', serverId: 'server-1' },
    }));
    const relayAuthorization = {
      payload: {
        v: 1,
        grantId: 'relay-grant-1',
        accountId: 'user-1',
        targetMachineId: 'machine-1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId: 'voice-stt:machine-1:request-1',
        destination: { host: '127.0.0.1', port: 3005 },
        capProfileId: 'default',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 8 * 1024 * 1024,
        iat: 1,
        exp: 60_001,
        aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
      },
      signature: {
        keyId: 'relay-key-1',
        alg: 'Ed25519',
        valueBase64Url: 'signature',
      },
    } satisfies PeerTcpTunnelRelayAuthorizationV1;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        relayAuthorization,
      }),
    })));
    const relayDisconnect = vi.fn();
    createServerScopedRelaySocketMock.mockResolvedValue({
      scopeUserId: 'user-1',
      machineId: 'machine-1',
      sendEnvelope: vi.fn(),
      onEnvelope: vi.fn(() => () => {}),
      disconnect: relayDisconnect,
    });
    const sendSubstreamFrame = vi.fn();
    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: Readonly<{
        v: 1;
        kind: 'data';
        tunnelId: string;
        direction: 'daemon_to_client';
        sequence: number;
        payloadBase64: string;
      }>;
    }>) => void) | null = null;
    const sendSubstreamDataFrame = vi.fn(async (
      substreamId: string,
      frame: Readonly<{ tunnelId: string; sequence: number }>,
    ) => {
      queueMicrotask(() => {
        substreamHandler?.({
          substreamId,
          frame: {
            v: 1,
            kind: 'data',
            tunnelId: frame.tunnelId,
            direction: 'daemon_to_client',
            sequence: frame.sequence,
            payloadBase64: encodeBase64(new TextEncoder().encode(JSON.stringify({
              ok: true,
              streamId: 'stream-1',
              generation: 7,
              ackSeq: frame.sequence,
              events: [],
            }))),
          },
        });
      });
    });
    const close = vi.fn();
    openPeerTcpTunnelMock.mockImplementation(async (input) => ({
      ok: true,
      routeKind: 'server_relay',
      response: {
        v: 1,
        tunnelId: input.open.tunnelId,
        streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        initialWindowBytes: 1024 * 1024,
        maxFrameBytes: relayAuthorization.payload.maxFrameBytes,
      },
      stream: {
        sendFrame: vi.fn(),
        onFrame: vi.fn(() => () => {}),
        sendSubstreamOpen: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame,
        onSubstreamFrame: vi.fn((handler) => {
          substreamHandler = handler;
          return () => {
            if (substreamHandler === handler) substreamHandler = null;
          };
        }),
        close,
      },
    }));
    const compatibilityTransport = {
      start: vi.fn(async (payload) => ({
        ok: true as const,
        requestId: payload.requestId,
        streamId: 'stream-1',
        generation: 7,
        ackSeq: -1,
        format: payload.format,
      })),
      chunk: vi.fn(),
      finish: vi.fn(async (payload) => ({
        ok: true as const,
        streamId: payload.streamId,
        generation: payload.generation,
        ackSeq: payload.finalSeq,
        finalText: 'hello',
        language: 'en',
        modelPackId: 'stt-pack-1',
        events: [],
      })),
      cancel: vi.fn(),
    };

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        sessionId: 'voice-home-session',
        machineId: 'machine-1',
        basePath: '/voice-home',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport,
    });

    expect(selection).not.toBeNull();
    expect(openPeerTcpTunnelMock).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        tunnelId: 'voice-stt:machine-1:request-1',
        routeKind: 'server_relay',
        destination: { host: '127.0.0.1', port: 3005 },
        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
        allowV1Fallback: false,
        relayAuthorization,
      }),
      serverRelayScopeUserId: 'user-1',
      serverRelaySocket: expect.any(Object),
    }));

    const carrierFrame = selection!.carrierAdapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 7,
      seq: 0,
      pcm16Bytes: new Uint8Array([4, 5, 6]),
    });
    await expect(selection!.transport.chunk({
      streamId: 'stream-1',
      generation: 7,
      seq: 0,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      events: [],
    });
    expect(compatibilityTransport.chunk).not.toHaveBeenCalled();
    expect(sendSubstreamDataFrame).toHaveBeenCalledWith(
      'daemon.voiceInference.stt.stream-1.7',
      {
        tunnelId: 'voice-stt:machine-1:request-1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBytes: new Uint8Array([4, 5, 6]),
      },
    );
    expect(sendSubstreamFrame).not.toHaveBeenCalled();

    await selection!.transport.finish({
      streamId: 'stream-1',
      generation: 7,
      finalSeq: 0,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(relayDisconnect).toHaveBeenCalledTimes(1);
  });

  it('does not open a server-relay voice tunnel when daemon voice relay policy is disabled even if generic tunnel relay is enabled', async () => {
    resolvePeerLoopbackRouteAvailabilityMock.mockResolvedValue({
      kind: 'fallback',
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'topology_unavailable',
    });
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
        machines: {
          tunnel: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: true },
          },
          liveStream: {
            enabled: true,
            directPeer: { enabled: true },
            serverRouted: { enabled: false },
          },
        },
      },
      capabilities: {
        machines: {
          tunnel: {
            directPeer: {
              allowedPorts: [3005],
              maxIdleMs: 30_000,
              maxDurationMs: 300_000,
            },
            serverRouted: {
              supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
            },
          },
          liveStream: {
            serverRouted: {
              caps: null,
              disabledReason: 'relay_not_enabled',
            },
          },
        },
      },
    });
    resolveRuntimeFeatureDecisionMock.mockImplementation(async ({ featureId }: { featureId: string }) => ({
      featureId,
      state: featureId === 'machines.liveStream.serverRouted' ? 'disabled' : 'enabled',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime', serverId: 'server-1' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })));

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        sessionId: 'voice-home-session',
        machineId: 'machine-1',
        basePath: '/voice-home',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport: {
        start: vi.fn(),
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    expect(selection).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(createServerScopedRelaySocketMock).not.toHaveBeenCalled();
    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });

  it('returns null for compatibility fallback when the server-relay socket cannot be created', async () => {
    resolvePeerLoopbackRouteAvailabilityMock.mockResolvedValue({
      kind: 'fallback',
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'topology_unavailable',
    });
    resolveRuntimeFeatureDecisionMock.mockImplementation(async ({ featureId }: { featureId: string }) => ({
      featureId,
      state: 'enabled',
      diagnostics: [],
      evaluatedAt: 1,
      scope: { scopeKind: 'runtime', serverId: 'server-1' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        relayAuthorization: {
          payload: {
            v: 1,
            grantId: 'relay-grant-1',
            accountId: 'user-1',
            targetMachineId: 'machine-1',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            tunnelId: 'voice-stt:machine-1:request-1',
            destination: { host: '127.0.0.1', port: 3005 },
            capProfileId: 'default',
            maxFrameBytes: 64 * 1024,
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
            maxTotalBytes: 8 * 1024 * 1024,
            iat: 1,
            exp: 60_001,
            aud: PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
          },
          signature: {
            keyId: 'relay-key-1',
            alg: 'Ed25519',
            valueBase64Url: 'signature',
          },
        },
      }),
    })));
    createServerScopedRelaySocketMock.mockRejectedValue(new Error('relay socket unavailable'));

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    await expect(createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        sessionId: 'voice-home-session',
        machineId: 'machine-1',
        basePath: '/voice-home',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport: {
        start: vi.fn(),
        chunk: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    })).resolves.toBeNull();

    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });
});
