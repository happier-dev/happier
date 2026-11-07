import {
  createMachineStreamKeyAadV1,
  createMachineStreamKeyNonceV1} from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import {
  encodeBase64 as encodeProtocolBase64} from '@happier-dev/protocol/crypto/base64';
import {
  type DaemonVoiceInferenceSttStreamStartRequest,
} from '@happier-dev/protocol/daemon/voiceInference';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDaemonSpeechStreamCarrierAdapter } from './DaemonSpeechStreamCarrier';

/**
 * WebCrypto is the genuine boundary here: it decides *when* a seal resolves, and
 * it makes no ordering promise across concurrent operations. The gate below makes
 * that reordering deterministic instead of hoping the race shows up.
 */
const sealGate = vi.hoisted(() => {
  let openGate!: () => void;
  const opened = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let markArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    markArrived = resolve;
  });
  const DELAYED_MARKER = 0xaa;
  return {
    opened,
    arrived,
    open: () => openGate(),
    enter: () => markArrived(),
    shouldDelay: (plaintext: Uint8Array): boolean =>
      plaintext.byteLength === 4 && plaintext.every((byte) => byte === DELAYED_MARKER),
  };
});

const streamKey = new Uint8Array(32).fill(9);
const aad = createMachineStreamKeyAadV1({ streamId: 'stream-1', generation: 3 });

describe('DaemonSpeechStreamTunnelTransport carrier ordering', () => {
  it('keeps the keyed carrier in sequence order when a later chunk seals first', async () => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    const subtle = globalThis.crypto.subtle;
    const encrypt = subtle.encrypt.bind(subtle);
    const encryptBoundary = vi.spyOn(subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      const plaintext = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (sealGate.shouldDelay(plaintext)) {
        sealGate.enter();
        await sealGate.opened;
      }
      return await encrypt(algorithm, key, data);
    });
    onTestFinished(() => { encryptBoundary.mockRestore(); vi.unstubAllGlobals(); });
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const { sealAes256GcmBytes, openAes256GcmBytes } = await import('@/encryption/aes256GcmBytes');

    const handlers = new Set<(event: Readonly<{
      substreamId: string;
      frame: PeerTcpTunnelFrame;
    }>) => void>();
    const sentCarrierSequences: number[] = [];
    let sendError: unknown = null;

    const sendSubstreamDataFrame = vi.fn(async (substreamId: string, outbound: any) => {
      try {
        sentCarrierSequences.push(outbound.sequence);
        await openAes256GcmBytes({
          key: streamKey, nonce: createMachineStreamKeyNonceV1('client_to_daemon', outbound.sequence), aad,
          ciphertext: outbound.payloadBytes,
        });
        const responseCiphertext = await sealAes256GcmBytes({
          key: streamKey, nonce: createMachineStreamKeyNonceV1('daemon_to_client', outbound.sequence), aad,
          plaintext: new TextEncoder().encode(JSON.stringify({
            ok: true, streamId: 'stream-1', generation: 3, ackSeq: outbound.sequence, events: [],
          })),
        });
        const event = {
          substreamId,
          frame: {
            v: 1 as const,
            kind: 'data' as const,
            tunnelId: 'tun_voice',
            direction: 'daemon_to_client' as const,
            sequence: outbound.sequence,
            payload: responseCiphertext,
          },
        };
        for (const handler of [...handlers]) handler(event);
      } catch (error) {
        sendError = error;
        throw error;
      }
    });

    const transport = createDaemonSpeechStreamTunnelTransport({
      tunnelId: 'tun_voice',
      stream: {
        sendFrame: vi.fn(),
        sendSubstreamDataFrame,
        onSubstreamFrame: (handler: any) => {
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
      } as any,
      controlTransport: {
        startWithContentMode: vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({ contentMode: 'e2ee' as const, response: {
          ok: true as const,
          requestId: payload.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: payload.format,
          streamKeyBase64Url: encodeProtocolBase64(streamKey, 'base64url'),
        } })),
        finish: vi.fn(),
        cancel: vi.fn(async (payload: { streamId: string; generation: number }) => ({
          ok: true as const,
          streamId: payload.streamId,
          generation: payload.generation,
        })),
      },
    });

    await expect(transport.start({
      requestId: 'request-ordering',
      packId: null,
      language: null,
      streamingMode: 'runtime',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    })).resolves.toMatchObject({ ok: true });
    expect(sendError).toBeNull();

    const adapter = createDaemonSpeechStreamCarrierAdapter({ routeKind: 'server_relay', binaryCapable: true });
    const encode = (seq: number, marker: number) => adapter.encodeInputAppendFrame({
      streamId: 'stream-1',
      generation: 3,
      seq,
      pcm16Bytes: new Uint8Array([marker, marker, marker, marker]),
    });

    // The sender pipelines chunks: both are admitted before either round-trip
    // completes. Sequence 0 seals slowly, sequence 1 seals instantly.
    const first = transport.chunk({
      streamId: 'stream-1', generation: 3, seq: 0, carrierFrame: encode(0, 0xaa), compatibilityTransport: null,
    });
    const second = transport.chunk({
      streamId: 'stream-1', generation: 3, seq: 1, carrierFrame: encode(1, 0xbb), compatibilityTransport: null,
    });

    await sealGate.arrived;
    // Give the faster chunk every chance to seal and reach the wire first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    sealGate.open();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(sendError).toBeNull();
    // The daemon requires lastSequence + 1 and rejects anything else.
    expect(sentCarrierSequences).toEqual([0, 1]);
  });
});
