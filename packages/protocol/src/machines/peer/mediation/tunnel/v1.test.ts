import { describe, expect, it } from 'vitest';

type TunnelV1Module = typeof import('./v1');

async function loadTunnelV1Module(): Promise<TunnelV1Module | null> {
  const modulePath = './v1.js';
  return import(modulePath).catch(() => null) as Promise<TunnelV1Module | null>;
}

describe('peer TCP tunnel v1 protocol', () => {
  it('parses open responses and data frames with JSON base64 payloads', async () => {
    const mod = await loadTunnelV1Module();

    expect(mod?.PeerTcpTunnelOpenResponseV1Schema.safeParse({
      v: 1,
      tunnelId: 'tun_1',
      streamPath: '/peer-mediation/v1/tunnel/stream',
      encoding: 'json_base64_v1',
      initialWindowBytes: 1024 * 1024,
      maxFrameBytes: 64 * 1024,
    }).success).toBe(true);

    expect(mod?.PeerTcpTunnelFrameV1Schema.safeParse({
      v: 1,
      kind: 'data',
      tunnelId: 'tun_1',
      direction: 'client_to_daemon',
      sequence: 0,
      payloadBase64: Buffer.from('hello').toString('base64'),
    }).success).toBe(true);
  });

  it('enforces encoded frame caps and decoded payload caps for data frames', async () => {
    const mod = await loadTunnelV1Module();
    const payloadBase64 = Buffer.from('hello').toString('base64');

    expect(mod?.validatePeerTcpTunnelDataFrameCaps({
      frame: {
        v: 1,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBase64,
      },
      maxEncodedFrameBytes: JSON.stringify({ payloadBase64 }).length + 128,
      maxDecodedPayloadBytes: 5,
    })).toEqual({ ok: true, decodedBytes: 5 });

    expect(mod?.validatePeerTcpTunnelDataFrameCaps({
      frame: {
        v: 1,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBase64,
      },
      maxEncodedFrameBytes: 4,
      maxDecodedPayloadBytes: 5,
    })).toEqual({ ok: false, reasonCode: 'encoded_frame_too_large' });

    expect(mod?.validatePeerTcpTunnelDataFrameCaps({
      frame: {
        v: 1,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadBase64,
      },
      maxEncodedFrameBytes: 1024,
      maxDecodedPayloadBytes: 4,
    })).toEqual({ ok: false, reasonCode: 'decoded_payload_too_large' });
  });

  it('requires structured reason codes on close frames', async () => {
    const mod = await loadTunnelV1Module();

    expect(mod?.PeerTcpTunnelFrameV1Schema.safeParse({
      v: 1,
      kind: 'close',
      tunnelId: 'tun_1',
      direction: 'client_to_daemon',
      halfClose: true,
      reasonCode: 'client_half_closed',
    }).success).toBe(true);

    expect(mod?.PeerTcpTunnelFrameV1Schema.safeParse({
      v: 1,
      kind: 'close',
      tunnelId: 'tun_1',
      direction: 'client_to_daemon',
      halfClose: true,
    }).success).toBe(false);
  });
});
