import { describe, expect, it } from 'vitest';

import {
  decodePeerTcpTunnelBinaryFrameV2,
  encodePeerTcpTunnelBinaryFrameV2,
  negotiatePeerTcpTunnelEncoding,
  PeerTcpTunnelBinaryFrameHeaderV2Schema,
  PeerTcpTunnelSubstreamFrameV2Schema,
} from './index';

describe('Peer TCP tunnel V2 encoding', () => {
  it('negotiates binary_frame_v2 ahead of json_base64_v1 when both peers support it', () => {
    expect(negotiatePeerTcpTunnelEncoding({
      clientSupported: ['json_base64_v1', 'binary_frame_v2'],
      serverSupported: ['json_base64_v1', 'binary_frame_v2'],
      allowV1Fallback: true,
    })).toEqual({ ok: true, encoding: 'binary_frame_v2' });
  });

  it('falls back to json_base64_v1 only when fallback is explicitly allowed', () => {
    expect(negotiatePeerTcpTunnelEncoding({
      clientSupported: ['json_base64_v1'],
      serverSupported: ['json_base64_v1', 'binary_frame_v2'],
      allowV1Fallback: true,
    })).toEqual({ ok: true, encoding: 'json_base64_v1' });
    expect(negotiatePeerTcpTunnelEncoding({
      clientSupported: ['json_base64_v1'],
      serverSupported: ['json_base64_v1', 'binary_frame_v2'],
      allowV1Fallback: false,
    })).toEqual({ ok: false, reasonCode: 'encoding_unsupported' });
  });

  it('encodes binary_frame_v2 metadata separately from raw payload bytes', () => {
    const payload = new TextEncoder().encode('hello');
    const encoded = encodePeerTcpTunnelBinaryFrameV2({
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadLength: payload.byteLength,
      },
      payload,
    });

    expect(encoded.byteLength).toBeGreaterThan(payload.byteLength);
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
      frame: encoded,
      maxHeaderBytes: 1024,
      maxPayloadBytes: 1024,
    });

    expect(decoded).toEqual({
      ok: true,
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadLength: 5,
      },
      payload,
    });
  });

  it('rejects malformed binary_frame_v2 payload lengths and oversized headers', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodePeerTcpTunnelBinaryFrameV2({
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tun_1',
        direction: 'client_to_daemon',
        sequence: 0,
        payloadLength: 4,
      },
      payload,
    });

    expect(decodePeerTcpTunnelBinaryFrameV2({
      frame: encoded,
      maxHeaderBytes: 1024,
      maxPayloadBytes: 1024,
    })).toEqual({ ok: false, reasonCode: 'payload_length_mismatch' });
    expect(decodePeerTcpTunnelBinaryFrameV2({
      frame: encoded,
      maxHeaderBytes: 1,
      maxPayloadBytes: 1024,
    })).toEqual({ ok: false, reasonCode: 'header_too_large' });
  });

  it('carries ack, close, and abort metadata in the binary_frame_v2 header', () => {
    expect(PeerTcpTunnelBinaryFrameHeaderV2Schema.parse({
      version: 2,
      kind: 'ack',
      tunnelId: 'tun_1',
      direction: 'daemon_to_client',
      ack: 64,
      window: 1024,
      payloadLength: 0,
    }).ack).toBe(64);

    expect(PeerTcpTunnelBinaryFrameHeaderV2Schema.parse({
      version: 2,
      kind: 'close',
      tunnelId: 'tun_1',
      direction: 'client_to_daemon',
      halfClose: true,
      reasonCode: 'client_half_closed',
      payloadLength: 0,
    }).halfClose).toBe(true);

    expect(PeerTcpTunnelBinaryFrameHeaderV2Schema.parse({
      version: 2,
      kind: 'abort',
      tunnelId: 'tun_1',
      reasonCode: 'relay_cap_exceeded',
      payloadLength: 0,
    }).reasonCode).toBe('relay_cap_exceeded');
  });
});

describe('Peer TCP tunnel V2 substream protocol', () => {
  it('accepts substream lifecycle frames with per-substream ids', () => {
    expect(PeerTcpTunnelSubstreamFrameV2Schema.parse({
      version: 2,
      kind: 'open',
      tunnelId: 'tun_1',
      substreamId: 'sub_1',
      destination: { host: '127.0.0.1', port: 3000 },
    }).substreamId).toBe('sub_1');
    expect(PeerTcpTunnelSubstreamFrameV2Schema.parse({
      version: 2,
      kind: 'data',
      tunnelId: 'tun_1',
      substreamId: 'sub_1',
      direction: 'client_to_daemon',
      sequence: 0,
      payloadLength: 5,
    }).payloadLength).toBe(5);
    expect(PeerTcpTunnelSubstreamFrameV2Schema.parse({
      version: 2,
      kind: 'close',
      tunnelId: 'tun_1',
      substreamId: 'sub_1',
      direction: 'client_to_daemon',
      halfClose: true,
      reasonCode: 'done',
    }).halfClose).toBe(true);
  });
});
