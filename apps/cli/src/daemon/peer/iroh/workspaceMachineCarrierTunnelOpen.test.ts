import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  createDirectRouteGrantSigningInputV2,
  type DirectRouteGrantRequestV2,
} from '@happier-dev/protocol';
import { createWorkspaceMachineCarrierTunnelOpen } from './workspaceMachineCarrierTunnelOpen';

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

describe('createWorkspaceMachineCarrierTunnelOpen', () => {
  it('uses current capability authority despite stale diagnostic state and returns only the native tunnel lifecycle', async () => {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const localEndpointId = 'a'.repeat(64);
    const targetEndpointId = 'b'.repeat(64);
    const target = {
      id: 'machine-target',
      operationProtocolCapabilitiesRevision: 7,
      operationProtocolCapabilities: { irohMachineEndpoint: {
        protocolVersions: [1], endpointId: targetEndpointId, directAddresses: ['10.0.0.2:7777'],
      } },
      daemonStateVersion: 7,
      daemonState: { peerMediation: { iroh: { endpoint: { endpointId: 'c'.repeat(64), directAddresses: ['10.0.0.9:9999'] } } } },
    };
    const readTargetMachine = vi.fn(async () => target);
    const mintGrant = vi.fn(async (request: DirectRouteGrantRequestV2) => {
      const { kind, ttlMs: _ttlMs, ...binding } = request;
      const payload = {
        ...binding,
        grantId: 'grant-1',
        accountId: 'account-1',
        iat: 1_000,
        exp: 301_000,
        aud: 'happier-daemon-route-grant' as const,
        proofKind: kind,
      };
      return {
        payload,
        signature: {
          keyId: 'key-1',
          alg: 'Ed25519' as const,
          valueBase64Url: base64url(tweetnacl.sign.detached(
            Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
            signingKeyPair.secretKey,
          )),
        },
      };
    });
    const close = vi.fn(async () => undefined);
    const openTunnel = vi.fn(async () => ({
      localPort: 48123,
      localCapability: 'd'.repeat(64),
      remoteEndpointId: targetEndpointId,
      observedPath: 'direct' as const,
      close,
    }));
    const openHttpTunnel = vi.fn(async () => ({
      localPort: 48124,
      localCapability: 'e'.repeat(64),
      remoteEndpointId: targetEndpointId,
      observedPath: 'relay' as const,
      close,
    }));
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1',
      localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: localEndpointId }, openTunnel, openHttpTunnel } as never,
      resolveTrustRoots: () => [{ keyId: 'key-1', publicKey: base64url(signingKeyPair.publicKey) }],
      readTargetMachine,
      mintGrant,
      nowMs: () => 2_000,
    });

    const tunnel = await open({
      operationId: 'operation-1', sourceMachineId: 'machine-source', targetMachineId: 'machine-target', flow: 'workspace_sync',
    });
    expect(mintGrant).toHaveBeenCalledWith(expect.objectContaining({
      v: 2,
      machineId: 'machine-target',
      flowKind: 'machine_rpc',
      routeKind: 'iroh_peer',
      endpointFingerprint: targetEndpointId,
      scope: expect.objectContaining({ rpcScopeId: 'operation-1', highRiskSingleUseMethods: ['workspace.sync'] }),
      iroh: {
        initiator: { kind: 'machine', machineId: 'machine-source', endpointId: localEndpointId },
        target: { machineId: 'machine-target', endpointId: targetEndpointId },
        operationKind: 'workspace_sync',
      },
    }));
    expect(readTargetMachine).toHaveBeenCalledTimes(2);
    expect(openTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        handshake: expect.objectContaining({
          initiator: { kind: 'machine', machineId: 'machine-source', endpointId: localEndpointId },
          target: { machineId: 'machine-target', endpointId: targetEndpointId },
          operationId: 'operation-1',
          proof: expect.any(Object),
        }),
      }),
      { endpointId: targetEndpointId, directAddresses: ['10.0.0.2:7777'] },
    );
    expect(tunnel).toEqual({
      localPort: 48123,
      localCapability: 'd'.repeat(64),
      observedPath: 'direct',
      close,
    });

    const finiteTunnel = await open({
      sourceMachineId: 'machine-source', targetMachineId: 'machine-target', flow: 'file_transfer',
    });
    expect(openTunnel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        flow: 'finite_transfer',
        handshake: expect.objectContaining({ flow: 'finite_transfer' }),
      }),
      { endpointId: targetEndpointId, directAddresses: ['10.0.0.2:7777'] },
    );
    expect(openHttpTunnel).not.toHaveBeenCalled();
    expect(openTunnel).toHaveBeenCalledTimes(2);
    expect(finiteTunnel).toEqual({
      localPort: 48123,
      observedPath: 'direct',
      close,
    });
    await open({ operationId: 'operation-2', sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target', flow: 'workspace_sync' });
    expect(mintGrant).toHaveBeenCalledTimes(3);
    expect(mintGrant).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ rpcScopeId: 'operation-2', allowedMethods: ['workspace.sync'],
        highRiskSingleUseMethods: ['workspace.sync'] }),
    }));
    expect(mintGrant.mock.calls[1]?.[0].scope).toEqual({ kind: 'bounded_transfer', mode: 'carrier' });
  });

  it('settles promptly on cancellation while a native dial is pending and closes a late tunnel handle', async () => {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const localEndpointId = 'a'.repeat(64);
    const targetEndpointId = 'b'.repeat(64);
    const target = {
      id: 'machine-target',
      operationProtocolCapabilitiesRevision: 7,
      operationProtocolCapabilities: { irohMachineEndpoint: {
        protocolVersions: [1], endpointId: targetEndpointId, relayUrls: ['https://relay.example.test'],
      } },
      daemonStateVersion: 7,
      daemonState: { peerMediation: { iroh: { endpoint: { endpointId: targetEndpointId, relayUrls: ['https://relay.example.test'] } } } },
    };
    const mintGrant = vi.fn(async (request: DirectRouteGrantRequestV2) => {
      const { kind, ttlMs: _ttlMs, ...binding } = request;
      const payload = {
        ...binding,
        grantId: 'grant-cancel', accountId: 'account-1', iat: 1_000, exp: 301_000,
        aud: 'happier-daemon-route-grant' as const, proofKind: kind,
      };
      return {
        payload,
        signature: {
          keyId: 'key-1', alg: 'Ed25519' as const,
          valueBase64Url: base64url(tweetnacl.sign.detached(
            Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
            signingKeyPair.secretKey,
          )),
        },
      };
    });
    let settleDial!: (value: {
      localPort: number;
      localCapability: string;
      remoteEndpointId: string;
      observedPath: 'relay';
      close: () => Promise<void>;
    }) => void;
    const pendingDial = new Promise<Parameters<typeof settleDial>[0]>((resolve) => {
      settleDial = resolve;
    });
    const close = vi.fn(async () => undefined);
    const openTunnel = vi.fn(() => pendingDial);
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1', localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: localEndpointId }, openTunnel } as never,
      resolveTrustRoots: () => [{ keyId: 'key-1', publicKey: base64url(signingKeyPair.publicKey) }],
      readTargetMachine: async () => target,
      mintGrant,
      nowMs: () => 2_000,
    });
    const controller = new AbortController();
    const reason = new Error('broker closed');
    const opening = open({
      operationId: 'operation-cancel', sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target', flow: 'workspace_sync', signal: controller.signal,
    });
    await vi.waitFor(() => expect(openTunnel).toHaveBeenCalledTimes(1));

    controller.abort(reason);
    await expect(opening).rejects.toBe(reason);
    expect(close).not.toHaveBeenCalled();

    settleDial({
      localPort: 48123, localCapability: 'd'.repeat(64), remoteEndpointId: targetEndpointId,
      observedPath: 'relay', close,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('settles promptly when target-machine control-plane read is hung and never admits a native tunnel', async () => {
    const openTunnel = vi.fn();
    const readTargetMachine = vi.fn(() => new Promise<never>(() => undefined));
    const mintGrant = vi.fn();
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1', localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: 'a'.repeat(64) }, openTunnel } as never,
      resolveTrustRoots: () => [], readTargetMachine, mintGrant,
    });
    const controller = new AbortController();
    const reason = new Error('broker closed');
    const opening = open({
      operationId: 'operation-hung-read', sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target', flow: 'workspace_sync', signal: controller.signal,
    });

    await vi.waitFor(() => expect(readTargetMachine).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    const settled = await Promise.race([
      opening.then(() => 'resolved', () => 'rejected'),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
    ]);
    expect(settled).toBe('rejected');
    await expect(opening).rejects.toBe(reason);
    expect(readTargetMachine).toHaveBeenCalledWith('machine-target', expect.any(AbortSignal));
    expect(mintGrant).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('fails closed without a stable exact descriptor revision and never opens a native tunnel', async () => {
    const openTunnel = vi.fn();
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1', localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: 'a'.repeat(64) }, openTunnel } as never,
      resolveTrustRoots: () => [], readTargetMachine: async () => null, mintGrant: vi.fn(),
    });
    await expect(open({ operationId: 'operation-1', sourceMachineId: 'machine-source', targetMachineId: 'missing', flow: 'workspace_sync' }))
      .rejects.toMatchObject({ code: 'machine_carrier_unavailable' });
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it('refuses withdrawn capability authority even when diagnostic state advertises an endpoint', async () => {
    const openTunnel = vi.fn();
    const mintGrant = vi.fn();
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1', localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: 'a'.repeat(64) }, openTunnel } as never,
      resolveTrustRoots: () => [],
      readTargetMachine: async () => ({
        id: 'machine-target', operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: 8,
        daemonState: { peerMediation: { iroh: { endpoint: { endpointId: 'b'.repeat(64) } } } },
        daemonStateVersion: 7,
      }),
      mintGrant,
    });
    await expect(open({
      operationId: 'operation-1', sourceMachineId: 'machine-source', targetMachineId: 'machine-target', flow: 'workspace_sync',
    })).rejects.toMatchObject({ code: 'machine_carrier_unavailable' });
    expect(mintGrant).not.toHaveBeenCalled();
    expect(openTunnel).not.toHaveBeenCalled();
  });

  it.each(['current', 'withdrawn', 'replaced'] as const)('rechecks capability authority after minting and fences the signed target EndpointId (%s)', async (currentness) => {
    const signingKeyPair = tweetnacl.sign.keyPair();
    const targetEndpointId = 'b'.repeat(64);
    let readCount = 0;
    const readTargetMachine = vi.fn(async () => ({
      id: 'machine-target',
      operationProtocolCapabilitiesRevision: ++readCount,
      operationProtocolCapabilities: currentness === 'withdrawn' && readCount > 1 ? {} : { irohMachineEndpoint: {
        protocolVersions: [1],
        endpointId: currentness === 'replaced' && readCount > 1 ? 'c'.repeat(64) : targetEndpointId,
        directAddresses: [readCount === 1 ? '10.0.0.2:7777' : '10.0.0.3:8888'],
      } },
    }));
    const mintGrant = vi.fn(async (request: DirectRouteGrantRequestV2) => {
      const { kind, ttlMs: _ttlMs, ...binding } = request;
      const payload = {
        ...binding,
        grantId: 'grant-rotated', accountId: 'account-1', iat: 1_000, exp: 301_000,
        aud: 'happier-daemon-route-grant' as const, proofKind: kind,
      };
      return {
        payload,
        signature: {
          keyId: 'key-current', alg: 'Ed25519' as const,
          valueBase64Url: base64url(tweetnacl.sign.detached(
            Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
            signingKeyPair.secretKey,
          )),
        },
      };
    });
    const openTunnel = vi.fn(async () => ({
      localPort: 48123, localCapability: 'd'.repeat(64), remoteEndpointId: targetEndpointId,
      observedPath: 'direct' as const, close: async () => undefined,
    }));
    const open = createWorkspaceMachineCarrierTunnelOpen({
      accountId: 'account-1', localMachineId: 'machine-source',
      runtime: { available: true, endpoint: { endpointId: 'a'.repeat(64) }, openTunnel } as never,
      resolveTrustRoots: () => [{ keyId: 'key-current', publicKey: base64url(signingKeyPair.publicKey) }],
      readTargetMachine, mintGrant, nowMs: () => 2_000,
    });

    const opening = open({
      operationId: 'operation-1', sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target', flow: 'workspace_sync',
    });
    if (currentness === 'current') {
      await expect(opening).resolves.toMatchObject({ localPort: 48123 });
      expect(openTunnel).toHaveBeenCalledWith(expect.any(Object), {
        endpointId: targetEndpointId,
        directAddresses: ['10.0.0.3:8888'],
      });
    } else {
      await expect(opening).rejects.toMatchObject({ code: 'machine_carrier_unavailable' });
      expect(openTunnel).not.toHaveBeenCalled();
    }
  });
});
