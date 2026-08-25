import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  FeaturesResponseSchema,
  type FeaturesResponse,
  type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
} from './startLoopback';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function createServerFeatures(publicKey: Uint8Array, proofMintV2 = false): FeaturesResponse {
  return FeaturesResponseSchema.parse({
    features: {
      machines: {
        enabled: true,
        rpc: {
          enabled: true,
          directPeer: { enabled: true },
        },
        tunnel: {
          enabled: true,
          directPeer: { enabled: true },
          serverRouted: { enabled: false },
        },
        liveStream: {
          enabled: true,
          directPeer: { enabled: true },
        },
      },
    },
    capabilities: {
      machines: {
        peerMediation: {
          grantSigningKeys: [{
            keyId: 'grant-key-1',
            publicKey: toBase64Url(publicKey),
            expiresAt: null,
          }],
          directRouteGrantProofMintVersions: proofMintV2 ? [2] : [],
        },
      },
    },
  });
}

describe('startPeerMediationLoopback', () => {
  it('registers TCP and Voice flows with the same started tunnel endpoint authority', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountSigningSeed = new Uint8Array(32).fill(7);
    let capturedStartOptions: Parameters<NonNullable<
      StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer']
    >>[0] | undefined;
    const startPeerMediationLoopbackServer: StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer'] =
      vi.fn(async (options) => {
        capturedStartOptions = options;
        return {
          app: {} as never,
          url: 'http://127.0.0.1:47001/peer-mediation/v1/probe',
          endpoint: {
            v: 1 as const,
            routeKind: 'loopback_direct' as const,
            url: 'http://127.0.0.1:47001/peer-mediation/v1/probe',
            endpointFingerprint: options.expected.endpointFingerprint,
            expiresAt: options.endpointExpiresAt,
          },
          stop: async () => undefined,
        };
      });

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      accountSigningSeed,
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      tunnel: {},
      nowMs: () => 2_000,
      endpointFingerprint: () => 'endpoint_1',
      startPeerMediationLoopbackServer,
    });

    expect(started?.activeFlows.tcp_tunnel).toBe(true);
    if (!capturedStartOptions) throw new Error('expected loopback server startup options');
    const tcpExpected = capturedStartOptions.expectedByFlow?.tcp_tunnel;
    expect(tcpExpected).toEqual({
      accountId: 'account_1',
      machineId: 'machine_1',
      flowKind: 'tcp_tunnel',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'endpoint_1',
      accountPublicKey: expect.any(String),
    });
    expect(capturedStartOptions.expectedByFlow?.voice_media).toEqual({
      ...tcpExpected,
      flowKind: 'voice_media',
    });
  });

  it('starts a V2 verifier for keyless accounts and advertises it on the endpoint', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const startPeerMediationLoopbackServer = vi.fn(async (options) => ({
      app: {} as never,
      url: 'http://127.0.0.1:47002/peer-mediation/v1/probe',
      endpoint: {
        v: 1 as const,
        routeKind: 'loopback_direct' as const,
        url: 'http://127.0.0.1:47002/peer-mediation/v1/probe',
        endpointFingerprint: options.expected.endpointFingerprint,
        expiresAt: options.endpointExpiresAt,
        directRouteGrantProofVerifierVersions: [2] as 2[],
      },
      stop: async () => undefined,
    }));

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      serverFeatures: createServerFeatures(grantKeyPair.publicKey, true),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => 2_000,
      startPeerMediationLoopbackServer,
    });

    expect(started?.endpoint.directRouteGrantProofVerifierVersions).toEqual([2]);
    expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.objectContaining({
      directRouteGrantProofVerifierVersions: [2],
      expected: expect.not.objectContaining({ accountPublicKey: expect.anything() }),
    }));
  });

  it('generates a fresh endpoint fingerprint for each loopback lifetime', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const capturedFingerprints: string[] = [];
    const startPeerMediationLoopbackServer = vi.fn(async (options) => {
      capturedFingerprints.push(options.expected.endpointFingerprint);
      return {
        app: {} as never,
        url: 'http://127.0.0.1:47001/peer-mediation/v1/probe',
        endpoint: {
          v: 1 as const,
          routeKind: 'loopback_direct' as const,
          url: 'http://127.0.0.1:47001/peer-mediation/v1/probe',
          endpointFingerprint: options.expected.endpointFingerprint,
          expiresAt: options.endpointExpiresAt,
        },
        stop: async () => undefined,
      };
    });
    const input = {
      accountId: 'account_1',
      machineId: 'machine_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: { invokeLocal: async () => ({ ok: true }) },
      nowMs: () => 2_000,
      startPeerMediationLoopbackServer,
    } as const;

    await startPeerMediationLoopback(input);
    await startPeerMediationLoopback(input);

    expect(capturedFingerprints).toHaveLength(2);
    expect(capturedFingerprints[0]).not.toBe(capturedFingerprints[1]);
  });

  it('does not register direct live-stream routes on the production loopback listener without a capture adapter', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountSigningSeed = new Uint8Array(32).fill(7);
    const endpoint: PeerLoopbackEndpointCandidateV1 = {
      v: 1,
      routeKind: 'loopback_direct',
      url: 'http://127.0.0.1:47001/peer-mediation/v1/probe',
      endpointFingerprint: 'endpoint_1',
      expiresAt: 302_000,
    };
    const captured: { startOptions?: Parameters<NonNullable<
      StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer']
    >>[0] } = {};
    const startPeerMediationLoopbackServer: StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer'] =
      vi.fn(async (options) => {
        captured.startOptions = options;
        return {
          app: {} as never,
          url: endpoint.url,
          endpoint,
          stop: async () => undefined,
        };
      });

    const started = await startPeerMediationLoopback({
      accountId: 'account_1',
      machineId: 'machine_1',
      accountSigningSeed,
      serverFeatures: createServerFeatures(grantKeyPair.publicKey),
      rpcHandlerManager: {
        invokeLocal: async () => ({ ok: true }),
      },
      nowMs: () => 2_000,
      endpointFingerprint: () => 'endpoint_1',
      startPeerMediationLoopbackServer,
    });

    expect(started?.endpoint).toEqual(endpoint);
    if (!captured.startOptions) throw new Error('expected loopback server startup options');
    const capturedStartOptions = captured.startOptions;
    expect(capturedStartOptions).toEqual(expect.objectContaining({
      expected: expect.objectContaining({
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
      }),
    }));
    expect(capturedStartOptions.expectedByFlow).not.toHaveProperty('live_stream');
    expect(capturedStartOptions).not.toHaveProperty('stream');
  });
});
