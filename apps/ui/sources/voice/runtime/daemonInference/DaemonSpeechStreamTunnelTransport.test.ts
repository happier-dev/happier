import {
  decodePeerTcpTunnelBinaryFrameV2,
  encodePeerTcpTunnelBinaryFrameV2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import {
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import {
  MACHINE_STREAM_KEY_TAG_BYTES_V1,
  createMachineStreamKeyAadV1,
  createMachineStreamKeyNonceV1} from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import {
  encodeBase64 as encodeProtocolBase64} from '@happier-dev/protocol/crypto/base64';
import {
  type DaemonVoiceInferenceSttStreamStartRequest} from '@happier-dev/protocol/daemon/voiceInference';
import {
  type PeerTcpTunnelOpenResponseV1,
  type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';

import { encodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';

import {
  createDaemonSpeechStreamCarrierAdapter,
  describeDaemonSpeechStreamRpcCompatibilityTransport,
} from './DaemonSpeechStreamCarrier';

type DynamicModule = Record<string, unknown>;
type TestWebSocket = {
  binaryType?: string;
  sent: unknown[];
  onopen?: () => void;
  send: (payload: unknown) => void;
  close: () => void;
};
type TestStream = Readonly<{
  sendFrame: (frame: PeerTcpTunnelFrame) => Promise<void> | void;
  close: () => Promise<void> | void;
}>;

async function loadModule(path: string): Promise<DynamicModule> {
  return import(path).catch((importError: unknown) => ({ importError }));
}

function createWebSocketFixture() {
  const frameSent = createDeferred<void>();
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
        frameSent.resolve();
      },
      close: vi.fn(),
    };
    return getSocket();
  });
  return { getSocket, WebSocketCtor, frameSent: frameSent.promise };
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

describe('negotiated PCM packet budget', () => {
  it('fits a sealed packet (PCM plus one tag) in the negotiated tunnel frame', async () => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: 'budget', maxFrameBytes: 1024,
      stream: { sendFrame: vi.fn(), sendSubstreamDataFrame: vi.fn(), sendSubstreamFrame: vi.fn(), onSubstreamFrame: () => () => {} },
      controlTransport: { startWithContentMode: vi.fn(), finish: vi.fn(), cancel: vi.fn() },
    });
    const budget = transport.maxPcm16ChunkBytes;
    if (budget === undefined) throw new Error('missing negotiated PCM budget');
    expect(budget % 2).toBe(0);
    expect(budget + MACHINE_STREAM_KEY_TAG_BYTES_V1).toBeLessThanOrEqual(1024);
    expect(budget + 2 + MACHINE_STREAM_KEY_TAG_BYTES_V1).toBeGreaterThan(1024);
    for (const pcmBytes of [0, 2, 4, budget]) {
      expect(transport.measureInFlightChunkBytes?.(pcmBytes)).toBe(pcmBytes + MACHINE_STREAM_KEY_TAG_BYTES_V1);
    }
  });
});

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
  it('fails closed without sending a frame when an E2EE Machine RPC start returns no stream key', async () => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const failure = vi.fn();
    const sendSubstreamDataFrame = vi.fn();
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3 }));
    const keylessStart = async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload);
    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: open.tunnelId,
      stream: { sendFrame: vi.fn(), sendSubstreamDataFrame, onSubstreamFrame: () => () => {} },
      onRelayEncryptionFailure: failure,
      controlTransport: {
        // The Machine RPC owner sealed this start E2EE; key presence never decides the mode.
        startWithContentMode: async payload => ({ response: await keylessStart(payload), contentMode: 'e2ee' as const }),
        finish: async () => { throw new Error('unused finish'); }, cancel,
      },
    });
    await expect(transport.start({ requestId: 'request-1', packId: null, language: null, format: {
      sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le',
    } })).resolves.toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(failure).toHaveBeenCalledWith({ step: 'key_prepare', reason: 'unavailable' });
    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 3 });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true })
      .encodeInputAppendFrame({ streamId: 'stream-1', generation: 3, seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) });
    await expect(transport.chunk({ streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null }))
      .resolves.toMatchObject({ ok: false, error: 'daemon_voice_inference_stream_not_started' });
    expect(sendSubstreamDataFrame).not.toHaveBeenCalled();
  });

  it('cancels the daemon stream and fails closed when the issued stream key is malformed', async () => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const failure = vi.fn();
    const sendSubstreamDataFrame = vi.fn();
    const cancel = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3 }));
    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: open.tunnelId,
      stream: { sendFrame: vi.fn(), sendSubstreamDataFrame, onSubstreamFrame: () => () => {} },
      onRelayEncryptionFailure: failure,
      controlTransport: {
        // A schema-bypassing malformed key must never degrade to plain frames.
        startWithContentMode: async payload => ({ response: { ...startResponse(payload), streamKeyBase64Url: 'AAAA' }, contentMode: 'e2ee' as const }),
        finish: async () => { throw new Error('unused finish'); }, cancel,
      },
    });
    await expect(transport.start({ requestId: 'request-1', packId: null, language: null, format: {
      sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le',
    } })).resolves.toMatchObject({ ok: false, errorCode: 'internal_error' });
    expect(failure).toHaveBeenCalledWith({ step: 'key_prepare', reason: 'failed' });
    expect(cancel).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 3 });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true })
      .encodeInputAppendFrame({ streamId: 'stream-1', generation: 3, seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) });
    await expect(transport.chunk({ streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null }))
      .resolves.toMatchObject({ ok: false, error: 'daemon_voice_inference_stream_not_started' });
    expect(sendSubstreamDataFrame).not.toHaveBeenCalled();
  });

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
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: await start(payload), contentMode: 'plain' as const }),
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

  it.each(['healthy', 'send', 'open', 'parse'] as const)('seals keyed frames with the issued stream key and retains private %s failures', async failureStage => {
    const { createDaemonSpeechStreamTunnelTransport: createTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const streamKey = new Uint8Array(32).fill(9);
    const aad = createMachineStreamKeyAadV1({ streamId: 'stream-1', generation: 3 });
    let handler: ((event: any) => void) | null = null;
    let sendError: unknown = null;
    const sentPayloads: Uint8Array[] = [];
    const networkFailure = new Error('network boundary refused data');
    const onRelayAuthenticatedEvidence = vi.fn();
    const sendSubstreamDataFrame = vi.fn(async (substreamId: string, outbound: any) => {
      try {
        sentPayloads.push(new Uint8Array(outbound.payloadBytes));
        if (failureStage === 'send') throw networkFailure;
        const requestPlaintext = await openAes256GcmBytes({
          key: streamKey, nonce: createMachineStreamKeyNonceV1('client_to_daemon', outbound.sequence), aad,
          ciphertext: outbound.payloadBytes,
        });
        expect([...requestPlaintext]).toEqual([0, 0, 1, 0]);
        const responseCiphertext = await sealAes256GcmBytes({
          key: streamKey, nonce: createMachineStreamKeyNonceV1('daemon_to_client', outbound.sequence), aad,
          plaintext: new TextEncoder().encode(JSON.stringify(failureStage === 'parse'
            ? { ok: true, unexpected: true }
            : { ok: true, streamId: 'stream-1', generation: 3, ackSeq: 0, events: [] })),
        });
        if (failureStage === 'open') responseCiphertext[0] ^= 1;
        handler?.({ substreamId, frame: {
          v: 1, kind: 'data', tunnelId: 'tun_voice', direction: 'daemon_to_client',
          sequence: outbound.sequence, payload: responseCiphertext,
        } });
      } catch (error) {
        if (error !== networkFailure) sendError = error;
        throw error;
      }
    });
    const finish = vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3, ackSeq: 0,
      finalText: 'hello', language: 'en', modelPackId: 'stt-pack-1', events: [] }));
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        onSubstreamFrame: vi.fn((next) => { handler = next; return () => { handler = null; }; }),
      },
      onRelayAuthenticatedEvidence,
      controlTransport: {
        startWithContentMode: vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ contentMode: 'e2ee' as const, response: {
          ...startResponse(payload), streamKeyBase64Url: encodeProtocolBase64(streamKey, 'base64url'),
        } })),
        finish,
        cancel: vi.fn(async () => ({ ok: true as const, streamId: 'stream-1', generation: 3 })),
      },
    });
    await expect(transport.start({
      requestId: 'request-encrypted', packId: null, language: null, streamingMode: 'runtime',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    })).resolves.toMatchObject({ ok: true });
    expect(onRelayAuthenticatedEvidence).not.toHaveBeenCalled();
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true })
      .encodeInputAppendFrame({ streamId: 'stream-1', generation: 3, seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) });
    const chunk = await transport.chunk({
      streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null,
    });
    expect(sendError).toBeNull();
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.byteLength).toBe(4 + MACHINE_STREAM_KEY_TAG_BYTES_V1);
    if (failureStage !== 'healthy') {
      expect(chunk).toMatchObject({ ok: false, error: 'daemon_voice_inference_relay_encryption_failed', errorCode: 'internal_error' });
      const cause = Object.getOwnPropertyDescriptor(chunk, 'cause');
      expect(cause?.enumerable).toBe(false);
      expect(cause?.value).toBeInstanceOf(Error);
      expect(cause?.value.message).toBe(`daemon_voice_inference_relay_${failureStage}_failed`);
      expect(cause?.value.cause).toBeInstanceOf(Error);
      if (failureStage === 'send') expect(cause?.value.cause).toBe(networkFailure);
      expect(JSON.stringify(chunk)).not.toContain('cause');
      // A sealed sequence is never sealed again under the same key.
      await expect(transport.chunk({ streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null }))
        .resolves.toMatchObject({ ok: false, error: 'daemon_voice_inference_relay_encryption_failed' });
      expect(sentPayloads).toHaveLength(1);
      await transport.cancel({ streamId: 'stream-1', generation: 3 });
      return;
    }
    expect(chunk).toMatchObject({ ok: true, ackSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'data', ackSeq: 0 });
    // The transcript-bearing finish rides the E2EE Machine RPC, not the tunnel.
    await expect(transport.finish({ streamId: 'stream-1', generation: 3, finalSeq: 0 }))
      .resolves.toMatchObject({ ok: true, finalText: 'hello' });
    expect(finish).toHaveBeenCalledWith({ streamId: 'stream-1', generation: 3, finalSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'finish', ackSeq: 0 });
    expect(sentPayloads).toHaveLength(1);
    // A retired keyed stream never falls back to plain frames.
    await expect(transport.chunk({ streamId: 'stream-1', generation: 3, seq: 1, carrierFrame, compatibilityTransport: null }))
      .resolves.toMatchObject({ ok: false, error: 'daemon_voice_inference_stream_not_started' });
    expect(sentPayloads).toHaveLength(1);
  });

  it('fails closed before sending PCM when the binary substream has no response owner', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendSubstreamDataFrame = vi.fn();
    const sendSubstreamFrame = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        sendSubstreamFrame,
        close: vi.fn(),
      },
      controlTransport: {
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
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
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    await transport.start({ requestId: 'request-1', packId: null, language: null, format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' } });
    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_substream_response_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendSubstreamDataFrame).not.toHaveBeenCalled();
    expect(sendSubstreamFrame).not.toHaveBeenCalled();
  });

  it('rejects a matching application-substream abort immediately instead of waiting for response timeout', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: import('@happier-dev/peer-transport/duplexFrames').PeerTcpTunnelFrame;
    }>) => void) | null = null;
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame: vi.fn(async () => {
          queueMicrotask(() => substreamHandler?.({
            substreamId: 'daemon.voiceInference.stt.stream-1.3',
            frame: {
              v: 1,
              kind: 'abort',
              tunnelId: 'tun_voice',
              reasonCode: 'application_dispatch_failed',
            },
          }));
        }),
        onSubstreamFrame: (handler: typeof substreamHandler) => {
          substreamHandler = handler;
          return () => { substreamHandler = null; };
        },
      },
      controlTransport: {
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
        finish: vi.fn(),
        cancel: vi.fn(),
      },
      responseTimeoutMs: 5_000,
    });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({
      routeKind: 'loopback_direct',
      binaryCapable: true,
    }).encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    });

    await transport.start({ requestId: 'request-1', packId: null, language: null, format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' } });
    await expect(transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 0,
      carrierFrame,
      compatibilityTransport: null,
    })).rejects.toThrow('daemon_voice_inference_substream_aborted:application_dispatch_failed');
  });

  it('resolves binary substream chunks with daemon-to-client partial and endpoint events', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: PeerTcpTunnelFrame;
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
            payload: new TextEncoder().encode(JSON.stringify(response)),
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
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
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

    await transport.start({ requestId: 'request-1', packId: null, language: null, format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' } });
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

    const { getSocket, WebSocketCtor, frameSent } = createWebSocketFixture();
    const streamPromise = openLoopbackStream({
      endpointUrl: 'http://127.0.0.1:1234/base',
      open,
      response,
      WebSocketCtor,
    }) as Promise<TestStream>;
    getSocket().onopen?.();
    const stream = await streamPromise;
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream,
      controlTransport: {
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
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
    const pcmBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const carrierFrame = adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      pcm16Bytes: pcmBytes,
    });

    await transport.start({ requestId: 'request-1', packId: null, language: null, format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' } });
    const chunkResult = transport.chunk({
      streamId: 'stream-1',
      generation: 3,
      seq: 5,
      carrierFrame,
      compatibilityTransport: null,
    });

    await frameSent;
    expect(getSocket().sent.length).toBe(1);
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

  it('refuses a JSON/base64 carrier frame instead of switching this tunnel to per-chunk RPC', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
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
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_binary_tunnel_required',
      errorCode: 'internal_error',
    });

    expect(sendFrame).not.toHaveBeenCalled();
  });

  it('fails closed for binary frames when the tunnel stream cannot append a bound substream frame', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    const sendFrame = vi.fn();
    const transport = createTransport({
      tunnelId: 'tun_voice',
      stream: { sendFrame, close: vi.fn() },
      controlTransport: {
        startWithContentMode: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ response: startResponse(payload), contentMode: 'plain' as const }),
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
      ok: false,
      error: 'daemon_voice_inference_tunnel_substream_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendFrame).not.toHaveBeenCalled();
  });
});
