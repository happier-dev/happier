import {
  decodePeerTcpTunnelBinaryFrameV2,
  encodePeerTcpTunnelBinaryFrameV2,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  type DaemonVoiceInferenceSttStreamStartRequest,
  type PeerTcpTunnelFrameV1,
  type PeerTcpTunnelOpenResponseV1,
  type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import {
  createDaemonSpeechStreamCarrierAdapter,
  describeDaemonSpeechStreamRpcCompatibilityTransport,
} from './DaemonSpeechStreamCarrier';
import type { DaemonSpeechStreamTransportChunkRequest } from './DaemonSpeechStreamSender';

type DynamicModule = Record<string, unknown>;
type TestWebSocket = {
  binaryType?: string;
  sent: unknown[];
  onopen?: () => void;
  send: (payload: unknown) => void;
  close: () => void;
};
type TestStream = Readonly<{
  sendFrame: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => Promise<void> | void;
  close: () => Promise<void> | void;
}>;

async function loadModule(path: string): Promise<DynamicModule> {
  return import(path).catch((importError: unknown) => ({ importError }));
}

function createWebSocketFixture() {
  let socket: TestWebSocket | null = null;
  const getSocket = (): TestWebSocket => {
    if (!socket) throw new Error('expected websocket fixture');
    return socket;
  };
  const WebSocketCtor = vi.fn(() => {
    socket = {
      sent: [],
      send(payload: unknown) {
        this.sent.push(payload);
      },
      close: vi.fn(),
    };
    return getSocket();
  });
  return { getSocket, WebSocketCtor };
}

const open: PeerTcpTunnelOpenV1 = {
  v: 1,
  kind: 'open',
  tunnelId: 'tun_voice',
  targetMachineId: 'machine_1',
  routeKind: 'loopback_direct',
  destination: { host: '127.0.0.1', port: 3000 },
  selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
};

const response: PeerTcpTunnelOpenResponseV1 = {
  v: 1,
  tunnelId: 'tun_voice',
  streamPath: '/peer-mediation/v1/tunnel/stream',
  encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  initialWindowBytes: 1024,
  maxFrameBytes: 1024,
};

function startResponse(payload: DaemonVoiceInferenceSttStreamStartRequest) {
  return {
    ok: true as const,
    requestId: payload.requestId,
    streamId: 'stream-1',
    generation: 3,
    ackSeq: -1,
    format: payload.format,
  };
}

describe('DaemonSpeechStreamTunnelTransport', () => {
  it('forwards the streaming mode selected by the live sender contract', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const start = vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload));
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame: vi.fn(),
        close: vi.fn(),
      },
      controlTransport: {
        start,
        finish: vi.fn(),
        cancel: vi.fn(),
      },
    });

    await transport.start({
      requestId: 'request-1',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
      streamingMode: 'upload_bridge',
    }));
  });

  it('passes PCM bytes to the raw binary substream API when it is available', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendSubstreamDataFrame = vi.fn();
    const sendSubstreamFrame = vi.fn();
    const compatibilityChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame,
        close: vi.fn(),
      },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: compatibilityChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toMatchObject({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
    });

    expect(sendSubstreamDataFrame).toHaveBeenCalledWith('daemon.voiceInference.stt.stream-1.3', {
      tunnelId: 'tun_voice',
      direction: 'client_to_daemon',
      sequence: 5,
      payloadBytes: pcmBytes,
    });
    expect(sendSubstreamFrame).not.toHaveBeenCalled();
    expect(compatibilityChunk).not.toHaveBeenCalled();
  });

  it('resolves binary substream chunks with daemon-to-client partial and endpoint events', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    }>) => void) | null = null;
    const sendSubstreamDataFrame = vi.fn(async () => {
      queueMicrotask(() => {
        const response = {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: 5,
          events: [
            { type: 'partial', seq: 5, text: 'hel', isEndpoint: false, confidence: null },
            { type: 'endpoint', seq: 5, transcript: 'hello', reason: 'vad' },
          ],
        };
        substreamHandler?.({
          substreamId: 'daemon.voiceInference.stt.stream-1.3',
          frame: {
            v: 1,
            kind: 'data',
            tunnelId: 'tun_voice',
            direction: 'daemon_to_client',
            sequence: 5,
            payloadBase64: encodeBase64(new TextEncoder().encode(JSON.stringify(response))),
          },
        });
      });
    });
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame: vi.fn(),
        onSubstreamFrame: (handler: typeof substreamHandler) => {
          substreamHandler = handler;
          return () => {
            if (substreamHandler === handler) substreamHandler = null;
          };
        },
        close: vi.fn(),
      },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [
        { type: 'partial', seq: 5, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 5, transcript: 'hello', reason: 'vad' },
      ],
    });

    expect(sendSubstreamDataFrame).toHaveBeenCalledTimes(1);
  });

  it('appends a binary carrier frame through the peer TCP tunnel owner without invoking compatibility chunk RPC', async () => {
    const tunnelMod = await loadModule('@/sync/domains/machines/peer/mediation/tunnel');
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const openLoopbackStream = tunnelMod.openPeerTcpTunnelLoopbackStream;
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(openLoopbackStream).toBeTypeOf('function');
    expect(createTransport).toBeTypeOf('function');
    if (typeof openLoopbackStream !== 'function' || typeof createTransport !== 'function') return;

    const { getSocket, WebSocketCtor } = createWebSocketFixture();
    const streamPromise = openLoopbackStream({
      endpointUrl: 'http://127.0.0.1:1234/base',
      open,
      response,
      WebSocketCtor,
    }) as Promise<TestStream>;
    getSocket().onopen?.();
    const stream = await streamPromise;
    const compatibilityChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream,
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: compatibilityChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    const chunkResult = transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    });

    await vi.waitFor(() => expect(getSocket().sent.length).toBe(1));
    const responsePayload = new TextEncoder().encode(JSON.stringify({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [],
    }));
    (getSocket() as unknown as { onmessage?: (event: { data: Uint8Array }) => void }).onmessage?.({
      data: encodePeerTcpTunnelBinaryFrameV2({
        header: {
          version: 2,
          kind: 'data',
          tunnelId: 'tun_voice',
          substreamId: 'daemon.voiceInference.stt.stream-1.3',
          direction: 'daemon_to_client',
          sequence: 5,
          payloadLength: responsePayload.byteLength,
        },
        payload: responsePayload,
      }),
    });

    await expect(chunkResult).resolves.toEqual({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
      events: [],
    });

    expect(compatibilityChunk).not.toHaveBeenCalled();
    const sent = getSocket().sent[0];
    expect(sent).toBeInstanceOf(Uint8Array);
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
      frame: sent as Uint8Array,
      maxHeaderBytes: 1024,
      maxPayloadBytes: 1024,
    });
    expect(decoded).toMatchObject({
      ok: true,
      header: {
        version: 2,
        kind: 'data',
        tunnelId: 'tun_voice',
        substreamId: 'daemon.voiceInference.stt.stream-1.3',
        direction: 'client_to_daemon',
        sequence: 5,
        payloadLength: pcmBytes.byteLength,
      },
    });
    expect(decoded.ok ? [...decoded.payload] : []).toEqual([...pcmBytes]);
  });

  it('keeps JSON/base64 fallback explicit when a tunnel binary frame is not selected', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const fallbackChunk = vi.fn(async (payload: DaemonSpeechStreamTransportChunkRequest) => ({
      ok: true as const,
      streamId: payload.streamId,
      generation: payload.generation,
      ackSeq: payload.seq,
      events: [],
    }));
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: fallbackChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: false,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: describeDaemonSpeechStreamRpcCompatibilityTransport(),
    })).resolves.toMatchObject({
      ok: true,
      streamId: 'stream-1',
      generation: 3,
      ackSeq: 5,
    });

    expect(sendFrame).not.toHaveBeenCalled();
    expect(fallbackChunk).toHaveBeenCalledWith(expect.objectContaining({
      carrierFrame: expect.objectContaining({
        kind: 'json_base64_v1_fallback',
        jsonBase64Envelope: { pcm16Base64: 'AQIDBA==' },
      }),
      compatibilityTransport: expect.objectContaining({
        kind: 'machine_rpc_json_base64_compatibility',
      }),
    }));
  });

  it('fails closed for binary frames when the tunnel stream cannot append a bound substream frame', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const fallbackChunk = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
        finish: async (payload: { streamId: string; generation: number; finalSeq: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
          ackSeq: payload.finalSeq,
          finalText: '',
          language: null,
          modelPackId: null,
          events: [],
        }),
        cancel: async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        }),
      },
      fallbackTransport: { chunk: fallbackChunk },
    });
    const adapter = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    });
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_tunnel_substream_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendFrame).not.toHaveBeenCalled();
    expect(fallbackChunk).not.toHaveBeenCalled();
  });
});
