import {
  PEER_TCP_TUNNEL_RELAY_AUTHORIZATION_AUDIENCE_V1,
  PEER_MEDIATION_RECEIPTS,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_STREAM_PATH,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  createPeerApplicationAuthorityDigestV1,
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  decodeBase64 as decodeProtocolBase64,
  decodePeerApplicationEncryptedFrameV1,
  deriveBoxPublicKeyFromSeed,
  encodeBase64 as encodeProtocolBase64,
  encodePeerApplicationEncryptedFrameV1,
  openEncryptedDataKeyEnvelopeV1,
  type PeerTcpTunnelRelayAuthorizationV2,
  type PeerRouteNonceProofV1,
  type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';

const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());
const resolveRuntimeFeatureDecisionMock = vi.hoisted(() => vi.fn());
const resolvePeerLoopbackRouteAvailabilityMock = vi.hoisted(() => vi.fn());
const openPeerTcpTunnelMock = vi.hoisted(() => vi.fn());
const resolveTargetServerMock = vi.hoisted(() => vi.fn());
const readEndpointFromMachineStateMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const storageGetStateMock = vi.hoisted(() => vi.fn());
const createServerScopedRelaySocketMock = vi.hoisted(() => vi.fn());
const isLegacyAuthCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
  getReadyServerFeatures: (...args: any[]) => getReadyServerFeaturesMock(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    getSocketId: vi.fn(() => 'relay-socket-1'),
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

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
  return {
    ...actual,
    TokenStorage: {
      ...actual.TokenStorage,
      getCredentialsForServerUrl: (...args: any[]) => getCredentialsForServerUrlMock(...args),
    },
    isLegacyAuthCredentials: (...args: unknown[]) => isLegacyAuthCredentialsMock(...args),
  };
});

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
      flowKind: 'voice_media',
      scope: {
        kind: 'voice_media',
        tunnelId: 'voice-media:machine-1:request-1',
        applicationKind: 'speech_transcription',
        applicationAttemptId: 'request-1',
        applicationAuthorityDigest:
          createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
      },
    },
  } as unknown as SignedDirectRouteGrantV1;
  const nonceProof = {
    v: 1,
    grantId: 'grant-1',
    routeKind: 'loopback_direct',
    flowKind: 'voice_media',
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
    isLegacyAuthCredentialsMock.mockReset();
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
    isLegacyAuthCredentialsMock.mockReturnValue(true);
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
              peerMediation: {
                directRouteGrantProofMintVersions: [],
                tcpTunnelRelayAuthorizationMintVersions: [2],
              },
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
      flowKind: 'voice_media',
      endpointFingerprint: 'fingerprint-1',
      grant,
      nonceProof,
    });
  });

  it('records a failed finish separately from successful local transport close', async () => {
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
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => {
      resolveClose = resolve;
    }));
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
      finish: vi.fn(async () => ({
        ok: false as const,
        error: 'finish failed',
        errorCode: 'internal_error' as const,
      })),
      cancel: vi.fn(),
    };

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const { daemonSpeechStreamDiagnostics } = await import('./daemonSpeechStreamDiagnostics');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        machineId: 'machine-1',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport,
    });

    expect(selection).not.toBeNull();
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toEqual({
      routeKind: 'loopback_direct',
      frameEncoding: 'binary_frame_v2',
      carrierKind: 'binary_tunnel_frame_v2',
      streamIdentity: null,
      relayEvidence: 'not_applicable',
      maxAuthenticatedAckSeq: null,
      localTransport: 'open',
      operation: null,
    });
    expect(openPeerTcpTunnelMock).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        tunnelId: 'voice-media:machine-1:request-1',
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
        tunnelId: 'voice-media:machine-1:request-1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBytes: new Uint8Array([1, 2, 3]),
      },
    );
    expect(sendSubstreamFrame).not.toHaveBeenCalled();

    const finishPromise = selection!.transport.finish({
      streamId: 'stream-1',
      generation: 7,
      finalSeq: 0,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
      localTransport: 'open',
      operation: { kind: 'finish', result: 'error' },
    });
    resolveClose();
    await expect(finishPromise).resolves.toMatchObject({ ok: false, error: 'finish failed' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toEqual({
      routeKind: 'loopback_direct',
      frameEncoding: 'binary_frame_v2',
      carrierKind: 'binary_tunnel_frame_v2',
      streamIdentity: null,
      relayEvidence: 'not_applicable',
      maxAuthenticatedAckSeq: null,
      localTransport: 'closed',
      operation: { kind: 'finish', result: 'error' },
    });
  });

  it('records a failed cancel separately from successful local transport close', async () => {
    const close = vi.fn(async () => undefined);
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
        sendSubstreamDataFrame: vi.fn(),
        sendSubstreamFrame: vi.fn(),
        onSubstreamFrame: vi.fn(() => () => {}),
        close,
      },
    }));
    const compatibilityTransport = {
      start: vi.fn(),
      chunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(async () => ({
        ok: false as const,
        error: 'cancel failed',
        errorCode: 'internal_error' as const,
      })),
    };

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const { daemonSpeechStreamDiagnostics } = await import('./daemonSpeechStreamDiagnostics');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        machineId: 'machine-1',
      },
      requestId: 'request-cancel-failed',
      signal: null,
      compatibilityTransport,
    });

    await expect(selection!.transport.cancel({
      streamId: 'stream-1',
      generation: 7,
    })).resolves.toMatchObject({ ok: false, error: 'cancel failed' });

    expect(close).toHaveBeenCalledTimes(1);
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toEqual({
      routeKind: 'loopback_direct',
      frameEncoding: 'binary_frame_v2',
      carrierKind: 'binary_tunnel_frame_v2',
      streamIdentity: null,
      relayEvidence: 'not_applicable',
      maxAuthenticatedAckSeq: null,
      localTransport: 'closed',
      operation: { kind: 'cancel', result: 'error' },
    });
  });

  it('opens the same Voice tunnel with ephemeral V2 proof for data-key credentials', async () => {
    isLegacyAuthCredentialsMock.mockReturnValue(false);
    getCredentialsForServerUrlMock.mockResolvedValue({
      token: 'data-key-token',
      encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
    });
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
        machines: {
          tunnel: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
          liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
        },
      },
      capabilities: {
        machines: {
          peerMediation: {
            directRouteGrantProofMintVersions: [2],
            tcpTunnelRelayAuthorizationMintVersions: [2],
          },
          tunnel: {
            directPeer: { allowedPorts: [3005], maxIdleMs: 30_000, maxDurationMs: 300_000 },
            serverRouted: { supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2] },
          },
          liveStream: { serverRouted: { caps: null, disabledReason: 'disabled' } },
        },
      },
    });
    readEndpointFromMachineStateMock.mockReturnValue({
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:39001/peer-mediation/v1/probe',
      endpointFingerprint: 'fingerprint-1',
      expiresAt: Date.now() + 60_000,
      directRouteGrantProofVerifierVersions: [2],
    });
    const signature64 = Buffer.from(new Uint8Array(64).fill(2)).toString('base64url');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/machines/peer/mediation/route-grants') {
        const body = JSON.parse(String(init?.body)) as { ephemeralPublicKeyBase64Url: string };
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, grant: {
            payload: {
              v: 2, grantId: 'grant-v2', accountId: 'account-1', machineId: 'machine-1',
              flowKind: 'voice_media', routeKind: 'loopback_direct',
              scope: {
                kind: 'voice_media',
                tunnelId: 'voice-media:machine-1:request-v2',
                applicationKind: 'speech_transcription',
                applicationAttemptId: 'request-v2',
                applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
                maxIdleMs: 30_000,
                maxDurationMs: 300_000,
              },
              iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'fingerprint-1',
              proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url,
            },
            signature: { keyId: 'key-1', alg: 'Ed25519', valueBase64Url: signature64 },
          } }),
        } as Response;
      }
      if (path === '/peer-mediation/v2/tunnel/open') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            v: 1, tunnelId: 'voice-media:machine-1:request-v2', streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, initialWindowBytes: 1024 * 1024, maxFrameBytes: 64 * 1024,
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    openPeerTcpTunnelMock.mockImplementation(async (input) => ({
      ok: true,
      routeKind: 'loopback_direct',
      response: await input.postOpen({ open: input.open }),
      stream: {
        sendFrame: vi.fn(), onFrame: vi.fn(() => () => {}), sendSubstreamOpen: vi.fn(),
        sendSubstreamDataFrame: vi.fn(), sendSubstreamFrame: vi.fn(), onSubstreamFrame: vi.fn(() => () => {}), close: vi.fn(),
      },
    }));

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const result = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: { machineId: 'machine-1' },
      requestId: 'request-v2',
      signal: null,
      compatibilityTransport: { start: vi.fn(), chunk: vi.fn(), finish: vi.fn(), cancel: vi.fn() },
    });

    expect(result).not.toBeNull();
    expect(openPeerTcpTunnelMock).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        v: 2,
        grant: expect.objectContaining({ payload: expect.objectContaining({ v: 2 }) }),
        proof: expect.objectContaining({ v: 2, kind: 'ephemeral_ed25519' }),
      }),
    }));
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/machines/peer/mediation/route-grants',
      '/peer-mediation/v2/tunnel/open',
    ]);
    expect(resolvePeerLoopbackRouteAvailabilityMock).not.toHaveBeenCalled();
  });

  it('returns null without opening a tunnel when the target server cannot be resolved', async () => {
    resolveTargetServerMock.mockReturnValue(null);

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        machineId: 'machine-1',
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

  it('reports typed data-key signing unavailability before endpoint lookup, grant, nonce, probe, or tunnel', async () => {
    isLegacyAuthCredentialsMock.mockReturnValue(false);
    getCredentialsForServerUrlMock.mockResolvedValue({
      token: 'data-key-token',
      encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
    });
    readEndpointFromMachineStateMock.mockReturnValue(null);
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
        machines: {
          tunnel: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
          liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } },
        },
      },
      capabilities: {
        machines: {
          peerMediation: {
            directRouteGrantProofMintVersions: [],
            tcpTunnelRelayAuthorizationMintVersions: [2],
          },
          tunnel: {
            directPeer: { allowedPorts: [3005], maxIdleMs: 30_000, maxDurationMs: 300_000 },
            serverRouted: { supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2] },
          },
          liveStream: { serverRouted: { caps: null, disabledReason: 'relay_not_enabled' } },
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
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    await expect(createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: { machineId: 'machine-1' },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport: { start: vi.fn(), chunk: vi.fn(), finish: vi.fn(), cancel: vi.fn() },
    })).rejects.toMatchObject({
      code: 'peer_route_signing_identity_unavailable',
      reasonCode: 'peer_route_signing_identity_unavailable',
      requiredCapability: 'peer_route_signing_identity_v1',
    });

    expect(readEndpointFromMachineStateMock).not.toHaveBeenCalled();
    expect(resolvePeerLoopbackRouteAvailabilityMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });

  it('does not let a missing daemon HTTP port mask typed data-key signing unavailability', async () => {
    isLegacyAuthCredentialsMock.mockReturnValue(false);
    getCredentialsForServerUrlMock.mockResolvedValue({
      token: 'data-key-token',
      encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
    });
    storageGetStateMock.mockReturnValue({
      machines: { 'machine-1': { id: 'machine-1', daemonState: {} } },
      machineListByServerId: {},
    });
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
        machines: {
          tunnel: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
          liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } },
        },
      },
      capabilities: { machines: { tunnel: {}, liveStream: {} } },
    });

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    await expect(createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: { machineId: 'machine-1' },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport: { start: vi.fn(), chunk: vi.fn(), finish: vi.fn(), cancel: vi.fn() },
    })).rejects.toMatchObject({
      reasonCode: 'peer_route_signing_identity_unavailable',
      requiredCapability: 'peer_route_signing_identity_v1',
    });

    expect(readEndpointFromMachineStateMock).not.toHaveBeenCalled();
    expect(resolvePeerLoopbackRouteAvailabilityMock).not.toHaveBeenCalled();
    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });

  it('reports the actual server relay when an advertised direct route falls back at runtime', async () => {
    getReadyServerFeaturesMock.mockResolvedValue({
      features: {
        machines: {
          tunnel: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
          liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } },
        },
      },
      capabilities: {
        machines: {
          peerMediation: {
            directRouteGrantProofMintVersions: [],
            tcpTunnelRelayAuthorizationMintVersions: [2],
          },
          tunnel: {
            directPeer: { allowedPorts: [3005], maxIdleMs: 30_000, maxDurationMs: 300_000 },
            serverRouted: { supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2] },
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
        v: 2,
        grantId: 'relay-grant-1',
        accountId: 'user-1',
        targetMachineId: 'machine-1',
        flowKind: 'voice_media',
        routeKind: 'server_relay',
        tunnelId: 'voice-media:machine-1:request-1',
        applicationKind: 'speech_transcription',
        applicationAttemptId: 'request-1',
        applicationAuthorityDigest:
          createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
        relaySocketId: 'relay-socket-1',
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
    } satisfies PeerTcpTunnelRelayAuthorizationV2;
    const binding = {
      v: 1 as const,
      suite: 'aes-256-gcm' as const,
      flowKind: 'voice_media' as const,
      routeKind: 'server_relay' as const,
      authorityDigest: createPeerApplicationAuthorityDigestV1(relayAuthorization),
      accountId: 'user-1',
      machineId: 'machine-1',
      tunnelId: 'voice-media:machine-1:request-1',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'request-1',
      applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
    };
    const recipientSecretKeySeed = new Uint8Array(32).fill(11);
    const recipientPublicKeyBase64Url = encodeProtocolBase64(
      deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
      'base64url',
    );
    let installedKey: Uint8Array | null = null;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        relayAuthorization,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const relayDisconnect = vi.fn();
    createServerScopedRelaySocketMock.mockResolvedValue({
      scopeUserId: 'user-1',
      machineId: 'machine-1',
      socketId: 'relay-socket-1',
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
      frame: Readonly<{ tunnelId: string; sequence: number; payloadBytes: Uint8Array }>,
    ) => {
      const encrypted = decodePeerApplicationEncryptedFrameV1(frame.payloadBytes);
      if (!encrypted) throw new Error('expected encrypted relay frame');
      if (encrypted.kind === 'install') {
        installedKey = openEncryptedDataKeyEnvelopeV1({
          envelope: decodeProtocolBase64(encrypted.encryptedDataKeyEnvelopeBase64Url!, 'base64url'),
          recipientSecretKeyOrSeed: recipientSecretKeySeed,
        });
      }
      if (!installedKey) throw new Error('expected installed relay content key');
      const requestNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'client_to_daemon', phase: encrypted.kind, sequence: frame.sequence,
      });
      const requestPlaintext = await openAes256GcmBytes({
        key: installedKey,
        nonce: requestNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'client_to_daemon',
          streamId: 'stream-1', generation: 7, substreamId,
          sequence: frame.sequence, phase: encrypted.kind,
        }),
        ciphertext: decodeProtocolBase64(encrypted.ciphertextBase64Url, 'base64url'),
      });
      if (encrypted.kind === 'data') expect([...requestPlaintext]).toEqual([4, 5, 6]);
      const responsePlaintext = encrypted.kind === 'install'
        ? new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1)
        : encrypted.kind === 'finish'
          ? new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 7, ackSeq: 0,
              finalText: 'hello', language: 'en', modelPackId: 'stt-pack-1', events: [],
            }))
          : new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 7, ackSeq: frame.sequence - 1, events: [],
            }));
      const responseNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'daemon_to_client', phase: encrypted.kind, sequence: frame.sequence,
      });
      const responseCiphertext = await sealAes256GcmBytes({
        key: installedKey,
        nonce: responseNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'daemon_to_client',
          streamId: 'stream-1', generation: 7, substreamId,
          sequence: frame.sequence, phase: encrypted.kind,
        }),
        plaintext: responsePlaintext,
      });
      substreamHandler?.({
        substreamId,
        frame: {
          v: 1,
          kind: 'data',
          tunnelId: frame.tunnelId,
          direction: 'daemon_to_client',
          sequence: frame.sequence,
          payloadBase64: encodeBase64(encodePeerApplicationEncryptedFrameV1({
            v: 1,
            kind: encrypted.kind,
            nonceBase64Url: encodeProtocolBase64(responseNonce, 'base64url'),
            ciphertextBase64Url: encodeProtocolBase64(responseCiphertext, 'base64url'),
          })),
        },
      });
    });
    const close = vi.fn();
    openPeerTcpTunnelMock.mockImplementation(async (input) => input.open.routeKind === 'loopback_direct'
      ? { ok: false }
      : ({
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
        peerApplicationEncryption: {
          v: 1 as const,
          suite: 'aes-256-gcm' as const,
          recipientPublicKeyBase64Url,
        },
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
    const { daemonSpeechStreamDiagnostics } = await import('./daemonSpeechStreamDiagnostics');
    const selection = await createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        machineId: 'machine-1',
      },
      requestId: 'request-1',
      signal: null,
      compatibilityTransport,
    });

    expect(selection).not.toBeNull();
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
      routeKind: 'server_relay',
      frameEncoding: 'binary_frame_v2',
      carrierKind: 'binary_tunnel_frame_v2',
      relayEvidence: 'pending',
      localTransport: 'open',
      operation: null,
    });
    expect(readEndpointFromMachineStateMock).toHaveBeenCalled();
    expect(resolvePeerLoopbackRouteAvailabilityMock).toHaveBeenCalled();
    expect(isLegacyAuthCredentialsMock).toHaveBeenCalled();
    expect(openPeerTcpTunnelMock).toHaveBeenCalledTimes(1);
    expect(openPeerTcpTunnelMock).toHaveBeenCalledWith(expect.objectContaining({
      open: expect.objectContaining({
        tunnelId: 'voice-media:machine-1:request-1',
        routeKind: 'server_relay',
        destination: { host: '127.0.0.1', port: 3005 },
        selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
        allowV1Fallback: false,
        relayAuthorization,
      }),
      serverRelayScopeUserId: 'user-1',
      serverRelaySocket: expect.objectContaining({ socketId: 'relay-socket-1' }),
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      v: 2,
      flowKind: 'voice_media',
      relaySocketId: 'relay-socket-1',
      scope: {
        kind: 'voice_media',
        tunnelId: 'voice-media:machine-1:request-1',
      },
    });
    expect(createServerScopedRelaySocketMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    await expect(selection!.transport.start({
      requestId: 'request-1',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'runtime',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    })).resolves.toMatchObject({ ok: true, peerApplicationEncryption: { suite: 'aes-256-gcm' } });
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
      streamIdentity: {
        machineId: 'machine-1',
        packId: 'stt-pack-1',
        streamId: 'stream-1',
        generation: 7,
      },
      relayEvidence: 'key_install_authenticated',
      maxAuthenticatedAckSeq: null,
    });

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
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
      relayEvidence: 'chunk_ack_authenticated',
      maxAuthenticatedAckSeq: 0,
    });
    expect(compatibilityTransport.chunk).not.toHaveBeenCalled();
    expect(sendSubstreamDataFrame).toHaveBeenCalledWith(
      'daemon.voiceInference.stt.stream-1.7',
      expect.objectContaining({
        tunnelId: 'voice-media:machine-1:request-1',
        direction: 'client_to_daemon',
        sequence: 1,
        payloadBytes: expect.any(Uint8Array),
      }),
    );
    expect(sendSubstreamDataFrame.mock.calls[1]?.[1].payloadBytes).not.toEqual(new Uint8Array([4, 5, 6]));
    expect(sendSubstreamFrame).not.toHaveBeenCalled();

    await selection!.transport.finish({
      streamId: 'stream-1',
      generation: 7,
      finalSeq: 0,
    });
    expect(compatibilityTransport.finish).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(relayDisconnect).toHaveBeenCalledTimes(1);
    expect(daemonSpeechStreamDiagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
      routeKind: 'server_relay',
      relayEvidence: 'finish_authenticated',
      maxAuthenticatedAckSeq: 0,
      localTransport: 'closed',
      operation: { kind: 'finish', result: 'ok' },
    });
  });

  it('fails closed when the server does not advertise socket-bound relay authorization minting', async () => {
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
        machineId: 'machine-1',
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
    const fetchMock = vi.fn(async () => ({
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
            tunnelId: 'voice-media:machine-1:request-1',
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
    }));
    vi.stubGlobal('fetch', fetchMock);
    createServerScopedRelaySocketMock.mockRejectedValue(new Error('relay socket unavailable'));

    const { createProductionDaemonSpeechStreamingSttTransport } = await import('./DaemonSpeechStreamProductionTunnelTransport');
    await expect(createProductionDaemonSpeechStreamingSttTransport({
      machineTarget: {
        machineId: 'machine-1',
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

    expect(fetchMock).not.toHaveBeenCalled();
    expect(openPeerTcpTunnelMock).not.toHaveBeenCalled();
  });
});
