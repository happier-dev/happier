import type {
  DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkResponse,
  DaemonVoiceInferenceSttStreamFinishResponse,
  DaemonVoiceInferenceSttStreamStartRequest,
  DaemonVoiceInferenceSttStreamStartResponse,
  PeerApplicationEncryptionAuthorityBindingV1,
  PeerTcpTunnelFrameV1,
} from '@happier-dev/protocol';
import {
  DaemonVoiceInferenceSttStreamChunkResponseSchema as SttStreamChunkResponseSchema,
  DaemonVoiceInferenceSttStreamFinishResponseSchema as SttStreamFinishResponseSchema,
  PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  decodePeerApplicationEncryptedFrameV1,
  encodePeerApplicationEncryptedFrameV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { PeerTcpTunnelClientStream } from '@/sync/domains/machines/peer/mediation/tunnel';

import type {
  DaemonSpeechStreamTransport,
  DaemonSpeechStreamTransportChunkRequest,
} from './DaemonSpeechStreamSender';

export type DaemonSpeechStreamTunnelTransportOptions = Readonly<{
  tunnelId: string;
  stream: Pick<PeerTcpTunnelClientStream, 'sendFrame' | 'sendSubstreamDataFrame' | 'sendSubstreamFrame' | 'onSubstreamFrame'>;
  controlTransport: Pick<DaemonSpeechStreamTransport, 'start' | 'finish' | 'cancel'>;
  fallbackTransport?: Pick<DaemonSpeechStreamTransport, 'chunk'> | null;
  direction?: Extract<PeerTcpTunnelFrameV1, { kind: 'data' }>['direction'];
  responseTimeoutMs?: number;
  resolveSubstreamId?: (input: Readonly<{
    streamId: string;
    generation: number;
  }>) => string;
  peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
  onRelayAuthenticatedEvidence?: (evidence: Readonly<{
    phase: 'install' | 'data' | 'finish';
    ackSeq?: number;
  }>) => void;
}>;

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

export function createDaemonSpeechStreamTunnelSubstreamId(input: Readonly<{
  streamId: string;
  generation: number;
}>): string {
  return `daemon.voiceInference.stt.${input.streamId}.${input.generation}`;
}

function createLegacyBinaryDataFrame(input: Readonly<{
  tunnelId: string;
  direction: Extract<PeerTcpTunnelFrameV1, { kind: 'data' }>['direction'];
  sequence: number;
  payloadBytes: Uint8Array;
}>): Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> {
  return {
    v: 1,
    kind: 'data',
    tunnelId: input.tunnelId,
    direction: input.direction,
    sequence: input.sequence,
    payloadBase64: encodeBase64(input.payloadBytes),
  };
}

function decodeSubstreamResponseBytes(
  frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>,
): Uint8Array | null {
  if (frame.kind !== 'data' || frame.direction !== 'daemon_to_client') {
    return null;
  }
  try {
    return decodeBase64(frame.payloadBase64);
  } catch {
    return null;
  }
}

async function waitForSubstreamResponseBytes(input: Readonly<{
  stream: Pick<PeerTcpTunnelClientStream, 'onSubstreamFrame'>;
  substreamId: string;
  seq: number;
  timeoutMs: number;
  send: () => Promise<void>;
}>): Promise<Uint8Array | null> {
  if (!input.stream.onSubstreamFrame) {
    return null;
  }

  let detach = () => {};
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
      detach = input.stream.onSubstreamFrame?.((event) => {
        if (event.substreamId !== input.substreamId) return;
        if (event.frame.kind === 'abort') {
          reject(new Error(`daemon_voice_inference_substream_aborted:${event.frame.reasonCode}`));
          return;
        }
        if (event.frame.kind === 'close' && event.frame.halfClose !== true) {
          reject(new Error(`daemon_voice_inference_substream_closed:${event.frame.reasonCode}`));
          return;
        }
        if (
          event.frame.kind !== 'data'
          || event.frame.direction !== 'daemon_to_client'
          || event.frame.sequence !== input.seq
        ) return;
        const response = decodeSubstreamResponseBytes(event.frame);
        if (!response) {
          reject(new Error('daemon_voice_inference_invalid_substream_response'));
          return;
        }
        resolve(response);
      }) ?? (() => {});
      timeout = setTimeout(() => {
        reject(new Error('daemon_voice_inference_substream_response_timeout'));
      }, Math.max(1, Math.trunc(input.timeoutMs)));
    });
    await input.send();
    return await responsePromise;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detach();
  }
}

export function createDaemonSpeechStreamTunnelTransport(
  options: DaemonSpeechStreamTunnelTransportOptions,
): DaemonSpeechStreamTransport {
  const direction = options.direction ?? 'client_to_daemon';
  const resolveSubstreamId = options.resolveSubstreamId ?? createDaemonSpeechStreamTunnelSubstreamId;
  let encryptionSession: Readonly<{
    streamId: string;
    generation: number;
    substreamId: string;
    contentKey: Uint8Array;
  }> | null = null;
  let sendTail: Promise<void> = Promise.resolve();
  let lastDataCarrierSequence = 0;

  const sendSubstreamPayload = async (substreamId: string, sequence: number, payloadBytes: Uint8Array): Promise<Uint8Array | null> => {
    const send = async () => {
      if (options.stream.sendSubstreamDataFrame) {
        await options.stream.sendSubstreamDataFrame(substreamId, {
          tunnelId: options.tunnelId,
          direction,
          sequence,
          payloadBytes,
        });
        return;
      }
      if (!options.stream.sendSubstreamFrame) throw new Error('daemon_voice_inference_tunnel_substream_unavailable');
      await options.stream.sendSubstreamFrame(substreamId, createLegacyBinaryDataFrame({
        tunnelId: options.tunnelId,
        direction,
        sequence,
        payloadBytes,
      }));
    };
    return await waitForSubstreamResponseBytes({
      stream: options.stream,
      substreamId,
      seq: sequence,
      timeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      send: async () => {
        const operation = sendTail.catch(() => {}).then(send);
        sendTail = operation.catch(() => {});
        await operation;
      },
    });
  };

  const openEncryptedResponse = async (input: Readonly<{
    phase: 'install' | 'data' | 'finish';
    sequence: number;
    responseBytes: Uint8Array;
    session: NonNullable<typeof encryptionSession>;
  }>): Promise<Uint8Array> => {
    const frame = decodePeerApplicationEncryptedFrameV1(input.responseBytes);
    if (!frame || frame.kind !== input.phase) throw new Error('daemon_voice_inference_encrypted_response_invalid');
    const nonce = createPeerApplicationEncryptionNonceV1({
      direction: 'daemon_to_client', phase: input.phase, sequence: input.sequence,
    });
    const encodedNonce = decodeBase64(frame.nonceBase64Url, 'base64url');
    if (encodedNonce.byteLength !== nonce.byteLength || encodedNonce.some((byte, index) => byte !== nonce[index])) {
      throw new Error('daemon_voice_inference_encrypted_response_nonce_invalid');
    }
    return await openAes256GcmBytes({
      key: input.session.contentKey,
      nonce,
      aad: createPeerApplicationEncryptionAadV1({
        authorityDigest: options.peerApplicationEncryption!.authorityDigest,
        accountId: options.peerApplicationEncryption!.accountId,
        machineId: options.peerApplicationEncryption!.machineId,
        tunnelId: options.peerApplicationEncryption!.tunnelId,
        applicationKind: options.peerApplicationEncryption!.applicationKind,
        applicationAttemptId: options.peerApplicationEncryption!.applicationAttemptId,
        applicationAuthorityDigest: options.peerApplicationEncryption!.applicationAuthorityDigest,
        direction: 'daemon_to_client',
        streamId: input.session.streamId,
        generation: input.session.generation,
        substreamId: input.session.substreamId,
        sequence: input.sequence,
        phase: input.phase,
      }),
      ciphertext: decodeBase64(frame.ciphertextBase64Url, 'base64url'),
    });
  };

  const sealRequest = async (input: Readonly<{
    phase: 'install' | 'data' | 'finish';
    sequence: number;
    plaintext: Uint8Array;
    session: NonNullable<typeof encryptionSession>;
    encryptedDataKeyEnvelopeBase64Url?: string;
  }>): Promise<Uint8Array> => {
    const nonce = createPeerApplicationEncryptionNonceV1({
      direction: 'client_to_daemon', phase: input.phase, sequence: input.sequence,
    });
    const ciphertext = await sealAes256GcmBytes({
      key: input.session.contentKey,
      nonce,
      aad: createPeerApplicationEncryptionAadV1({
        authorityDigest: options.peerApplicationEncryption!.authorityDigest,
        accountId: options.peerApplicationEncryption!.accountId,
        machineId: options.peerApplicationEncryption!.machineId,
        tunnelId: options.peerApplicationEncryption!.tunnelId,
        applicationKind: options.peerApplicationEncryption!.applicationKind,
        applicationAttemptId: options.peerApplicationEncryption!.applicationAttemptId,
        applicationAuthorityDigest: options.peerApplicationEncryption!.applicationAuthorityDigest,
        direction: 'client_to_daemon',
        streamId: input.session.streamId,
        generation: input.session.generation,
        substreamId: input.session.substreamId,
        sequence: input.sequence,
        phase: input.phase,
      }),
      plaintext: input.plaintext,
    });
    return encodePeerApplicationEncryptedFrameV1({
      v: 1,
      kind: input.phase,
      nonceBase64Url: encodeBase64(nonce, 'base64url'),
      ciphertextBase64Url: encodeBase64(ciphertext, 'base64url'),
      ...(input.encryptedDataKeyEnvelopeBase64Url ? {
        encryptedDataKeyEnvelopeBase64Url: input.encryptedDataKeyEnvelopeBase64Url,
      } : {}),
    });
  };

  return {
    start: async (input: DaemonVoiceInferenceSttStreamStartRequest): Promise<DaemonVoiceInferenceSttStreamStartResponse> => {
      const response = await options.controlTransport.start({
        ...input,
        ...(options.peerApplicationEncryption ? { peerApplicationEncryption: options.peerApplicationEncryption } : {}),
      });
      if (!options.peerApplicationEncryption || !response.ok) return response;
      if (!response.peerApplicationEncryption) {
        return { ok: false, error: 'daemon_voice_inference_relay_encryption_required', errorCode: 'internal_error' };
      }
      const recipientPublicKey = decodeBase64(response.peerApplicationEncryption.recipientPublicKeyBase64Url, 'base64url');
      const contentKey = getRandomBytes(PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1);
      const substreamId = resolveSubstreamId({ streamId: response.streamId, generation: response.generation });
      const session = { streamId: response.streamId, generation: response.generation, substreamId, contentKey };
      try {
        const encryptedDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
          dataKey: contentKey,
          recipientPublicKey,
          randomBytes: getRandomBytes,
        });
        const installPayload = await sealRequest({
          phase: 'install',
          sequence: 0,
          plaintext: new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1),
          session,
          encryptedDataKeyEnvelopeBase64Url: encodeBase64(encryptedDataKeyEnvelope, 'base64url'),
        });
        const responseBytes = await sendSubstreamPayload(substreamId, 0, installPayload);
        if (!responseBytes) throw new Error('daemon_voice_inference_encryption_confirmation_unavailable');
        const confirmation = await openEncryptedResponse({ phase: 'install', sequence: 0, responseBytes, session });
        if (new TextDecoder().decode(confirmation) !== PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1) {
          throw new Error('daemon_voice_inference_encryption_confirmation_invalid');
        }
        encryptionSession = session;
        lastDataCarrierSequence = 0;
        options.onRelayAuthenticatedEvidence?.({ phase: 'install' });
        return response;
      } catch {
        contentKey.fill(0);
        await options.controlTransport.cancel({ streamId: response.streamId, generation: response.generation }).catch(() => undefined);
        return { ok: false, error: 'daemon_voice_inference_relay_encryption_failed', errorCode: 'internal_error' };
      }
    },
    chunk: async (input: DaemonSpeechStreamTransportChunkRequest): Promise<DaemonVoiceInferenceSttStreamChunkResponse> => {
      if (input.carrierFrame.kind !== 'binary_tunnel_frame_v2') {
        if (options.fallbackTransport) {
          return options.fallbackTransport.chunk(input);
        }
        return {
          ok: false,
          error: 'daemon_voice_inference_binary_tunnel_required',
          errorCode: 'internal_error',
        };
      }
      const carrierFrame = input.carrierFrame;
      const substreamId = resolveSubstreamId({
        streamId: input.streamId,
        generation: input.generation,
      });
      if (!options.stream.sendSubstreamDataFrame && !options.stream.sendSubstreamFrame) {
        return { ok: false, error: 'daemon_voice_inference_tunnel_substream_unavailable', errorCode: 'internal_error' };
      }
      if (options.peerApplicationEncryption) {
        const session = encryptionSession;
        if (!session || session.streamId !== input.streamId || session.generation !== input.generation) {
          return { ok: false, error: 'daemon_voice_inference_relay_encryption_not_ready', errorCode: 'internal_error' };
        }
        const sequence = input.seq + 1;
        try {
          const payload = await sealRequest({
            phase: 'data', sequence, plaintext: carrierFrame.payloadBytes, session,
          });
          const responseBytes = await sendSubstreamPayload(substreamId, sequence, payload);
          if (!responseBytes) throw new Error('daemon_voice_inference_substream_response_unavailable');
          const plaintext = await openEncryptedResponse({ phase: 'data', sequence, responseBytes, session });
          lastDataCarrierSequence = Math.max(lastDataCarrierSequence, sequence);
          const response = SttStreamChunkResponseSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
          if (response.ok) {
            options.onRelayAuthenticatedEvidence?.({ phase: 'data', ackSeq: response.ackSeq });
          }
          return response;
        } catch {
          return { ok: false, error: 'daemon_voice_inference_relay_encryption_failed', errorCode: 'internal_error' };
        }
      }
      const responseBytes = await sendSubstreamPayload(substreamId, input.seq, carrierFrame.payloadBytes);
      if (!responseBytes) {
        return { ok: false, error: 'daemon_voice_inference_substream_response_unavailable', errorCode: 'internal_error' };
      }
      try {
        return SttStreamChunkResponseSchema.parse(JSON.parse(new TextDecoder().decode(responseBytes)));
      } catch {
        return { ok: false, error: 'daemon_voice_inference_invalid_substream_response', errorCode: 'internal_error' };
      }
    },
    finish: async (input): Promise<DaemonVoiceInferenceSttStreamFinishResponse> => {
      const session = encryptionSession;
      if (!options.peerApplicationEncryption || !session) return await options.controlTransport.finish(input);
      const sequence = lastDataCarrierSequence + 1;
      try {
        const payload = await sealRequest({
          phase: 'finish',
          sequence,
          plaintext: new TextEncoder().encode(JSON.stringify({ finalSeq: input.finalSeq })),
          session,
        });
        const responseBytes = await sendSubstreamPayload(session.substreamId, sequence, payload);
        if (!responseBytes) throw new Error('daemon_voice_inference_substream_response_unavailable');
        const plaintext = await openEncryptedResponse({ phase: 'finish', sequence, responseBytes, session });
        const response = SttStreamFinishResponseSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
        if (response.ok) {
          options.onRelayAuthenticatedEvidence?.({ phase: 'finish', ackSeq: response.ackSeq });
        }
        return response;
      } catch {
        return { ok: false, error: 'daemon_voice_inference_relay_encryption_failed', errorCode: 'internal_error' };
      } finally {
        session.contentKey.fill(0);
        encryptionSession = null;
      }
    },
    cancel: async (input): Promise<DaemonVoiceInferenceSttStreamCancelResponse> => {
      try {
        return await options.controlTransport.cancel(input);
      } finally {
        encryptionSession?.contentKey.fill(0);
        encryptionSession = null;
      }
    },
  };
}
