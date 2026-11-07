import type {
  DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkResponse,
  DaemonVoiceInferenceSttStreamFinishResponse,
  DaemonVoiceInferenceSttStreamStartRequest,
  DaemonVoiceInferenceSttStreamStartResponse,
} from '@happier-dev/protocol';
import type { PeerTcpTunnelFrame } from '@happier-dev/peer-transport/duplexFrames';
import { DaemonVoiceInferenceSttStreamChunkResponseSchema as SttStreamChunkResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import {
  MACHINE_STREAM_KEY_BYTES_V1,
  MACHINE_STREAM_KEY_TAG_BYTES_V1,
  createMachineStreamKeyAadV1,
  createMachineStreamKeyNonceV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';

import { decodeBase64 } from '@/encryption/base64';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import type { PeerTcpTunnelClientStream } from '@/sync/domains/machines/peer/mediation/tunnel';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import type { DaemonSpeechStreamRelayEncryptionFailure } from './daemonSpeechStreamDiagnostics';

import type {
  DaemonSpeechStreamTransport,
  DaemonSpeechStreamTransportChunkRequest,
} from './DaemonSpeechStreamSender';

/** The Machine RPC owner's control calls; start reports the content mode it sealed the call with. */
export type DaemonSpeechStreamControlTransport = Pick<DaemonSpeechStreamTransport, 'finish' | 'cancel'> & Readonly<{
  startWithContentMode: (input: DaemonVoiceInferenceSttStreamStartRequest) => Promise<Readonly<{
    response: DaemonVoiceInferenceSttStreamStartResponse;
    /** null when the call reported no Machine content (fails closed). */
    contentMode: 'plain' | 'e2ee' | null;
  }>>;
}>;

export type DaemonSpeechStreamTunnelTransportOptions = Readonly<{
  tunnelId: string;
  maxFrameBytes?: number;
  stream: Pick<PeerTcpTunnelClientStream, 'sendFrame' | 'sendSubstreamDataFrame' | 'sendSubstreamFrame' | 'onSubstreamFrame'>
    & Partial<Pick<PeerTcpTunnelClientStream, 'onFrame'>>;
  /** The Machine RPC owner: its E2EE content carries the stream key and the transcript-bearing finish. */
  controlTransport: DaemonSpeechStreamControlTransport;
  direction?: Extract<PeerTcpTunnelFrame, { kind: 'data' }>['direction'];
  responseTimeoutMs?: number;
  resolveSubstreamId?: (input: Readonly<{
    streamId: string;
    generation: number;
  }>) => string;
  onRelayEncryptionFailure?: (failure: DaemonSpeechStreamRelayEncryptionFailure) => void;
  onRelayAuthenticatedEvidence?: (evidence: Readonly<{
    phase: 'plain' | 'data' | 'finish';
    ackSeq?: number;
  }>) => void;
}>;

function relayFailure(step: string, cause: unknown) {
  const failure = new Error(`daemon_voice_inference_relay_${step}_failed`, { cause });
  return Object.defineProperty({
    ok: false as const,
    error: 'daemon_voice_inference_relay_encryption_failed',
    errorCode: 'internal_error' as const,
  }, 'cause', { value: failure, enumerable: false });
}

/** Sealed frames add one GCM tag; the budget fits either Account mode's payload in a tunnel frame. */
function resolvePcmPacketBudget(maxFrameBytes: number): number {
  return Math.max(0, Math.floor((maxFrameBytes - MACHINE_STREAM_KEY_TAG_BYTES_V1) / 2) * 2);
}

export function createDaemonSpeechStreamTunnelSubstreamId(input: Readonly<{
  streamId: string;
  generation: number;
}>): string {
  return `daemon.voiceInference.stt.${input.streamId}.${input.generation}`;
}

function createBinaryDataFrame(input: Readonly<{
  tunnelId: string;
  direction: Extract<PeerTcpTunnelFrame, { kind: 'data' }>['direction'];
  sequence: number;
  payloadBytes: Uint8Array;
}>): PeerTcpTunnelFrame {
  return {
    v: 1,
    kind: 'data',
    tunnelId: input.tunnelId,
    direction: input.direction,
    sequence: input.sequence,
    payload: input.payloadBytes,
  };
}

function decodeSubstreamResponseBytes(
  frame: PeerTcpTunnelFrame,
): Uint8Array | null {
  if (frame.kind !== 'data' || frame.direction !== 'daemon_to_client') {
    return null;
  }
  return frame.payload;
}

async function waitForSubstreamResponseBytes(input: Readonly<{
  stream: Pick<PeerTcpTunnelClientStream, 'onSubstreamFrame'> & Partial<Pick<PeerTcpTunnelClientStream, 'onFrame'>>;
  substreamId: string;
  seq: number;
  timeoutMs: number;
  send: () => Promise<void>;
}>): Promise<Uint8Array | null> {
  if (!input.stream.onSubstreamFrame) {
    return null;
  }

  let detach = () => {};
  let detachTunnel = () => {};
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const responsePromise = new Promise<Uint8Array>((resolve, reject) => {
      const rejectTerminal = (frame: PeerTcpTunnelFrame): boolean => {
        if (frame.kind === 'abort') {
          reject(new Error(`daemon_voice_inference_substream_aborted:${frame.reasonCode}`));
          return true;
        }
        if (frame.kind === 'close' && frame.halfClose !== true) {
          reject(new Error(`daemon_voice_inference_substream_closed:${frame.reasonCode}`));
          return true;
        }
        return false;
      };
      detach = input.stream.onSubstreamFrame?.((event) => {
        if (event.substreamId !== input.substreamId) return;
        if (rejectTerminal(event.frame)) return;
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
      detachTunnel = input.stream.onFrame?.(rejectTerminal) ?? (() => {});
      timeout = setTimeout(() => {
        reject(new Error('daemon_voice_inference_substream_response_timeout'));
      }, Math.max(1, Math.trunc(input.timeoutMs)));
    });
    // Attach rejection handling before asynchronous sealing/sending: a terminal
    // can arrive while WebCrypto is pending. Still settle the send before the
    // caller wipes its content key and cancels the daemon stream.
    const outcome = responsePromise.then(
      bytes => ({ ok: true as const, bytes }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await input.send();
    const response = await outcome;
    if (!response.ok) throw response.error;
    return response.bytes;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detach();
    detachTunnel();
  }
}

export function createDaemonSpeechStreamTunnelTransport(
  options: DaemonSpeechStreamTunnelTransportOptions,
): DaemonSpeechStreamTransport {
  const direction = options.direction ?? 'client_to_daemon';
  const maxPcm16ChunkBytes = options.maxFrameBytes === undefined ? undefined : resolvePcmPacketBudget(options.maxFrameBytes);
  const resolveSubstreamId = options.resolveSubstreamId ?? createDaemonSpeechStreamTunnelSubstreamId;
  /**
   * The started stream's mode, fixed by the content mode the Machine RPC owner
   * sealed the start call with (never by key presence). E2EE requires the key the
   * daemon issued inside that sealed reply. A chunk for any other stream fails
   * closed, so an E2EE stream can never fall back to plain frames.
   */
  let started: Readonly<{
    streamId: string;
    generation: number;
    key: Readonly<{ bytes: Uint8Array; aad: Uint8Array }> | null;
  }> | null = null;
  let lastSealedSequence = -1;
  let sendTail: Promise<void> = Promise.resolve();

  const retire = () => {
    started?.key?.bytes.fill(0);
    started = null;
  };

  /**
   * Preparing a carrier payload can be asynchronous (AES-GCM sealing), and WebCrypto
   * makes no promise about the completion order of concurrent operations. The
   * daemon accepts only the next contiguous sequence, so admission to the substream
   * must cover preparation *and* the send: the tail is claimed synchronously by
   * whichever caller arrives first, and a later sequence cannot overtake an
   * earlier one that is still sealing. Waiting for the daemon's response stays
   * outside the tail so bounded response pipelining is preserved.
   */
  const sendSubstreamPayload = async (
    substreamId: string,
    sequence: number,
    preparePayloadBytes: () => Uint8Array | Promise<Uint8Array>,
  ): Promise<Uint8Array | null> => {
    const send = async (payloadBytes: Uint8Array) => {
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
      await options.stream.sendSubstreamFrame(substreamId, createBinaryDataFrame({
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
      // This is the binary carrier for the same Machine operation as the RPC
      // compatibility path, including queued send and native inference work.
      timeoutMs: options.responseTimeoutMs ?? DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
      send: async () => {
        const previous = sendTail;
        let release!: () => void;
        sendTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await send(await preparePayloadBytes());
        } finally {
          release();
        }
      },
    });
  };

  return {
    ...(maxPcm16ChunkBytes === undefined ? {} : { maxPcm16ChunkBytes }),
    // The application substream retains each payload until its response; a
    // sealed payload is the PCM plus one tag.
    measureInFlightChunkBytes: pcm16ByteLength => pcm16ByteLength + MACHINE_STREAM_KEY_TAG_BYTES_V1,
    start: async (input: DaemonVoiceInferenceSttStreamStartRequest): Promise<DaemonVoiceInferenceSttStreamStartResponse> => {
      retire();
      const { response, contentMode } = await options.controlTransport.startWithContentMode(input);
      if (!response.ok) return response;
      lastSealedSequence = -1;
      if (contentMode === 'plain') {
        started = { streamId: response.streamId, generation: response.generation, key: null };
        options.onRelayAuthenticatedEvidence?.({ phase: 'plain' });
        return response;
      }
      const streamKeyBase64Url = contentMode === 'e2ee' ? response.streamKeyBase64Url : undefined;
      if (!streamKeyBase64Url) {
        options.onRelayEncryptionFailure?.({ step: 'key_prepare', reason: 'unavailable' });
        await options.controlTransport.cancel({ streamId: response.streamId, generation: response.generation }).catch(() => undefined);
        return relayFailure('key_prepare', new Error('daemon_voice_inference_stream_key_unavailable'));
      }
      try {
        const bytes = decodeBase64(streamKeyBase64Url, 'base64url');
        if (bytes.byteLength !== MACHINE_STREAM_KEY_BYTES_V1) throw new Error('daemon_voice_inference_stream_key_invalid');
        started = {
          streamId: response.streamId,
          generation: response.generation,
          key: { bytes, aad: createMachineStreamKeyAadV1({ streamId: response.streamId, generation: response.generation }) },
        };
        return response;
      } catch (error) {
        options.onRelayEncryptionFailure?.({ step: 'key_prepare', reason: 'failed' });
        await options.controlTransport.cancel({ streamId: response.streamId, generation: response.generation }).catch(() => undefined);
        return relayFailure('key_prepare', error);
      }
    },
    chunk: async (input: DaemonSpeechStreamTransportChunkRequest): Promise<DaemonVoiceInferenceSttStreamChunkResponse> => {
      if (input.carrierFrame.kind !== 'binary_tunnel_frame_v2') {
        // A tunnel selection always encodes bytes; no-tunnel recovery is the
        // client's RPC selection, never a per-chunk switch inside this tunnel.
        return {
          ok: false,
          error: 'daemon_voice_inference_binary_tunnel_required',
          errorCode: 'internal_error',
        };
      }
      const carrierFrame = input.carrierFrame;
      if (!options.stream.sendSubstreamDataFrame && !options.stream.sendSubstreamFrame) {
        return { ok: false, error: 'daemon_voice_inference_tunnel_substream_unavailable', errorCode: 'internal_error' };
      }
      const stream = started;
      if (!stream || stream.streamId !== input.streamId || stream.generation !== input.generation) {
        return { ok: false, error: 'daemon_voice_inference_stream_not_started', errorCode: 'internal_error' };
      }
      const substreamId = resolveSubstreamId({ streamId: input.streamId, generation: input.generation });
      const key = stream.key;
      if (!key) {
        const responseBytes = await sendSubstreamPayload(substreamId, input.seq, () => carrierFrame.payloadBytes);
        if (!responseBytes) {
          return { ok: false, error: 'daemon_voice_inference_substream_response_unavailable', errorCode: 'internal_error' };
        }
        try {
          return SttStreamChunkResponseSchema.parse(JSON.parse(new TextDecoder().decode(responseBytes)));
        } catch {
          return { ok: false, error: 'daemon_voice_inference_invalid_substream_response', errorCode: 'internal_error' };
        }
      }
      // One seal per sequence: a key and nonce never protect two plaintexts.
      if (input.seq <= lastSealedSequence) {
        return relayFailure('seal', new Error('daemon_voice_inference_stream_key_sequence_reused'));
      }
      lastSealedSequence = input.seq;
      let step = 'send';
      try {
        const responseBytes = await sendSubstreamPayload(substreamId, input.seq, async () => await sealAes256GcmBytes({
          key: key.bytes,
          nonce: createMachineStreamKeyNonceV1('client_to_daemon', input.seq),
          aad: key.aad,
          plaintext: carrierFrame.payloadBytes,
        }));
        if (!responseBytes) throw new Error('daemon_voice_inference_substream_response_unavailable');
        step = 'open';
        const plaintext = await openAes256GcmBytes({
          key: key.bytes,
          nonce: createMachineStreamKeyNonceV1('daemon_to_client', input.seq),
          aad: key.aad,
          ciphertext: responseBytes,
        });
        step = 'parse';
        const response = SttStreamChunkResponseSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
        if (response.ok) options.onRelayAuthenticatedEvidence?.({ phase: 'data', ackSeq: response.ackSeq });
        return response;
      } catch (error) {
        return relayFailure(step, error);
      }
    },
    finish: async (input): Promise<DaemonVoiceInferenceSttStreamFinishResponse> => {
      const keyed = started?.key != null;
      try {
        const response = await options.controlTransport.finish(input);
        if (keyed && response.ok) options.onRelayAuthenticatedEvidence?.({ phase: 'finish', ackSeq: response.ackSeq });
        return response;
      } finally {
        retire();
      }
    },
    cancel: async (input): Promise<DaemonVoiceInferenceSttStreamCancelResponse> => {
      try {
        return await options.controlTransport.cancel(input);
      } finally {
        retire();
      }
    },
  };
}
