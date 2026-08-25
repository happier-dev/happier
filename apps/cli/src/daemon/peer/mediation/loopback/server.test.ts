import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  createDirectRouteGrantSigningInputV1,
  createDirectRouteGrantSigningInputV2,
  createEphemeralPeerRouteProofHandleV2,
  createPeerMachineRpcRequestHashV1,
  PEER_MEDIATION_RECEIPTS,
  type DirectRouteGrantPayloadV1,
  type DirectRouteGrantPayloadV2,
  type MachineLiveStreamFrameV1,
  type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPeerRouteNonceProofV1 } from '../verifyDirectRouteGrantV1';
import {
  assertPeerMediationLoopbackBindHost,
  createPeerMediationLoopbackApp,
  PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES,
  startPeerMediationLoopbackServer,
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
  it('answers browser CORS and private-network preflight for signed loopback requests', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
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

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/peer-mediation/v1/probe',
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
      headers: { origin: 'http://localhost:8081' },
      payload: {
        v: 1,
        grant,
        nonceProof,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
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

  it('admits a V2 live stream once with the canonical ephemeral proof', async () => {
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
    const app = createPeerMediationLoopbackApp({
      nowMs: () => 2_000,
      expected: {
        accountId: 'account_1', machineId: 'machine_1', flowKind: 'live_stream',
        routeKind: 'loopback_direct', endpointFingerprint: 'loopback_endpoint_1',
      },
      trustRoots: [{ keyId: 'grant-key-1', publicKey: toBase64Url(grantKeyPair.publicKey) }],
      stream: { captureAdapter: { start: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) throw new Error('capture boundary unavailable');
        return { ok: true, session: { stop: async () => undefined } };
      } } },
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

    const activationFailed = await app.inject({ method: 'POST', url: '/peer-mediation/v2/live-stream/start', payload });
    expect(activationFailed.json()).toMatchObject({ v: 2, ok: false, reasonCode: 'capture_start_failed' });
    const accepted = await app.inject({ method: 'POST', url: '/peer-mediation/v2/live-stream/start', payload });
    expect(accepted.json()).toMatchObject({ v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.streamStarted });
    const replay = await app.inject({ method: 'POST', url: '/peer-mediation/v2/live-stream/start', payload });
    expect(replay.json()).toMatchObject({ v: 2, ok: false, reasonCode: 'grant_already_consumed' });
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
      flowKind: 'tcp_tunnel' as const,
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

  it('rejects a non-loopback bind host through the composed start path, not only the guard', async () => {
    // Regression guard for review finding R2 F-1. The case above exercises the pure function only.
    // `assertPeerMediationLoopbackBindHost` has exactly one call site (`server.ts:277`); deleting it
    // left that case — and both halves of the PMS-2 acceptance gate — green while the daemon bound
    // every interface. This case pins the composed entry point, so removing the *invocation* of the
    // security boundary fails the gate, not just removing its implementation.
    const anyAddress = ['0', '0', '0', '0'].join('.');
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
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
            accountPublicKey: toBase64Url(accountKeyPair.publicKey),
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

  it('accepts a signed direct voice upload chunk larger than the legacy 64 KiB body limit', async () => {
    const grantKeyPair = tweetnacl.sign.keyPair();
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const method = RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK;
    const grant = createSignedMachineRpcGrant({
      signingSecretKey: grantKeyPair.secretKey,
      keyId: 'grant-key-1',
      endpointFingerprint: 'loopback_endpoint_1',
      allowedMethods: [method],
    });
    const nonceProof = createPeerRouteNonceProofV1({
      grantId: grant.payload.grantId,
      routeKind: 'loopback_direct',
      flowKind: 'machine_rpc',
      endpointFingerprint: 'loopback_endpoint_1',
      nonceBase64Url: 'nonce_voice_upload_1',
      accountSigningSeed: new Uint8Array(32).fill(7),
    });
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
        accountPublicKey: toBase64Url(accountKeyPair.publicKey),
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
    const replayKey = requestId;
    const payload = {
      v: 1 as const,
      requestId,
      method,
      params,
      grant,
      nonceProof,
      routeKind: 'loopback_direct' as const,
      flowKind: 'machine_rpc' as const,
      endpointFingerprint: 'loopback_endpoint_1',
      commandReceipt: {
        v: 1 as const,
        issuer: 'ui' as const,
        issuedAtMs: 2_000,
        requestHash: createPeerMachineRpcRequestHashV1({
          method,
          params,
          grantId: grant.payload.grantId,
          endpointFingerprint: 'loopback_endpoint_1',
          replayKey,
        }),
        replayKey,
      },
    };
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeGreaterThan(64 * 1024);

    const response = await app.inject({
      method: 'POST',
      url: '/peer-mediation/v1/rpc',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      v: 1,
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
      url: '/peer-mediation/v1/rpc',
      payload: { padding: 'A'.repeat(PEER_MEDIATION_LOOPBACK_BODY_LIMIT_BYTES) },
    });

    expect(response.statusCode).toBe(413);
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

  /**
   * Grant revocation is withdrawn — direct route grants are TTL-only (see lanes/D2.md §4) — so the
   * internal grant-revocation notification hook this test used to spy on no longer exists. The
   * quarantine itself is live, and is asserted where it is actually observable: the wire response.
   * That is a stronger contract than the old callback spy, which pinned an internal call that
   * nothing in production ever supplied.
   */
  it('quarantines a direct machine RPC grant on the wire after repeated nonce failures', async () => {
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
      },
    });

    const reasonCodes: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
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
      reasonCodes.push((response.json() as { reasonCode?: string }).reasonCode ?? '');
    }

    // Repeated bad nonces latch the quarantine, and the caller can see why it was cut off.
    expect(reasonCodes).toContain('quarantined');
    expect(reasonCodes[reasonCodes.length - 1]).toBe('quarantined');
    expect(reasonCodes.every((code) => code.length > 0)).toBe(true);

    await app.close();
  });
});
