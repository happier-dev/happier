import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  FeaturesResponseSchema,
  type FeaturesResponse,
  type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

import {
  startPeerMediationMachineRpcLoopback,
  type StartPeerMediationMachineRpcLoopbackInput,
} from './startLoopback';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function createServerFeatures(publicKey: Uint8Array): FeaturesResponse {
  return FeaturesResponseSchema.parse({
    features: {
      machines: {
        enabled: true,
        rpc: {
          enabled: true,
          directPeer: { enabled: true },
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
        },
      },
    },
  });
}

describe('startPeerMediationMachineRpcLoopback', () => {
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
      StartPeerMediationMachineRpcLoopbackInput['startPeerMediationLoopbackServer']
    >>[0] } = {};
    const startPeerMediationLoopbackServer: StartPeerMediationMachineRpcLoopbackInput['startPeerMediationLoopbackServer'] =
      vi.fn(async (options) => {
        captured.startOptions = options;
        return {
          app: {} as never,
          url: endpoint.url,
          endpoint,
          stop: async () => undefined,
        };
      });

    const started = await startPeerMediationMachineRpcLoopback({
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
