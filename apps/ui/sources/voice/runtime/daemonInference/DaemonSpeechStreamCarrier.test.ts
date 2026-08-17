import {
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  createDaemonSpeechStreamCarrierAdapter,
  describeDaemonSpeechStreamRpcCompatibilityTransport,
} from './DaemonSpeechStreamCarrier';

const PCM_BYTES = new Uint8Array([0, 1, 2, 3]);

describe('DaemonSpeechStreamCarrier', () => {
  it('represents binary-capable direct voice PCM chunks as bytes through the shared carrier profile', () => {
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });

    const frame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 2,
      seq: 3,
      pcm16Bytes: PCM_BYTES,
    });

    expect(frame).toMatchObject({
      kind: 'binary_tunnel_frame_v2',
      frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
      profile: {
        routeKind: 'loopback_direct',
        deliveryMode: 'input_append',
        streamKind: 'audio_pcm',
        payloadShape: 'bytes',
      },
      sequence: {
        streamId: 'stream-1',
        generation: 2,
        seq: 3,
      },
    });
    if (frame.kind !== 'binary_tunnel_frame_v2') {
      throw new Error('expected binary tunnel frame');
    }
    expect(frame.payloadBytes).toBeInstanceOf(Uint8Array);
    expect([...frame.payloadBytes]).toEqual([...PCM_BYTES]);
    expect('pcm16Base64' in frame).toBe(false);
  });

  it('uses bytes and binary_frame_v2 for binary-capable relay tunnel voice PCM chunks', () => {
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'server_relay',
      binaryCapable: true,
    });

    const frame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 2,
      seq: 3,
      pcm16Bytes: PCM_BYTES,
    });

    expect(frame).toMatchObject({
      kind: 'binary_tunnel_frame_v2',
      frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
      profile: {
        routeKind: 'server_relay',
        deliveryMode: 'input_append',
        streamKind: 'audio_pcm',
        payloadShape: 'bytes',
      },
    });
    if (frame.kind !== 'binary_tunnel_frame_v2') {
      throw new Error('expected binary tunnel frame');
    }
    expect(frame.payloadBytes).toBeInstanceOf(Uint8Array);
    expect([...frame.payloadBytes]).toEqual([...PCM_BYTES]);
  });

  it('keeps JSON/base64 as an explicit named fallback carrier', () => {
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'server_relay',
      binaryCapable: false,
    });

    const frame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 2,
      seq: 3,
      pcm16Bytes: PCM_BYTES,
    });

    expect(frame).toMatchObject({
      kind: 'json_base64_v1_fallback',
      frameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
      fallbackReason: 'carrier_binary_unavailable',
      profile: {
        routeKind: 'server_relay',
        deliveryMode: 'input_append',
        streamKind: 'audio_pcm',
        payloadShape: 'json_base64_envelope',
      },
      jsonBase64Envelope: {
        pcm16Base64: 'AAECAw==',
      },
    });
    if (frame.kind !== 'json_base64_v1_fallback') {
      throw new Error('expected JSON/base64 fallback frame');
    }
    expect('payloadBytes' in frame).toBe(false);
  });

  it('describes the actual JSON/base64 compatibility transport without stale delivery milestones', () => {
    expect(describeDaemonSpeechStreamRpcCompatibilityTransport()).toEqual({
      kind: 'machine_rpc_json_base64_compatibility',
      carrierFrameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
      payloadShape: 'json_base64_envelope',
    });
  });
});
