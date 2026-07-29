import {
  decodePeerTcpTunnelBinaryFrameV2,
  encodePeerTcpTunnelBinaryFrameV2,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  decodeBase64 as decodeProtocolBase64,
  decodePeerApplicationEncryptedFrameV1,
  deriveBoxPublicKeyFromSeed,
  encodeBase64 as encodeProtocolBase64,
  encodePeerApplicationEncryptedFrameV1,
  openEncryptedDataKeyEnvelopeV1,
  type DaemonVoiceInferenceSttStreamStartRequest,
  type PeerTcpTunnelFrameV1,
  type PeerTcpTunnelOpenResponseV1,
  type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';

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

  it('installs relay encryption before PCM and exposes only authenticated ciphertext on the carrier', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;
    const binding = {
      v: 1 as const,
      suite: 'aes-256-gcm' as const,
      flowKind: 'voice_media' as const,
      routeKind: 'server_relay' as const,
      authorityDigest: 'sha256:acdb52b3d7de70428b1c54fbb340ab675b98d6900d2b86ababad20baa7aed6ca',
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tun_voice',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'request-1',
      applicationAuthorityDigest:
        createSpeechTranscriptionApplicationAuthorityDigestV1('request-1'),
    };
    const recipientSecretKeySeed = new Uint8Array(32).fill(9);
    const recipientPublicKeyBase64Url = encodeProtocolBase64(
      deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
      'base64url',
    );
    let handler: ((event: any) => void) | null = null;
    let installedKey: Uint8Array | null = null;
    let sendError: unknown = null;
    const sentPayloads: Uint8Array[] = [];
    const onRelayAuthenticatedEvidence = vi.fn();
    const sendSubstreamDataFrame = vi.fn(async (substreamId: string, outbound: any) => {
      try {
      sentPayloads.push(new Uint8Array(outbound.payloadBytes));
      const encrypted = decodePeerApplicationEncryptedFrameV1(outbound.payloadBytes);
      if (!encrypted) throw new Error('expected encrypted frame');
      if (encrypted.kind === 'install') {
        installedKey = openEncryptedDataKeyEnvelopeV1({
          envelope: decodeProtocolBase64(encrypted.encryptedDataKeyEnvelopeBase64Url!, 'base64url'),
          recipientSecretKeyOrSeed: recipientSecretKeySeed,
        });
      }
      if (!installedKey) throw new Error('expected installed key');
      const requestNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'client_to_daemon', phase: encrypted.kind, sequence: outbound.sequence,
      });
      const requestPlaintext = await openAes256GcmBytes({
        key: installedKey,
        nonce: requestNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'client_to_daemon',
          streamId: 'stream-1', generation: 3, substreamId,
          sequence: outbound.sequence, phase: encrypted.kind,
        }),
        ciphertext: decodeProtocolBase64(encrypted.ciphertextBase64Url, 'base64url'),
      });
      if (encrypted.kind === 'data') expect([...requestPlaintext]).toEqual([0, 0, 1, 0]);
      const responsePlaintext = encrypted.kind === 'install'
        ? new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1)
        : encrypted.kind === 'finish'
          ? new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 3, ackSeq: 0,
              finalText: 'hello', language: 'en', modelPackId: 'stt-pack-1', events: [],
            }))
          : new TextEncoder().encode(JSON.stringify({
              ok: true, streamId: 'stream-1', generation: 3, ackSeq: 0, events: [],
            }));
      const responseNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'daemon_to_client', phase: encrypted.kind, sequence: outbound.sequence,
      });
      const responseCiphertext = await sealAes256GcmBytes({
        key: installedKey,
        nonce: responseNonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: binding.authorityDigest,
          accountId: binding.accountId,
          machineId: binding.machineId,
          tunnelId: binding.tunnelId,
          applicationKind: binding.applicationKind,
          applicationAttemptId: binding.applicationAttemptId,
          applicationAuthorityDigest: binding.applicationAuthorityDigest,
          direction: 'daemon_to_client',
          streamId: 'stream-1', generation: 3, substreamId,
          sequence: outbound.sequence, phase: encrypted.kind,
        }),
        plaintext: responsePlaintext,
      });
      handler?.({
        substreamId,
        frame: {
          v: 1, kind: 'data', tunnelId: 'tun_voice', direction: 'daemon_to_client',
          sequence: outbound.sequence,
          payloadBase64: encodeBase64(encodePeerApplicationEncryptedFrameV1({
            v: 1,
            kind: encrypted.kind,
            nonceBase64Url: encodeProtocolBase64(responseNonce, 'base64url'),
            ciphertextBase64Url: encodeProtocolBase64(responseCiphertext, 'base64url'),
          })),
        },
      });
      } catch (error) {
        sendError = error;
        throw error;
      }
    });
    const transport = createTransport({
      tunnelId: 'tun_voice',
      peerApplicationEncryption: binding,
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        onSubstreamFrame: vi.fn((next) => { handler = next; return () => { handler = null; }; }),
      },
      onRelayAuthenticatedEvidence,
      controlTransport: {
        start: vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({
          ...startResponse(payload),
          peerApplicationEncryption: { v: 1 as const, suite: 'aes-256-gcm' as const, recipientPublicKeyBase64Url },
        })),
        finish: vi.fn(),
        cancel: vi.fn(async () => ({ ok: true as const })),
      },
    });
    const startResult = await transport.start({
      requestId: 'request-encrypted',
      packId: null,
      language: null,
      streamingMode: 'runtime',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    });
    expect(sendError).toBeNull();
    expect(startResult).toMatchObject({ ok: true, peerApplicationEncryption: { suite: 'aes-256-gcm' } });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'install' });
    const carrierFrame = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true })
      .encodeInputAppendFrame({ streamId: 'stream-1', generation: 3, seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) });
    await expect(transport.chunk({
      streamId: 'stream-1', generation: 3, seq: 0, carrierFrame, compatibilityTransport: null,
    })).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'data', ackSeq: 0 });
    expect(sentPayloads).toHaveLength(2);
    expect([...sentPayloads[1]!]).not.toEqual([0, 0, 1, 0]);
    expect(new TextDecoder().decode(sentPayloads[1]!)).not.toContain('AAAAAQ');
    await expect(transport.finish({ streamId: 'stream-1', generation: 3, finalSeq: 0 }))
      .resolves.toMatchObject({ ok: true, finalText: 'hello' });
    expect(onRelayAuthenticatedEvidence).toHaveBeenLastCalledWith({ phase: 'finish', ackSeq: 0 });
    expect(onRelayAuthenticatedEvidence).toHaveBeenCalledTimes(3);
    expect(sentPayloads).toHaveLength(3);
  });

  it('fails closed before sending PCM when the binary substream has no response owner', async () => {
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
    })).resolves.toEqual({
      ok: false,
      error: 'daemon_voice_inference_substream_response_unavailable',
      errorCode: 'internal_error',
    });

    expect(sendSubstreamDataFrame).not.toHaveBeenCalled();
    expect(sendSubstreamFrame).not.toHaveBeenCalled();
    expect(compatibilityChunk).not.toHaveBeenCalled();
  });

  it('rejects a matching application-substream abort immediately instead of waiting for response timeout', async () => {
    const transportMod = await loadModule('./DaemonSpeechStreamTunnelTransport');
    const createTransport = transportMod.createDaemonSpeechStreamTunnelTransport;
    expect(createTransport).toBeTypeOf('function');
    if (typeof createTransport !== 'function') return;

    let substreamHandler: ((event: Readonly<{
      substreamId: string;
      frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
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
        start: async (payload: DaemonVoiceInferenceSttStreamStartRequest) => startResponse(payload),
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
