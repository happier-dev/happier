import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  createDirectRouteGrantSigningInputV1,
  PEER_MEDIATION_RECEIPTS,
  type DirectRouteGrantPayloadV1,
  type MachineLiveStreamFrameV1,
  type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPeerRouteNonceProofV1 } from '../verifyDirectRouteGrantV1';
import {
  assertPeerMediationLoopbackBindHost,
  createPeerMediationLoopbackApp,
} from './server';

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function createSignedGrant(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
}>): SignedDirectRouteGrantV1 {
  const payload: DirectRouteGrantPayloadV1 = {
    v: 1,
    grantId: 'grant_1',
    grantFamilyId: 'family_1',
    accountId: 'account_1',
    machineId: 'machine_1',
    flowKind: 'bounded_transfer',
    routeKind: 'loopback_direct',
    scope: {
      kind: 'bounded_transfer',
      mode: 'single',
      transferId: 'transfer_1',
      maxBytes: 1024,
    },
    iat: 1_000,
    exp: 601_000,
    aud: 'happier-daemon-route-grant',
    endpointFingerprint: input.endpointFingerprint,
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8'),
        input.signingSecretKey,
      )),
    },
  };
}

function createSignedMachineRpcGrant(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
  allowedMethods: readonly string[];
}>): SignedDirectRouteGrantV1 {
  const payload: DirectRouteGrantPayloadV1 = {
    v: 1,
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
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8'),
        input.signingSecretKey,
      )),
    },
  };
}

function createSignedLiveStreamGrant(input: Readonly<{
  signingSecretKey: Uint8Array;
  keyId: string;
  endpointFingerprint: string;
}>): SignedDirectRouteGrantV1 {
  const payload: DirectRouteGrantPayloadV1 = {
    v: 1,
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
  };
  return {
    payload,
    signature: {
      keyId: input.keyId,
      alg: 'Ed25519',
      valueBase64Url: toBase64Url(tweetnacl.sign.detached(
        Buffer.from(createDirectRouteGrantSigningInputV1(payload), 'utf8'),
        input.signingSecretKey,
      )),
    },
  };
}

function createLiveStreamFrame(sequence = 1): MachineLiveStreamFrameV1 {
  return {
    v: 1,
    streamId: 'stream_1',
    sequence,
    timestampMs: 2_000 + sequence,
    payloadKind: sequence === 1 ? 'image_keyframe' : 'image_delta',
    payloadEncoding: 'binary_base64',
    payloadBase64: 'AQID',
    payloadSizeBytes: 3,
  };
}

type TestLiveStreamCaptureStartInput = Readonly<{
  offerFrame: (
    frame: MachineLiveStreamFrameV1,
  ) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
}>;

describe('peer mediation loopback server', () => {
  it('accepts a probe only after grant, nonce, and endpoint binding verify', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'bounded_transfer',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/probe',
      payload: {
        v: 1,
        grant,
        nonceProof,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      v: 1,
      ok: true,
      receipt: 'peer.route.selected',
      routeKind: 'loopback_direct',
      flowKind: 'bounded_transfer',
      endpointFingerprint: 'loopback_endpoint_1',
    });

    await app.close();
  });

  it('returns route fallback when endpoint binding does not match', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'bounded_transfer',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'bounded_transfer',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'other_endpoint',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/probe',
      payload: {
        v: 1,
        grant,
        nonceProof,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      v: 1,
      ok: false,
      receipt: 'peer.route.fallback',
      reasonCode: 'grant_endpoint_mismatch',
    });

    await app.close();
  });

  it('starts direct live streams through the existing loopback app after grant, nonce, and capture verification', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedLiveStreamGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'live_stream',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    const emittedFrames: MachineLiveStreamFrameV1[] = [];
    const appOptions = {
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'live_stream',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      stream: {
        captureAdapter: {
          start: async (input: TestLiveStreamCaptureStartInput) => {
            const offered = input.offerFrame(createLiveStreamFrame(1));
            return offered.ok
              ? { ok: true as const, session: { stop: async () => undefined } }
              : { ok: false as const, reasonCode: offered.reasonCode };
          },
        },
        emitFrame: (next: MachineLiveStreamFrameV1) => emittedFrames.push(next),
      },
    } as const;
    const app = createPeerMediationLoopbackApp(appOptions);

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/live-stream/start',
      payload: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        flowKind: 'live_stream',
        endpointFingerprint: 'loopback_endpoint_1',
        grant,
        nonceProof,
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
      v: 1,
      ok: true,
      receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
      streamId: 'stream_1',
      routeKind: 'loopback_direct',
    });
    expect(emittedFrames.map((next) => next.sequence)).toEqual([1]);

    await app.close();
  });

  it('fails closed when direct live-stream capture is unavailable', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedLiveStreamGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'live_stream',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'live_stream',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      stream: {},
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/live-stream/start',
      payload: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'loopback_direct',
        flowKind: 'live_stream',
        endpointFingerprint: 'loopback_endpoint_1',
        grant,
        nonceProof,
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
      v: 1,
      ok: false,
      receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
      reasonCode: 'capture_unavailable',
    });

    await app.close();
  });

  it('exposes direct TCP tunnel open and stream routes on the production loopback app when configured', async () => {
    const openTunnel = async () => ({
      ok: true as const,
      response: {
        v: 1 as const,
        tunnelId: 'tun_1',
        streamPath: '/peer-mediation/v1/tunnel/stream' as const,
        encoding: 'json_base64_v1' as const,
        initialWindowBytes: 1024 * 1024,
        maxFrameBytes: 64 * 1024,
      },
      receipt: PEER_MEDIATION_RECEIPTS.tunnelOpened,
      connection: { close: async () => undefined },
      limits: {
        maxIdleMs: 30_000,
        maxDurationMs: 120_000,
      },
    });
    const appOptions = {
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(new Uint8Array(32).fill(7)),
      },
      trustRoots: [],
      tunnel: { openTunnel },
    } satisfies Parameters<typeof createPeerMediationLoopbackApp>[0] & { tunnel: unknown };
    const app = createPeerMediationLoopbackApp(appOptions);

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/tunnel/open',
      payload: {
        v: 1,
        kind: 'open',
        tunnelId: 'tun_1',
        targetMachineId: 'machine_1',
        routeKind: 'loopback_direct',
        destination: { host: '127.0.0.1', port: 3000 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tunnelId: 'tun_1',
      streamPath: '/peer-mediation/v1/tunnel/stream',
    });
    await app.ready();
    expect(typeof (app as unknown as { injectWS?: unknown }).injectWS).toBe('function');
    expect(app.server.listening).toBe(false);

    await app.close();
  });

  it('rejects non-loopback bind hosts before startup', () => {
    const anyAddress = ['0', '0', '0', '0'].join('.');
    expect(assertPeerMediationLoopbackBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(assertPeerMediationLoopbackBindHost('localhost')).toBe('localhost');
    expect(assertPeerMediationLoopbackBindHost('::1')).toBe('::1');
    expect(() => assertPeerMediationLoopbackBindHost(anyAddress)).toThrow(/loopback/i);
    expect(() => assertPeerMediationLoopbackBindHost('192.168.1.20')).toThrow(/loopback/i);
    expect(() => assertPeerMediationLoopbackBindHost('127.not-a-host')).toThrow(/loopback/i);
  });

  it('executes direct machine RPC only after grant, nonce, method policy, and endpoint binding verify', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async (method: string, params: unknown) => ({ method, params, ok: true }),
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/rpc',
      payload: {
        v: 1,
        requestId: 'request_1',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant,
        nonceProof,
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'loopback_endpoint_1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      v: 1,
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

    await app.close();
  });

  it('does not invoke direct machine RPC handlers for server-required methods', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.SPAWN_HAPPY_SESSION],
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    let invoked = false;
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
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
      url: '/peer-mediation/v1/rpc',
      payload: {
        v: 1,
        requestId: 'request_2',
        method: RPC_METHODS.SPAWN_HAPPY_SESSION,
        params: { prompt: 'hello' },
        grant,
        nonceProof,
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'loopback_endpoint_1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 1,
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
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
    let invoked = false;
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
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
      url: '/peer-mediation/v1/rpc',
      payload: {
        v: 1,
        requestId: 'request_route_mismatch',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant,
        nonceProof,
        routeKind: 'lan_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'loopback_endpoint_1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 1,
      ok: false,
      receipt: 'peer.rpc.fell_back_to_server',
      requestId: 'request_route_mismatch',
      method: RPC_METHODS.DAEMON_MEMORY_STATUS,
      reasonCode: 'grant_scope_mismatch',
    });
    expect(invoked).toBe(false);

    await app.close();
  });

  it('revokes a known direct machine RPC grant when nonce failures trigger quarantine', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS],
    });
    const badNonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_1',
      accountSigningSeed: new Uint8Array(32).fill(8),
    });
    const revoked: Array<Readonly<{ grantId: string; grantFamilyId?: string }>> = [];
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1',
        machineId: 'machine_1',
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        endpointFingerprint: 'loopback_endpoint_1',
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
      },
      trustRoots: [{
        keyId: 'grant-key-1',
        publicKey: toBase64Url(grantKeyPair.publicKey),
      }],
      rpc: {
        rpcHandlerManager: {
          invokeLocal: async () => ({ ok: true }),
        },
        revokeGrant: (input) => {
          revoked.push(input);
        },
      },
    });

    for (let index = 0; index < 5; index += 1) {
      await app.inject({
        method: 'POST',
        url: '/peer-mediation/v1/rpc',
        payload: {
          v: 1,
          requestId: `request_${index}`,
          method: RPC_METHODS.DAEMON_MEMORY_STATUS,
          params: {},
          grant,
          nonceProof: badNonceProof,
          routeKind: 'loopback_direct',
          flowKind: 'machine_rpc',
          endpointFingerprint: 'loopback_endpoint_1',
        },
      });
    }

    expect(revoked).toEqual([{
      grantId: grant.payload.grantId,
      grantFamilyId: grant.payload.grantFamilyId,
    }]);

    await app.close();
  });
});
