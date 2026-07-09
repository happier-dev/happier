import type {
  DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkResponse,
  DaemonVoiceInferenceSttStreamFinishResponse,
  DaemonVoiceInferenceSttStreamStartRequest,
  DaemonVoiceInferenceSttStreamStartResponse,
  PeerTcpTunnelFrameV1,
} from '@happier-dev/protocol';
import { DaemonVoiceInferenceSttStreamChunkResponseSchema as SttStreamChunkResponseSchema } from '@happier-dev/protocol';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
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

function decodeSubstreamChunkResponse(
  frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>,
): DaemonVoiceInferenceSttStreamChunkResponse | null {
  if (frame.kind !== 'data' || frame.direction !== 'daemon_to_client') {
    return null;
  }
  try {
    const raw = JSON.parse(new TextDecoder().decode(decodeBase64(frame.payloadBase64)));
    return SttStreamChunkResponseSchema.parse(raw);
  } catch {
    return null;
  }
}

async function waitForSubstreamChunkResponse(input: Readonly<{
  stream: Pick<PeerTcpTunnelClientStream, 'onSubstreamFrame'>;
  substreamId: string;
  seq: number;
  timeoutMs: number;
  send: () => Promise<void>;
}>): Promise<DaemonVoiceInferenceSttStreamChunkResponse | null> {
  if (!input.stream.onSubstreamFrame) {
    await input.send();
    return null;
  }

  let detach = () => {};
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const responsePromise = new Promise<DaemonVoiceInferenceSttStreamChunkResponse>((resolve, reject) => {
      detach = input.stream.onSubstreamFrame?.((event) => {
        if (
          event.substreamId !== input.substreamId
          || event.frame.kind !== 'data'
          || event.frame.direction !== 'daemon_to_client'
          || event.frame.sequence !== input.seq
        ) {
          return;
        }
        const response = decodeSubstreamChunkResponse(event.frame);
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

  return {
    start: (input: DaemonVoiceInferenceSttStreamStartRequest): Promise<DaemonVoiceInferenceSttStreamStartResponse> =>
      options.controlTransport.start(input),
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
      if (options.stream.sendSubstreamDataFrame) {
        const response = await waitForSubstreamChunkResponse({
          stream: options.stream,
          substreamId,
          seq: input.seq,
          timeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
          send: async () => {
            await options.stream.sendSubstreamDataFrame?.(substreamId, {
              tunnelId: options.tunnelId,
              direction,
              sequence: input.seq,
              payloadBytes: carrierFrame.payloadBytes,
            });
          },
        });
        if (response) {
          return response;
        }
        return {
          ok: true,
          streamId: input.streamId,
          generation: input.generation,
          ackSeq: input.seq,
          events: [],
        };
      }
      if (!options.stream.sendSubstreamFrame) {
        return {
          ok: false,
          error: 'daemon_voice_inference_tunnel_substream_unavailable',
          errorCode: 'internal_error',
        };
      }
      const frame = createLegacyBinaryDataFrame({
        tunnelId: options.tunnelId,
        direction,
          sequence: input.seq,
          payloadBytes: input.carrierFrame.payloadBytes,
        });
      const response = await waitForSubstreamChunkResponse({
        stream: options.stream,
        substreamId,
        seq: input.seq,
        timeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
        send: async () => {
          await options.stream.sendSubstreamFrame?.(substreamId, frame);
        },
      });
      if (response) {
        return response;
      }
      return {
        ok: true,
        streamId: input.streamId,
        generation: input.generation,
        ackSeq: input.seq,
        events: [],
      };
    },
    finish: (input): Promise<DaemonVoiceInferenceSttStreamFinishResponse> =>
      options.controlTransport.finish(input),
    cancel: (input): Promise<DaemonVoiceInferenceSttStreamCancelResponse> =>
      options.controlTransport.cancel(input),
  };
}
