import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

type TunnelRelayModule = typeof import('./index');

async function loadTunnelRelayModule(): Promise<TunnelRelayModule | null> {
  const modulePath = './index.js';
  return import(modulePath).catch(() => null) as Promise<TunnelRelayModule | null>;
}

describe('peer TCP tunnel relay protocol', () => {
  it('parses server relay envelopes without reusing transfer relay envelopes', async () => {
    const mod = await loadTunnelRelayModule();
    const parsed = mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse({
      v: 1,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      frame: {
        v: 1,
        kind: 'abort',
        tunnelId: 'tun_1',
        reasonCode: 'relay_disabled_by_server_policy',
      },
    });

    expect(parsed?.success).toBe(true);
    expect(mod?.PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT).toBe('peer:tunnel:v1');
  });

  it('parses same-event binary relay envelopes for negotiated V2 tunnel frames', async () => {
    const mod = await loadTunnelRelayModule();
    const binaryFrame = new Uint8Array([0, 0, 0, 2, 123, 125]);

    const parsed = mod?.PeerTcpTunnelRelayBinaryEnvelopeV2Schema.safeParse({
      v: 2,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      encoding: 'binary_frame_v2',
      frame: binaryFrame,
    });

    expect(parsed?.success).toBe(true);
    expect(mod?.PeerTcpTunnelRelayEnvelopeSchema.safeParse(parsed?.success ? parsed.data : null).success).toBe(true);
    expect(mod?.PeerTcpTunnelRelayBinaryEnvelopeV2Schema.safeParse({
      v: 2,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      encoding: 'binary_frame_v2',
      frame: Buffer.from(binaryFrame),
    }).success).toBe(true);
    const browserArrayBuffer = binaryFrame.buffer.slice(
      binaryFrame.byteOffset,
      binaryFrame.byteOffset + binaryFrame.byteLength,
    );
    const browserParsed = mod?.PeerTcpTunnelRelayBinaryEnvelopeV2Schema.safeParse({
      v: 2,
      scopeUserId: 'user_1',
      sender: { kind: 'machine', machineId: 'machine_1' },
      recipient: { kind: 'user' },
      encoding: 'binary_frame_v2',
      frame: browserArrayBuffer,
    });
    expect(browserParsed?.success).toBe(true);
    expect(browserParsed?.success ? browserParsed.data.frame : null).toBeInstanceOf(Uint8Array);
    expect(mod?.PeerTcpTunnelRelayBinaryEnvelopeV2Schema.safeParse({
      v: 2,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      encoding: 'binary_frame_v2',
      frame: 'not-binary',
    }).success).toBe(false);
  });

  it('requires server relay opens to carry authorization bound to the tunnel and destination', async () => {
    const mod = await loadTunnelRelayModule();
    const authorization = {
      payload: {
        v: 2,
        grantId: 'relay_grant_1',
        accountId: 'user_1',
        targetMachineId: 'machine_1',
        flowKind: 'tcp_tunnel',
        routeKind: 'server_relay',
        tunnelId: 'tun_1',
        relaySocketId: 'relay_socket_1',
        destination: { host: '127.0.0.1', port: 3000 },
        capProfileId: 'interactive',
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: 1_000,
        exp: 301_000,
        aud: 'happier-tcp-tunnel-relay-authorization',
      },
      signature: {
        keyId: 'relay_key_1',
        alg: 'Ed25519',
        valueBase64Url: 'AbCdEf012_-',
      },
    } as const;

    const openEnvelope = {
      v: 1,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      frame: {
        v: 1,
        kind: 'open',
        open: {
          v: 1,
          kind: 'open',
          tunnelId: 'tun_1',
          targetMachineId: 'machine_1',
          routeKind: 'server_relay',
          destination: { host: '127.0.0.1', port: 3000 },
          relayAuthorization: authorization,
        },
      },
    } as const;

    expect(mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse(openEnvelope).success).toBe(true);
    expect(mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse({
      ...openEnvelope,
      frame: {
        ...openEnvelope.frame,
        open: {
          ...openEnvelope.frame.open,
          relayAuthorization: undefined,
        },
      },
    }).success).toBe(false);
    expect(mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse({
      ...openEnvelope,
      frame: {
        ...openEnvelope.frame,
        open: {
          ...openEnvelope.frame.open,
          destination: { host: '127.0.0.1', port: 5173 },
        },
      },
    }).success).toBe(false);
  });

  it('strictly verifies V2 relay authorizations with the relay socket id inside the signature', async () => {
    const mod = await loadTunnelRelayModule();
    expect(mod?.verifyPeerTcpTunnelRelayAuthorizationV2).toBeTypeOf('function');
    if (!mod?.verifyPeerTcpTunnelRelayAuthorizationV2) return;

    const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const payload = {
      v: 2,
      grantId: 'relay_grant_v2_1',
      accountId: 'user_1',
      targetMachineId: 'machine_1',
      flowKind: 'tcp_tunnel',
      routeKind: 'server_relay',
      tunnelId: 'tun_v2_1',
      relaySocketId: 'relay_socket_a',
      destination: { host: '127.0.0.1', port: 3000 },
      capProfileId: 'interactive',
      maxFrameBytes: 64 * 1024,
      maxIdleMs: 30_000,
      maxDurationMs: 300_000,
      maxTotalBytes: 64 * 1024 * 1024,
      iat: 1_000,
      exp: 301_000,
      aud: 'happier-tcp-tunnel-relay-authorization',
    } as const;
    const authorization = {
      payload,
      signature: {
        keyId: 'relay_key_1',
        alg: 'Ed25519',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(
          new TextEncoder().encode(mod.createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload)),
          keyPair.secretKey,
        )).toString('base64url'),
      },
    } as const;
    const trustRoots = [{
      keyId: 'relay_key_1',
      publicKeyBase64Url: Buffer.from(keyPair.publicKey).toString('base64url'),
    }];

    expect(mod.verifyPeerTcpTunnelRelayAuthorizationV2({
      authorization,
      nowMs: 2_000,
      trustRoots,
    })).toEqual({ valid: true, payload });
    expect(mod.verifyPeerTcpTunnelRelayAuthorizationV2({
      authorization: {
        ...authorization,
        payload: { ...payload, relaySocketId: 'relay_socket_b' },
      },
      nowMs: 2_000,
      trustRoots,
    })).toEqual({ valid: false, reasonCode: 'bad_signature' });
    expect(mod.PeerTcpTunnelRelayAuthorizationV2Schema.safeParse({
      ...authorization,
      payload: { ...payload, unexpected: true },
    }).success).toBe(false);
    expect(mod.PeerTcpTunnelRelayAuthorizationV2Schema.safeParse({
      ...authorization,
      payload: { ...payload, destination: { ...payload.destination, unexpected: true } },
    }).success).toBe(false);
    expect(mod.PeerTcpTunnelRelayAuthorizationV2Schema.safeParse({
      ...authorization,
      payload: { ...payload, relaySocketId: 's'.repeat(mod.PEER_TCP_TUNNEL_RELAY_SOCKET_ID_MAX_LENGTH + 1) },
    }).success).toBe(false);
    expect(mod.verifyPeerTcpTunnelRelayAuthorizationV2({
      authorization: {
        ...authorization,
        payload: { ...payload, v: 1 },
      },
      nowMs: 2_000,
      trustRoots,
    })).toEqual({ valid: false, reasonCode: 'authorization_invalid' });
  });

  it('accepts only application-bound Voice media relay authority', async () => {
    const mod = await loadTunnelRelayModule();

    const parsed = mod?.PeerTcpTunnelRelayEnvelopeV1Schema.safeParse({
      v: 1,
      scopeUserId: 'user_1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine_1' },
      frame: {
        v: 1,
        kind: 'open',
        open: {
          v: 1,
          kind: 'open',
          tunnelId: 'voice-media:machine_1:request_1',
          targetMachineId: 'machine_1',
          routeKind: 'server_relay',
          destination: { host: '127.0.0.1', port: 3000 },
          relayAuthorization: {
            payload: {
              v: 2,
              grantId: 'relay_grant_voice_1',
              accountId: 'user_1',
              targetMachineId: 'machine_1',
              flowKind: 'voice_media',
              routeKind: 'server_relay',
              tunnelId: 'voice-media:machine_1:request_1',
              applicationKind: 'speech_transcription',
              applicationAttemptId: 'request_1',
              applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
              relaySocketId: 'relay_socket_1',
              destination: { host: '127.0.0.1', port: 3000 },
              capProfileId: 'machine_live_stream_relay_caps_v1',
              maxFrameBytes: 32_000,
              maxIdleMs: 30_000,
              maxDurationMs: 60_000,
              maxTotalBytes: 128_000,
              iat: 1_000,
              exp: 61_000,
              aud: 'happier-tcp-tunnel-relay-authorization',
            },
            signature: {
              keyId: 'relay_key_1',
              alg: 'Ed25519',
              valueBase64Url: 'AbCdEf012_-',
            },
          },
        },
      },
    });

    expect(parsed?.success).toBe(true);
    expect(mod?.PeerTcpTunnelRelayAuthorizationPayloadV2Schema.safeParse({
      ...(parsed?.success ? parsed.data.frame.kind === 'open'
        ? parsed.data.frame.open.relayAuthorization?.payload
        : {}
      : {}),
      applicationKind: undefined,
    }).success).toBe(false);
  });
});
