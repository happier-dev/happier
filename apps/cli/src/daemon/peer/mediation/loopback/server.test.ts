import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { once } from 'node:events';
import { request as requestHttp } from 'node:http';
import { connect, createServer } from 'node:net';

import {
  DIRECT_ROUTE_GRANT_AUDIENCE_V1,
  createDirectRouteGrantSigningInputV2,
  createTcpTunnelServiceExportCommitmentV1,
  createEphemeralPeerRouteProofHandleV2,
  IrohMachineHandshakeV1Schema,
  PEER_MEDIATION_RECEIPTS,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PeerMachineRpcDirectResponseV2Schema,
  type DirectRouteGrantPayloadV2,
  type IrohMachineHandshakeV1,
  type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
} from '@happier-dev/iroh-native/node';

import { createDaemonMachineLiveStreamCaptureAdapter } from '../stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../stream/captureRegistry';
import {
  assertPeerMediationLoopbackBindHost,
  createPeerMediationLoopbackApp,
  PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES,
  startPeerMediationLoopbackServer,
} from './server';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function createCurrentProof(grant: SignedDirectRouteGrantV2) {
  const handle = createEphemeralPeerRouteProofHandleV2({
    randomBytes: (length) => new Uint8Array(length).fill(9),
  });
  try {
    return handle.sign(grant);
  } finally {
    handle.dispose();
  }
}

const DIRECT_PROOF_PUBLIC_KEY = toBase64Url(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);

function createSignedMachineRpcGrant(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
  allowedMethods: readonly string[];
}>): SignedDirectRouteGrantV2 {
  const payload: DirectRouteGrantPayloadV2 = {
    v: 2,
    grantId: 'grant_rpc_1',
    grantFamilyId: 'family_rpc_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'machine_rpc',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'machine_rpc',
      rpcScopeId: 'rpc_scope_1',
      allowedMethods: [...input.allowedMethods],
      maxCalls: 2,
      maxIdleMs: 30_000,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: input.endpointFingerprint,
    proofKind: 'ephemeral_ed25519',
    ephemeralPublicKeyBase64Url: DIRECT_PROOF_PUBLIC_KEY,
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
        input.signingSecretKey,
      )),
    },
  };
}

function createSignedLiveStreamGrant(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
}>): SignedDirectRouteGrantV2 {
  const payload: DirectRouteGrantPayloadV2 = {
    v: 2,
    grantId: 'grant_stream_1',
    grantFamilyId: 'family_stream_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'live_stream',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'live_stream',
      streamId: 'stream_1',
      streamFamily: 'screen',
      maxBitrateBps: 64_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: input.endpointFingerprint,
    proofKind: 'ephemeral_ed25519',
    ephemeralPublicKeyBase64Url: DIRECT_PROOF_PUBLIC_KEY,
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
        input.signingSecretKey,
      )),
    },
  };
}

function createSignedLiveStreamGrantV2(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
  ephemeralPublicKeyBase64Url: string;
}>) {
  const payload: DirectRouteGrantPayloadV2 = {
    v: 2, grantId: 'grant_stream_v2', accountId: 'account_1', machineId: 'machine_1',
    flowKind: 'live_stream', routeKind: 'loopback_direct',
    scope: { kind: 'live_stream', streamId: 'stream_v2', streamFamily: 'screen', maxBitrateBps: 64_000, maxDurationMs: 60_000 },
    iat: 1_000, exp: 601_000, aud: 'happier-daemon-route-grant', endpointFingerprint: input.endpointFingerprint,
    proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: input.ephemeralPublicKeyBase64Url,
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519' as const,
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'), input.signingSecretKey,
      )),
    },
  };
}

// --- machine/1 Iroh admission fixtures: canonical handshake + real signed V2 `iroh_peer` grant ---
const IROH_SIGNING_KEY_PAIR = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const IROH_TRUST_ROOTS = [{ keyId: 'iroh-key-1', publicKey: toBase64Url(IROH_SIGNING_KEY_PAIR.publicKey) }];
// Strict endpoint-id grammar (64 lowercase hex = 32-byte Iroh endpoint identity).
const IROH_SOURCE_ENDPOINT_ID = 'a'.repeat(64);
const IROH_TARGET_ENDPOINT_ID = 'b'.repeat(64);
const IROH_OPERATION_ID = 'operation_iroh_1';

function createIrohMachineHandshake(input: Readonly<{
  flow?: 'finite_transfer' | 'workspace_sync' | 'tcp_tunnel';
  accountId?: string;
  initiatorKind?: 'machine' | 'account_client';
  targetMachineId?: string;
  grantOverrides?: Partial<DirectRouteGrantPayloadV2>;
  breakProof?: boolean;
}> = {}): IrohMachineHandshakeV1 {
  const flow = input.flow ?? 'finite_transfer';
  const sourceMachineId = 'machine_source';
  const targetMachineId = input.targetMachineId ?? 'machine_1';
  const initiator = input.initiatorKind === 'account_client' ? {
    kind: 'account_client' as const, endpointId: IROH_SOURCE_ENDPOINT_ID,
  } : {
    kind: 'machine' as const,
    machineId: sourceMachineId,
    endpointId: IROH_SOURCE_ENDPOINT_ID,
  };
  const target = {
    machineId: targetMachineId,
    endpointId: IROH_TARGET_ENDPOINT_ID,
  };
  const payload: DirectRouteGrantPayloadV2 = {
    v: 2,
    grantId: 'grant_iroh_1',
    accountId: input.accountId ?? 'account_1',
    machineId: targetMachineId,
    flowKind: flow === 'tcp_tunnel' ? 'tcp_tunnel' : 'bounded_transfer',
    routeKind: 'iroh_peer',
    scope: flow === 'tcp_tunnel'
      ? { kind: 'tcp_tunnel', tunnelId: 'native-tunnel-1', allowedPorts: [3000] }
      : flow === 'finite_transfer'
      ? { kind: 'bounded_transfer', mode: 'carrier' }
      : { kind: 'bounded_transfer', mode: 'single', transferId: IROH_OPERATION_ID, maxBytes: 1024 },
    iat: 1_000,
    exp: 601_000,
    aud: DIRECT_ROUTE_GRANT_AUDIENCE_V1,
    endpointFingerprint: IROH_TARGET_ENDPOINT_ID,
    iroh: {
      initiator,
      target,
      operationKind: flow,
    },
    proofKind: 'ephemeral_ed25519',
    ephemeralPublicKeyBase64Url: '',
    ...input.grantOverrides,
  };
  const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes: (length) => new Uint8Array(length).fill(3) });
  const signedPayload = { ...payload, ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url };
  const grant: SignedDirectRouteGrantV2 = {
    payload: signedPayload,
    signature: {
      keyId: 'iroh-key-1',
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV2(signedPayload), 'utf8'),
        IROH_SIGNING_KEY_PAIR.secretKey,
      )),
    },
  };
  const proof = handle.sign(grant);
  const sharedHandshake = {
    v: 1 as const,
    accountId: input.accountId ?? 'account_1',
    initiator,
    target,
    grant,
    proof: input.breakProof ? { ...proof, nonceBase64Url: toBase64Url(new Uint8Array(16).fill(7)) } : proof,
  };
  return IrohMachineHandshakeV1Schema.parse(flow === 'workspace_sync'
    ? { ...sharedHandshake, flow, operationId: IROH_OPERATION_ID }
    : { ...sharedHandshake, flow });
}

/**
 * A `server_relay` grant can never be produced by the canonical signer (the authorized
 * endpoint-route schema excludes it), so this simulates the wire body a hostile or
 * misconfigured peer would actually send: a genuinely signed `iroh_peer` handshake whose
 * grant payload route kind was swapped to `server_relay` after signing. The route must
 * reject it fail-closed (403, no echo), exactly like every other cross-route grant.
 */
function createCrossRouteGrantWireHandshake(): Record<string, unknown> {
  const handshake = createIrohMachineHandshake();
  return {
    ...handshake,
    grant: {
      ...handshake.grant,
      payload: {
        ...handshake.grant.payload,
        routeKind: 'server_relay',
      },
    },
  };
}

function createIrohAdmissionTestApp() {
  return createPeerMediationLoopbackApp({
    nowMs: () => 2_000,
    expected: {
      accountId: 'account_1',
      machineId: 'machine_1',
      flowKind: 'bounded_transfer',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'loopback_endpoint_1',
    },
    trustRoots: IROH_TRUST_ROOTS,
    irohMachineAdmission: {
      localEndpointId: IROH_TARGET_ENDPOINT_ID,
      role: 'acceptor',
      allowedFlows: ['finite_transfer', 'workspace_sync'],
      resolveApplicationTarget: () => ({ port: 46_001 }),
    },
  });
}

describe('peer mediation loopback server', () => {
  it.each(['probe', 'rpc', 'live-stream/start', 'tunnel/open'])('does not register the retired %s route', async (path) => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'machine_rpc',
        routeKind: 'loopback_direct', endpointFingerprint: 'endpoint_1',
      },
      trustRoots: [],
      rpc: { rpcHandlerManager: { invokeLocal: async () => { throw new Error('Unexpected RPC dispatch'); } } },
      stream: {},
      tunnel: {},
    });
    try {
      const response = await app.inject({ method: 'POST', url: `/peer-mediation/v1/${path}`, payload: {} });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('answers browser CORS and private-network preflight for signed loopback requests', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
    });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/peer-mediation/v2/rpc',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
        'access-control-request-private-network': 'true',
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toContain('content-type');
    expect(preflight.headers['access-control-allow-private-network']).toBe('true');

    await app.close();
  });

  it('verifies current direct live-stream grants before refusing the unavailable channel without capture', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedLiveStreamGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const proof = createCurrentProof(grant);
    let captureAttempts = 0;
    const startupTrustRoots = [{
      keyId: 'grant-key-1',
      publicKey: toBase64Url(grantKeyPair.publicKey),
    }];
    let currentTrustRoots = startupTrustRoots;
    const appOptions = {
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'live_stream',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: startupTrustRoots,
      resolveTrustRoots: () => currentTrustRoots,
      stream: {
        captureAdapter: {
          start: async () => {
            captureAttempts += 1;
            return { ok: true as const, session: { stop: async () => undefined } };
          },
        },
      },
    } as const;
    const app = createPeerMediationLoopbackApp(appOptions);

    currentTrustRoots = [];
    const unavailable = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/live-stream/start',
      payload: {
        v: 2,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        flowKind: 'live_stream',
        endpointFingerprint: 'loopback_endpoint_1',
        grant,
        proof,
        startRequest: {
          v: 1,
          streamId: 'stream_1',
          streamFamily: 'screen',
          routeKind: 'loopback_direct',
          sourceMachineId: 'machine_1',
          targetMachineId: 'machine_target',
          maxBitrateBps: 64_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          maxDurationMs: 60_000,
          maxTotalBytes: 128_000,
        },
      },
    });
    expect(unavailable.json()).toMatchObject({ ok: false, reasonCode: 'grant_unknown_key' });
    currentTrustRoots = startupTrustRoots;

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/live-stream/start',
      payload: {
        v: 2,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        flowKind: 'live_stream',
        endpointFingerprint: 'loopback_endpoint_1',
        grant,
        proof,
        startRequest: {
          v: 1,
          streamId: 'stream_1',
          streamFamily: 'screen',
          routeKind: 'loopback_direct',
          sourceMachineId: 'machine_1',
          targetMachineId: 'machine_target',
          maxBitrateBps: 64_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          maxDurationMs: 60_000,
          maxTotalBytes: 128_000,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 2,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'direct_stream_channel_unavailable',
    });
    expect(captureAttempts).toBe(0);

    await app.close();
  });

  it('refuses a valid V2 direct live stream without capturing or consuming its grant when the channel is unavailable', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const handle = createEphemeralPeerRouteProofHandleV2({
      randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 5 : 6),
    });
    const grant = createSignedLiveStreamGrantV2({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
    });
    const proof = handle.sign(grant);
    let captureAttempts = 0;
    const captureRegistry = createMachineLiveStreamCaptureRegistry();
    captureRegistry.register({
      sourceId: 'source_1',
      streamFamily: 'screen',
      // Capture starts the external source; the registry and daemon adapter stay real.
      adapter: { start: async () => {
        captureAttempts += 1;
        return { ok: true, session: { stop: async () => undefined } };
      } },
      capabilities: {
        v: 1, sourceId: 'source_1', sourceKind: 'screen', supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 12, inputMode: 'exclusive', sidebands: [], health: { status: 'available' },
      },
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'live_stream',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{ keyId: 'grant-key-1', publicKey: toBase64Url(grantKeyPair.publicKey) }],
      stream: { captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(captureRegistry) },
    });
    const payload = {
      v: 2,
      streamId: 'stream_v2',
      streamFamily: 'screen',
      routeKind: 'loopback_direct',
      flowKind: 'live_stream',
      endpointFingerprint: 'loopback_endpoint_1',
      grant,
      proof,
      startRequest: {
        v: 1, streamId: 'stream_v2', streamFamily: 'screen', routeKind: 'loopback_direct',
        sourceMachineId: 'machine_1', targetMachineId: 'machine_target', maxBitrateBps: 64_000,
        maxFramesPerSecond: 12, maxFrameBytes: 32_000, maxDurationMs: 60_000,
      },
    };

    const invalidProof = await app.inject({
      method: 'POST', url: '/peer-mediation/v2/live-stream/start',
      payload: { ...payload, proof: { ...proof, signatureBase64Url: toBase64Url(new Uint8Array(64)) } },
    });
    expect(invalidProof.json()).toMatchObject({ v: 2, ok: false, reasonCode: 'proof_bad_signature' });
    const refused = await app.inject({ method: 'POST', url: '/peer-mediation/v2/live-stream/start', payload });
    expect(refused.json()).toEqual({
      v: 2, ok: false, receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'direct_stream_channel_unavailable',
    });
    const replay = await app.inject({ method: 'POST', url: '/peer-mediation/v2/live-stream/start', payload });
    expect(replay.json()).toEqual(refused.json());
    expect(captureAttempts).toBe(0);
    await app.close();
  });

  it('refuses the unavailable direct live-stream channel without requiring a capture adapter', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedLiveStreamGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const proof = createCurrentProof(grant);
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'live_stream',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      stream: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/live-stream/start',
      payload: {
        v: 2,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        flowKind: 'live_stream',
        endpointFingerprint: 'loopback_endpoint_1',
        grant,
        proof,
        startRequest: {
          v: 1,
          streamId: 'stream_1',
          streamFamily: 'screen',
          routeKind: 'loopback_direct',
          sourceMachineId: 'machine_1',
          targetMachineId: 'machine_target',
          maxBitrateBps: 64_000,
          maxFramesPerSecond: 12,
          maxFrameBytes: 32_000,
          maxDurationMs: 60_000,
          maxTotalBytes: 128_000,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 2,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'direct_stream_channel_unavailable',
    });

    await app.close();
  });

  it('admits the signed native TCP scope through the same configured tunnel owner', async () => {
    const handshake = createIrohMachineHandshake({ flow: 'tcp_tunnel' });
    const events: { flow: { routeKind?: string } }[] = [];
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2000,
      expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: 'local-loopback' },
      trustRoots: IROH_TRUST_ROOTS,
      tunnel: {},
      irohMachineAdmission: { localEndpointId: IROH_TARGET_ENDPOINT_ID, role: 'acceptor', allowedFlows: ['tcp_tunnel'], resolveApplicationTarget: async () => null },
      observability: { emit: (event) => { events.push(event); } },
    });
    try {
      const open = { v: 2, kind: 'open', tunnelId: 'native-tunnel-1', targetMachineId: 'machine_1', routeKind: 'iroh_peer', destination: { host: '127.0.0.1', port: 3000 }, grant: handshake.grant, proof: handshake.proof };
      const denied = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: { ...open, destination: { host: '127.0.0.1', port: 3001 } } });
      expect(denied.json()).toMatchObject({ ok: false, reasonCode: 'destination_port_not_allowed' });
      const admitted = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: open });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.json()).toMatchObject({ tunnelId: 'native-tunnel-1' });
      expect(events.at(-1)?.flow.routeKind).toBe('iroh_peer');
    } finally {
      await app.close();
    }
  });

  it.each(['owner', 'no resolver', 'commitment mismatch', 'changed occurrence', 'wrong machine', 'wrong destination', 'missing opening'] as const)(
    'checks the private export opening against B applied state: %s', async mode => {
    const binding = {
      exportKey: 'web', service: { kind: 'deployment' as const, machineId: mode === 'wrong machine' ? 'another-machine' : 'machine_1', environmentId: 'environment',
        environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' },
      installationId: 'installation', deploymentId: 'deployment', generation: 'generation',
      destination: { host: '127.0.0.1' as const, port: 3000 },
    };
    const nonce = 'ab'.repeat(32);
    const handshake = createIrohMachineHandshake({ flow: 'tcp_tunnel', grantOverrides: {
      scope: { kind: 'tcp_tunnel', tunnelId: 'native-tunnel-1', allowedPorts: [3000], serviceExport: {
        commitment: mode === 'commitment mismatch' ? `sha256:${'0'.repeat(64)}` : createTcpTunnelServiceExportCommitmentV1(binding, nonce),
      } },
    } });
    const app = createPeerMediationLoopbackApp({ nowMs: () => 2000,
      expected: { accountId: 'account_1', machineId: 'machine_1', flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: 'local' },
      trustRoots: IROH_TRUST_ROOTS, tunnel: mode === 'no resolver' ? {} : { resolveServiceExport: async () =>
        mode === 'changed occurrence' ? { ...binding, generation: 'replacement' } : binding },
      irohMachineAdmission: { localEndpointId: IROH_TARGET_ENDPOINT_ID, role: 'acceptor', allowedFlows: ['tcp_tunnel'], resolveApplicationTarget: () => null },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/peer-mediation/v2/tunnel/open', payload: {
        v: 2, kind: 'open', tunnelId: 'native-tunnel-1', targetMachineId: 'machine_1', routeKind: 'iroh_peer',
        destination: { host: mode === 'wrong destination' ? '::1' : '127.0.0.1', port: 3000 }, grant: handshake.grant, proof: handshake.proof,
        ...(mode === 'missing opening' ? {} : { serviceExport: { binding, nonce } }),
      } });
      if (mode === 'owner') expect(response.statusCode).toBe(200);
      else expect(response.json()).toMatchObject({ ok: false,
        reasonCode: mode === 'wrong machine' || mode === 'wrong destination' ? 'grant_scope_mismatch' : 'service_export_unavailable' });
    } finally { await app.close(); }
  });

  it.each(['acceptor', 'initiator'] as const)('carries the signed export requester through the %s endpoint without granting generic shared TCP', async (role) => {
    const serviceExport = { commitment: `sha256:${'a'.repeat(64)}` };
    const handshake = createIrohMachineHandshake({ flow: 'tcp_tunnel', accountId: 'requester',
      grantOverrides: { scope: { kind: 'tcp_tunnel', tunnelId: 'native-tunnel-1', allowedPorts: [3000], serviceExport } } });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2000,
      expected: { accountId: 'custodian', machineId: role === 'acceptor' ? 'machine_1' : 'machine_source',
        flowKind: 'tcp_tunnel', routeKind: 'loopback_direct', endpointFingerprint: 'local-loopback' },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: { localEndpointId: role === 'acceptor' ? IROH_TARGET_ENDPOINT_ID : IROH_SOURCE_ENDPOINT_ID,
        role, allowedFlows: ['tcp_tunnel'], resolveApplicationTarget: () => ({ port: 46001 }) },
    });
    const headers = { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: role === 'acceptor' ? IROH_SOURCE_ENDPOINT_ID : IROH_TARGET_ENDPOINT_ID };
    try {
      expect((await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH, headers, payload: handshake })).statusCode).toBe(204);
      const generic = createIrohMachineHandshake({ flow: 'tcp_tunnel', accountId: 'requester' });
      expect((await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH, headers, payload: generic })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: 'f'.repeat(64) }, payload: handshake })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('rejects non-loopback bind hosts before startup', () => {
    const anyAddress = ['0', '0', '0', '0'].join('.');
    expect(assertPeerMediationLoopbackBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(assertPeerMediationLoopbackBindHost('2130706433')).toBe('127.0.0.1');
    expect(assertPeerMediationLoopbackBindHost('localhost')).toBe('localhost');
    expect(assertPeerMediationLoopbackBindHost('::1')).toBe('::1');
    expect(() => assertPeerMediationLoopbackBindHost(anyAddress)).toThrow(/loopback/i);
    expect(() => assertPeerMediationLoopbackBindHost('192.168.1.20')).toThrow(/loopback/i);
    expect(() => assertPeerMediationLoopbackBindHost('127.not-a-host')).toThrow(/loopback/i);
  });

  it('rejects a non-loopback bind host through the composed start path, not only the guard', async () => {
    // Regression guard for review finding R2 F-1. The case above exercises the pure function only.
    // `assertPeerMediationLoopbackBindHost` has exactly one call site (`server.ts:277`); deleting it
    // left that case — and both halves of the PMS-2 acceptance gate — green while the daemon bound
    // every interface. This case pins the composed entry point, so removing the *invocation* of the
    // security boundary fails the gate, not just removing its implementation.
    const anyAddress = ['0', '0', '0', '0'].join('.');
    let started: Awaited<ReturnType<typeof startPeerMediationLoopbackServer>> | undefined;
    try {
      await expect(
        startPeerMediationLoopbackServer({
          host: anyAddress,
          port: 0,
          endpointExpiresAt: 10_000,
          nowMs: () => 2_000,
          expected: {
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'loopback_endpoint_1',
          },
          trustRoots: [],
        }).then((server) => {
          // Only reached if the guard is gone; captured so the accidental listener is closed.
          started = server;
          return server;
        }),
        // Assert the guard's EXACT message, not /loopback/i. With the call site removed the start
        // path still rejects — but from a downstream Zod endpoint-URL parse, *after* the socket has
        // already bound 0.0.0.0. A loose regex matches that Zod text (it contains "loopback_direct")
        // and so cannot tell the two apart. This exact string can only come from the guard.
      ).rejects.toThrow('Peer mediation loopback server must bind to a loopback host');
    } finally {
      await started?.stop();
    }
  });

  it('composes direct machine RPC JSON with its strict consumer after grant, proof, method policy, and endpoint binding verify', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const proof = createCurrentProof(grant);
    const startupTrustRoots = [{
      keyId: 'grant-key-1',
      publicKey: toBase64Url(grantKeyPair.publicKey),
    }];
    let currentTrustRoots = startupTrustRoots;
    const dispatched: unknown[] = [];
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
    rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_MEMORY_STATUS, async params => {
      dispatched.push(params);
      return { method: RPC_METHODS.DAEMON_MEMORY_STATUS, params, ok: true };
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: startupTrustRoots,
      resolveTrustRoots: () => currentTrustRoots,
      rpc: { rpcHandlerManager },
    });

    currentTrustRoots = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const unavailable = await app.inject({
        method: 'POST',
        url: '/peer-mediation/v2/rpc',
        payload: {
          v: 2,
          requestId: `request_unavailable_${attempt}`,
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          params: { includeWorkers: true },
          grant,
          proof,
          routeKind: 'loopback_direct',
          flowKind: 'machine_rpc',
          endpointFingerprint: 'loopback_endpoint_1',
        },
      });
      expect(unavailable.json()).toMatchObject({ ok: false, reasonCode: 'grant_unknown_key' });
    }
    expect(dispatched).toEqual([]);
    currentTrustRoots = startupTrustRoots;

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${address}/peer-mediation/v2/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 2,
          requestId: 'request_1',
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          params: { includeWorkers: true },
          grant,
          proof,
          routeKind: 'loopback_direct',
          flowKind: 'machine_rpc',
          endpointFingerprint: 'loopback_endpoint_1',
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      // The UI's production reader decodes JSON and applies this exact schema.
      expect(PeerMachineRpcDirectResponseV2Schema.parse(await response.json())).toEqual({
        v: 2,
        ok: true,
        receipt: 'peer.rpc.direct_call_succeeded',
        requestId: 'request_1',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        routeKind: 'loopback_direct',
        result: {
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          params: { includeWorkers: true },
          ok: true,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('accepts a signed direct voice upload chunk larger than the legacy 64 KiB body limit', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const method = RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK;
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [method],
    });
    const proof = createCurrentProof(grant);
    const params = {
      uploadId: 'voice_upload_1',
      index: 0,
      payloadBase64: 'A'.repeat(68_948),
      encryptedDataKeyEnvelopeBase64: 'AQID',
    };
    let invokedParams: unknown;
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async (_method: string, nextParams: unknown) => {
            invokedParams = nextParams;
            return { success: true };
          },
        },
      },
    });
    const requestId = 'request_voice_upload_1';
    const payload = {
      v: 2 as const,
      requestId,
      method,
      params,
      grant,
      proof,
      routeKind: 'loopback_direct' as const,
      flowKind: 'machine_rpc' as const,
      endpointFingerprint: 'loopback_endpoint_1',
    };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(64 * 1024);

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/rpc',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 2,
      ok: true,
      receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
      requestId,
      method,
      result: { success: true },
    });
    expect(invokedParams).toEqual(params);

    await app.close();
  });

  it('keeps loopback request bodies bounded above the supported signed transfer envelope', async () => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [],
      bodyLimitBytes: Number.MAX_SAFE_INTEGER,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/rpc',
      payload: { padding: 'A'.repeat(PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES) },
    });

    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it('does not invoke direct machine RPC handlers for server-required methods', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.SPAWN_HAPPY_SESSION],
    });
    const proof = createCurrentProof(grant);
    let invoked = false;
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async () => {
            invoked = true;
            return { ok: true };
          },
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/rpc',
      payload: {
        v: 2,
        requestId: 'request_2',
        method: RPC_METHODS.SPAWN_HAPPY_SESSION,
        params: { prompt: 'hello' },
        grant,
        proof,
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'loopback_endpoint_1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 2,
      ok: false,
      receipt: 'peer.rpc.fell_back_to_server',
      requestId: 'request_2',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      reasonCode: 'server_required',
    });
    expect(invoked).toBe(false);

    await app.close();
  });

  it('does not invoke direct machine RPC handlers when the request route differs from the verified grant route', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const proof = createCurrentProof(grant);
    let invoked = false;
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async () => {
            invoked = true;
            return { ok: true };
          },
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v2/rpc',
      payload: {
        v: 2,
        requestId: 'request_route_mismatch',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant,
        proof,
        routeKind: 'lan_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'loopback_endpoint_1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 2,
      ok: false,
      receipt: 'peer.rpc.fell_back_to_server',
      requestId: 'request_route_mismatch',
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      reasonCode: 'grant_scope_mismatch',
    });
    expect(invoked).toBe(false);

    await app.close();
  });

  // SIMPLIFY-RPC-1109: each request verifies its proof without latching endpoint policy.
  it('refuses repeated invalid proofs and still admits a valid direct machine RPC request', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const badProof = {
      ...createCurrentProof(grant),
      signatureBase64Url: toBase64Url(new Uint8Array(64).fill(8)),
    };
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async () => ({ ok: true }),
        },
      },
    });

    const reasonCodes: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/peer-mediation/v2/rpc',
        payload: {
          v: 2,
          requestId: `request_${index}`,
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          params: {},
          grant,
          proof: badProof,
          routeKind: 'loopback_direct',
          flowKind: 'machine_rpc',
          endpointFingerprint: 'loopback_endpoint_1',
        },
      });
      reasonCodes.push((response.json() as { reasonCode?: string }).reasonCode ?? '');
    }

    expect(reasonCodes).toEqual(Array(6).fill('nonce_bad_signature'));
    const response = await app.inject({
      method: 'POST', url: '/peer-mediation/v2/rpc', payload: {
        v: 2, requestId: 'valid_after_failures', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: {}, grant, proof: createCurrentProof(grant), routeKind: 'loopback_direct',
        flowKind: 'machine_rpc', endpointFingerprint: 'loopback_endpoint_1',
      },
    });
    expect(response.json()).toMatchObject({ ok: true, result: { ok: true } });

    await app.close();
  });
});

describe('machine/1 Iroh admission route', () => {
  it('cancels ordinary application resolution on request disconnect and admits an immediate retry', async () => {
    let attempts = 0;
    let observedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['workspace_sync'],
        resolveApplicationTarget: async ({ signal }) => {
          attempts += 1;
          observedSignal = signal;
          resolveStarted();
          if (attempts === 1) {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          return { port: 46_001, localCapability: 'a'.repeat(64) };
        },
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('admission listener did not bind');
    const body = JSON.stringify(createIrohMachineHandshake({ flow: 'workspace_sync' }));
    const client = requestHttp({
      host: '127.0.0.1',
      port: address.port,
      path: IROH_MACHINE_ADMISSION_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID,
      },
    });
    client.on('error', () => undefined);
    try {
      client.end(body);
      await started;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      client.destroy();
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));

      const retry = await app.inject({
        method: 'POST',
        url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
        payload: createIrohMachineHandshake({ flow: 'workspace_sync' }),
      });
      expect(retry.statusCode).toBe(204);
      expect(attempts).toBe(2);
    } finally {
      client.destroy();
      await app.close();
    }
  });

  it('resolves current signing roots for each admission instead of freezing startup keys', async () => {
    let currentRoots: typeof IROH_TRUST_ROOTS = [];
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [],
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['finite_transfer'],
        resolveTrustRoots: () => currentRoots,
        resolveApplicationTarget: (input) => {
          expect(input.signal).toBeInstanceOf(AbortSignal);
          return { port: 46_001 };
        },
      },
    });
    const request = {
      method: 'POST' as const,
      url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
      payload: createIrohMachineHandshake(),
    };

    expect((await app.inject(request)).statusCode).toBe(403);
    currentRoots = IROH_TRUST_ROOTS;
    expect((await app.inject(request)).statusCode).toBe(204);
    await app.close();
  });

  it('admits a signed foreign workspace Sync actor only with the authenticated source endpoint and proof', async () => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['workspace_sync'],
        // The application port/capability is the native OS boundary. The real
        // signed-handshake owner above it must preserve the admitted actor.
        resolveApplicationTarget: ({ handshake }) => handshake.accountId === 'requester-a'
          ? { port: 46001, localCapability: 'a'.repeat(64) } : null,
      },
    });
    const payload = createIrohMachineHandshake({
      flow: 'workspace_sync', accountId: 'requester-a',
      grantOverrides: { flowKind: 'machine_rpc', scope: {
        kind: 'machine_rpc', rpcScopeId: IROH_OPERATION_ID, allowedMethods: ['workspace.sync'],
        maxCalls: 1, maxIdleMs: 60_000, highRiskSingleUseMethods: ['workspace.sync'],
      } },
    });
    try {
      const accepted = await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID }, payload });
      expect(accepted.statusCode).toBe(204);
      expect(Number(accepted.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()])).toBe(46001);
      for (const request of [
        { payload, endpoint: 'c'.repeat(64) },
        { payload: { ...payload, accountId: 'substituted-actor' }, endpoint: IROH_SOURCE_ENDPOINT_ID },
        { payload: { ...payload, proof: { ...payload.proof, nonceBase64Url: toBase64Url(new Uint8Array(16).fill(7)) } },
          endpoint: IROH_SOURCE_ENDPOINT_ID },
      ]) {
        const refused = await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
          headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: request.endpoint }, payload: request.payload });
        expect(refused.statusCode).toBe(403);
        expect(refused.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it.each([
    { accountId: 'account_1', initiatorKind: 'machine' as const },
    { accountId: 'receiver-ann', initiatorKind: 'account_client' as const },
  ])('routes an admitted $initiatorKind finite-transfer stream directly to the existing transfer listener without another capability proxy', async actor => {
    const applicationBytes: Buffer[] = [];
    const applicationServer = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', (chunk: Buffer) => applicationBytes.push(chunk));
      socket.once('end', () => socket.end(Buffer.concat(applicationBytes)));
    });
    await new Promise<void>((resolve, reject) => {
      applicationServer.once('error', reject);
      applicationServer.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const applicationAddress = applicationServer.address();
    if (!applicationAddress || typeof applicationAddress === 'string') throw new Error('application listener did not bind');
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['finite_transfer'],
        resolveApplicationTarget: () => ({ port: applicationAddress.port }),
      },
    });

    try {
      if (actor.initiatorKind === 'account_client') {
        const signed = createIrohMachineHandshake(actor);
        for (const payload of [
          { ...signed, accountId: 'substituted-actor' },
          createIrohMachineHandshake({ ...actor, grantOverrides: { exp: 2_000 } }),
        ]) {
          const refused = await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
            headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID }, payload });
          expect(refused.statusCode).toBe(403);
          expect(refused.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).toBeUndefined();
        }
      }
      const admission = await app.inject({
        method: 'POST',
        url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
        payload: createIrohMachineHandshake(actor),
      });
      expect(admission.statusCode).toBe(204);
      expect(admission.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]).toBeUndefined();
      const applicationPort = Number(admission.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]);
      expect(applicationPort).toBe(applicationAddress.port);

      const client = connect({ host: '127.0.0.1', port: applicationPort, allowHalfOpen: true });
      await once(client, 'connect');
      const echoed = Promise.race([
        (once(client, 'data') as Promise<[Buffer]>).then(([chunk]) => chunk),
        once(client, 'close').then(() => null),
      ]);
      client.end(Buffer.from('finite-transfer-http-bytes'));
      await expect(echoed).resolves.toEqual(Buffer.from('finite-transfer-http-bytes'));
      expect(Buffer.concat(applicationBytes)).toEqual(Buffer.from('finite-transfer-http-bytes'));
      client.destroy();
    } finally {
      await app.close();
      await new Promise<void>((resolve) => applicationServer.close(() => resolve()));
    }
  });

  it('rejects a finite-transfer target that attempts to add a local capability layer', async () => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['finite_transfer'],
        resolveApplicationTarget: () => ({
          port: 46_001,
          localCapability: 'c'.repeat(64),
        }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
      payload: createIrohMachineHandshake(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).toBeUndefined();
    expect(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]).toBeUndefined();
    await app.close();
  });

  it('admits a real signed machine/1 handshake with a bodyless 204 and the exact endpoint echo', async () => {
    const app = createIrohAdmissionTestApp();
    const localCapabilities: string[] = [];

    for (const flow of ['finite_transfer', 'workspace_sync'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
        payload: createIrohMachineHandshake({ flow }),
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers[IROH_MACHINE_REMOTE_ENDPOINT_HEADER.toLowerCase()]).toBe(IROH_SOURCE_ENDPOINT_ID);
      if (flow === 'finite_transfer') {
        expect(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).toBe('46001');
        expect(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]).toBeUndefined();
      } else {
        expect(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).not.toBe('46001');
        expect(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]).toMatch(/^[0-9a-f]{64}$/);
        localCapabilities.push(String(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]));
      }
      expect(response.body).toBe('');
    }
    expect(new Set(localCapabilities).size).toBe(localCapabilities.length);

    await app.close();
  });

  it('does not register the admission route without explicit machine-Iroh config', async () => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
    });

    const response = await app.inject({
      method: 'POST',
      url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
      payload: createIrohMachineHandshake(),
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a verified handshake when no application loopback target is available', async () => {
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: IROH_TRUST_ROOTS,
      irohMachineAdmission: {
        localEndpointId: IROH_TARGET_ENDPOINT_ID,
        role: 'acceptor',
        allowedFlows: ['finite_transfer'],
        resolveApplicationTarget: () => null,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID },
      payload: createIrohMachineHandshake(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers[IROH_MACHINE_REMOTE_ENDPOINT_HEADER.toLowerCase()]).toBeUndefined();
    expect(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]).toBeUndefined();
    expect(response.body).toBe('');
    await app.close();
  });

  it('rejects every invalid admission with one stable non-2xx, no echo, and no reason detail', async () => {
    const app = createIrohAdmissionTestApp();
    const validHandshake = createIrohMachineHandshake();
    const remoteEndpointHeader = { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: IROH_SOURCE_ENDPOINT_ID };
    const cases: ReadonlyArray<Readonly<{
      name: string;
      headers?: Record<string, string>;
      omitHeaders?: boolean;
      payload: object;
    }>> = [
      { name: 'missing endpoint header', omitHeaders: true, payload: validHandshake },
      { name: 'malformed endpoint header', headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: 'not-an-endpoint-id' }, payload: validHandshake },
      // Node folds duplicate header lines into one comma-separated value; the strict endpoint grammar rejects it.
      { name: 'duplicate endpoint header', headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: `${IROH_SOURCE_ENDPOINT_ID}, ${IROH_SOURCE_ENDPOINT_ID}` }, payload: validHandshake },
      { name: 'wrong endpoint header', headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: 'c'.repeat(64) }, payload: validHandshake },
      { name: 'wrong target machine', headers: remoteEndpointHeader, payload: createIrohMachineHandshake({ targetMachineId: 'machine_other' }) },
      { name: 'removed legacy flow', headers: remoteEndpointHeader, payload: { ...validHandshake, flow: 'attachment_transfer' } },
      { name: 'expired grant', headers: remoteEndpointHeader, payload: createIrohMachineHandshake({ grantOverrides: { exp: 2_000 } }) },
      { name: 'invalid proof', headers: remoteEndpointHeader, payload: createIrohMachineHandshake({ breakProof: true }) },
      { name: 'malformed non-Iroh body', headers: remoteEndpointHeader, payload: { v: 1, grant: {}, nonceProof: {} } },
      { name: 'server_relay grant', headers: remoteEndpointHeader, payload: createCrossRouteGrantWireHandshake() },
      // A request can never select a destination: the strict handshake schema rejects unknown fields.
      { name: 'destination selection attempt', headers: remoteEndpointHeader, payload: { ...validHandshake, destination: { host: '127.0.0.1', port: 9 } } },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: 'POST',
        url: IROH_MACHINE_ADMISSION_PATH,
        ...(testCase.omitHeaders ? {} : { headers: testCase.headers ?? remoteEndpointHeader }),
        payload: testCase.payload,
      });

      expect(response.statusCode, testCase.name).toBe(403);
      expect(response.headers[IROH_MACHINE_REMOTE_ENDPOINT_HEADER.toLowerCase()], testCase.name).toBeUndefined();
      expect(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()], testCase.name).toBeUndefined();
      expect(response.body, testCase.name).toBe('');
    }

    await app.close();
  });
});
