import {
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
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

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

vi.mock('@/encryption/aes256GcmBytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/encryption/aes256GcmBytes')>();
  return {
    ...actual,
    sealAes256GcmBytes: async (input: Parameters<typeof actual.sealAes256GcmBytes>[0]) => {
      if (sealGate.shouldDelay(new Uint8Array(input.plaintext))) {
        sealGate.enter();
        await sealGate.opened;
      }
      return await actual.sealAes256GcmBytes(input);
    },
  };
});

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
  applicationAttemptId: 'request-ordering',
  applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1('request-ordering'),
};

describe('DaemonSpeechStreamTunnelTransport carrier ordering', () => {
  it('keeps the encrypted carrier in sequence order when a later chunk seals first', async () => {
    const { createDaemonSpeechStreamTunnelTransport } = await import('./DaemonSpeechStreamTunnelTransport');
    const { sealAes256GcmBytes, openAes256GcmBytes } = await import('@/encryption/aes256GcmBytes');

    const recipientSecretKeySeed = new Uint8Array(32).fill(9);
    const recipientPublicKeyBase64Url = encodeProtocolBase64(
      deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
      'base64url',
    );
    const handlers = new Set<(event: Readonly<{
      substreamId: string;
      frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    }>) => void>();
    let installedKey: Uint8Array | null = null;
    const sentCarrierSequences: number[] = [];
    let sendError: unknown = null;

    const aadFor = (input: Readonly<{
      substreamId: string;
      sequence: number;
      phase: 'install' | 'data' | 'finish';
      direction: 'client_to_daemon' | 'daemon_to_client';
    }>) => createPeerApplicationEncryptionAadV1({
      authorityDigest: binding.authorityDigest,
      accountId: binding.accountId,
      machineId: binding.machineId,
      tunnelId: binding.tunnelId,
      applicationKind: binding.applicationKind,
      applicationAttemptId: binding.applicationAttemptId,
      applicationAuthorityDigest: binding.applicationAuthorityDigest,
      direction: input.direction,
      streamId: 'stream-1',
      generation: 3,
      substreamId: input.substreamId,
      sequence: input.sequence,
      phase: input.phase,
    });

    const sendSubstreamDataFrame = vi.fn(async (substreamId: string, outbound: any) => {
      try {
        const encrypted = decodePeerApplicationEncryptedFrameV1(outbound.payloadBytes);
        if (!encrypted) throw new Error('expected encrypted frame');
        if (encrypted.kind === 'install') {
          installedKey = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeProtocolBase64(encrypted.encryptedDataKeyEnvelopeBase64Url!, 'base64url'),
            recipientSecretKeyOrSeed: recipientSecretKeySeed,
          });
        } else {
          sentCarrierSequences.push(outbound.sequence);
        }
        if (!installedKey) throw new Error('expected installed key');
        await openAes256GcmBytes({
          key: installedKey,
          nonce: createPeerApplicationEncryptionNonceV1({
            direction: 'client_to_daemon', phase: encrypted.kind, sequence: outbound.sequence,
          }),
          aad: aadFor({
            substreamId, sequence: outbound.sequence, phase: encrypted.kind, direction: 'client_to_daemon',
          }),
          ciphertext: decodeProtocolBase64(encrypted.ciphertextBase64Url, 'base64url'),
        });
        const responsePlaintext = encrypted.kind === 'install'
          ? new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1)
          : new TextEncoder().encode(JSON.stringify({
            ok: true, streamId: 'stream-1', generation: 3, ackSeq: outbound.sequence - 1, events: [],
          }));
        const responseNonce = createPeerApplicationEncryptionNonceV1({
          direction: 'daemon_to_client', phase: encrypted.kind, sequence: outbound.sequence,
        });
        const responseCiphertext = await sealAes256GcmBytes({
          key: installedKey,
          nonce: responseNonce,
          aad: aadFor({
            substreamId, sequence: outbound.sequence, phase: encrypted.kind, direction: 'daemon_to_client',
          }),
          plaintext: responsePlaintext,
        });
        const event = {
          substreamId,
          frame: {
            v: 1 as const,
            kind: 'data' as const,
            tunnelId: 'tun_voice',
            direction: 'daemon_to_client' as const,
            sequence: outbound.sequence,
            payloadBase64: encodeBase64(encodePeerApplicationEncryptedFrameV1({
              v: 1,
              kind: encrypted.kind,
              nonceBase64Url: encodeProtocolBase64(responseNonce, 'base64url'),
              ciphertextBase64Url: encodeProtocolBase64(responseCiphertext, 'base64url'),
            })),
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
      peerApplicationEncryption: binding,
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
        start: vi.fn(async (payload: DaemonVoiceInferenceSttStreamStartRequest) => ({
          ok: true as const,
          requestId: payload.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: payload.format,
          peerApplicationEncryption: { v: 1 as const, suite: 'aes-256-gcm' as const, recipientPublicKeyBase64Url },
        })),
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
    // The daemon requires lastCarrierSequence + 1 and rejects anything else.
    expect(sentCarrierSequences).toEqual([1, 2]);
  });
});
