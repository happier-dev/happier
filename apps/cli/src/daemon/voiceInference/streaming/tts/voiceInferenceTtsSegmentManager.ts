import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceError,
  DaemonVoiceInferenceTtsStreamAckRequest,
  DaemonVoiceInferenceTtsStreamAckResponse,
  DaemonVoiceInferenceTtsStreamCancelRequest,
  DaemonVoiceInferenceTtsStreamCancelResponse,
  DaemonVoiceInferenceTtsStreamEvent,
  DaemonVoiceInferenceTtsStreamNextRequest,
  DaemonVoiceInferenceTtsStreamNextResponse,
  DaemonVoiceInferenceTtsStreamStartRequest,
  DaemonVoiceInferenceTtsStreamStartResponse,
  DaemonVoiceInferenceTtsStreamStatusRequest,
  DaemonVoiceInferenceTtsStreamStatusResponse,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { toVoiceInferenceError } from '@/api/machine/voiceInferenceRpcResponses';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';

import { segmentTextForDaemonTts, type VoiceInferenceTtsTextSegment } from './voiceInferenceTtsSegmenter';

type WorkerSynthesizeTtsResult = Readonly<{
  requestId: string;
  output: DaemonVoiceInferenceAudioOutput;
  filePath: string;
  sizeBytes: number;
  name: string;
}>;

export type VoiceInferenceTtsSegmentWorker = Readonly<{
  synthesizeTts: (input: Readonly<{
    requestId: string;
    text: string;
    packId: string | null;
    voiceId: string | null;
    speed: number | null;
    output: DaemonVoiceInferenceAudioOutput;
    signal?: AbortSignal | null;
  }>) => Promise<WorkerSynthesizeTtsResult>;
  cancelTts: (requestId: string) => Promise<void>;
}>;

export type VoiceInferenceTtsSegmentManager = Readonly<{
  /**
   * Daemon-owned temp root for this manager's streams. Exposed so a caller that
   * must stage stream-scoped bytes on disk (segmented TTS diagnostics) uses the
   * same resolved root instead of re-deriving the default.
   */
  streamRoot: string;
  start: (input: DaemonVoiceInferenceTtsStreamStartRequest) => Promise<DaemonVoiceInferenceTtsStreamStartResponse>;
  next: (input: DaemonVoiceInferenceTtsStreamNextRequest) => Promise<DaemonVoiceInferenceTtsStreamNextResponse>;
  ack: (input: DaemonVoiceInferenceTtsStreamAckRequest) => Promise<DaemonVoiceInferenceTtsStreamAckResponse>;
  cancel: (input: DaemonVoiceInferenceTtsStreamCancelRequest) => Promise<DaemonVoiceInferenceTtsStreamCancelResponse>;
  status: (input: DaemonVoiceInferenceTtsStreamStatusRequest) => Promise<DaemonVoiceInferenceTtsStreamStatusResponse>;
  dispose: () => Promise<void>;
}>;

export type VoiceInferenceTtsStreamClosedOutcome = 'completed' | 'discarded';

export type CreateVoiceInferenceTtsSegmentManagerOptions = Readonly<{
  voiceInferenceWorker: VoiceInferenceTtsSegmentWorker;
  streamRoot?: string;
  prefetchDepth?: number;
  ackTimeoutMs?: number;
  /**
   * Fired exactly once per stream, from the single terminal path, so an owner
   * that staged stream-scoped bytes (segmented TTS diagnostics) retires them
   * with the stream instead of holding them until daemon shutdown.
   */
  onStreamClosed?: (input: Readonly<{
    streamId: string;
    outcome: VoiceInferenceTtsStreamClosedOutcome;
  }>) => void;
}>;

type SegmentState = {
  textSegment: VoiceInferenceTtsTextSegment;
  requestId: string;
  controller: AbortController | null;
  status: 'pending' | 'synthesizing' | 'ready' | 'delivered' | 'acked' | 'error';
  delivered: boolean;
  event: Extract<DaemonVoiceInferenceTtsStreamEvent, { type: 'segment' }> | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
};

type TtsStreamSession = {
  requestId: string;
  streamId: string;
  generation: number;
  packId: string | null;
  voiceId: string | null;
  speed: number | null;
  output: DaemonVoiceInferenceAudioOutput;
  segments: SegmentState[];
  nextSegmentToSchedule: number;
  state: 'open' | 'error' | 'closed';
  waiters: Array<() => void>;
  errorEvent: Extract<DaemonVoiceInferenceTtsStreamEvent, { type: 'error' }> | null;
  abandonTimer: ReturnType<typeof setTimeout> | null;
};

function errorResponse(error: unknown, retryable?: boolean): DaemonVoiceInferenceError {
  return {
    ...toVoiceInferenceError(error),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

function streamError(
  errorCode: 'stream_not_found' | 'invalid_stream_state',
  error: string,
): DaemonVoiceInferenceError {
  return {
    ok: false,
    errorCode,
    error,
    retryable: errorCode !== 'stream_not_found',
  };
}

function createSegmentRequestId(requestId: string, segmentIndex: number): string {
  const base = requestId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'tts';
  return `${base}:segment-${segmentIndex}`;
}

function segmentId(streamId: string, segmentIndex: number): string {
  return `${streamId}:${segmentIndex}`;
}

function notify(session: TtsStreamSession): void {
  const waiters = session.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

export function createVoiceInferenceTtsSegmentManager(
  options: CreateVoiceInferenceTtsSegmentManagerOptions,
): VoiceInferenceTtsSegmentManager {
  const streamRoot = options.streamRoot ?? join(resolveVoiceInferencePaths().tempDir, 'tts-streams');
  const sessions = new Map<string, TtsStreamSession>();
  const defaultTtlMs = Number.isFinite(configuration.filesTransferSessionTtlMs)
    ? Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs))
    : 60_000;
  const ackTimeoutMs = Math.max(50, Math.trunc(options.ackTimeoutMs ?? defaultTtlMs));
  const defaultPrefetchDepth = Math.max(1, Math.min(2, Math.trunc(options.prefetchDepth ?? 2)));
  let disposePromise: Promise<void> | null = null;

  function getSession(streamId: string, generation?: number): TtsStreamSession | null {
    const session = sessions.get(streamId) ?? null;
    if (!session || (typeof generation === 'number' && session.generation !== generation)) {
      return null;
    }
    return session;
  }

  function inWindowCount(session: TtsStreamSession): number {
    return session.segments.filter((segment) =>
      segment.status === 'synthesizing' || segment.status === 'ready',
    ).length;
  }

  /**
   * The stream is abandoned when the client stops driving it. Armed from start —
   * before any segment is delivered — because a client that vanishes right after
   * start has no delivered segment and therefore no per-segment ack deadline,
   * and its prefetched audio, staged diagnostics and in-flight synthesis would
   * otherwise be held for the daemon's whole lifetime.
   */
  function refreshAbandonDeadline(session: TtsStreamSession): void {
    if (session.abandonTimer) {
      clearTimeout(session.abandonTimer);
      session.abandonTimer = null;
    }
    if (session.state === 'closed') {
      return;
    }
    session.abandonTimer = setTimeout(() => {
      session.abandonTimer = null;
      void closeSession(session, { cancelWorker: true, outcome: 'discarded' });
    }, ackTimeoutMs);
    (session.abandonTimer as { unref?: () => void }).unref?.();
  }

  async function closeSession(
    session: TtsStreamSession,
    optionsForClose: Readonly<{ cancelWorker?: boolean; outcome: VoiceInferenceTtsStreamClosedOutcome }>,
  ): Promise<void> {
    if (session.state === 'closed') {
      return;
    }
    session.state = 'closed';
    sessions.delete(session.streamId);
    if (session.abandonTimer) {
      clearTimeout(session.abandonTimer);
      session.abandonTimer = null;
    }
    for (const segment of session.segments) {
      if (segment.ackTimer) {
        clearTimeout(segment.ackTimer);
        segment.ackTimer = null;
      }
      if (segment.controller) {
        segment.controller.abort();
        segment.controller = null;
      }
      if (optionsForClose.cancelWorker === true && segment.status === 'synthesizing') {
        await options.voiceInferenceWorker.cancelTts(segment.requestId).catch(() => undefined);
      }
      segment.event = null;
    }
    notify(session);
    options.onStreamClosed?.({ streamId: session.streamId, outcome: optionsForClose.outcome });
  }

  function markError(session: TtsStreamSession, segment: SegmentState, error: unknown): void {
    if (session.state !== 'open') {
      return;
    }
    const normalizedError = toVoiceInferenceError(error);
    session.state = 'error';
    segment.status = 'error';
    session.errorEvent = {
      type: 'error',
      streamId: session.streamId,
      generation: session.generation,
      segmentId: segmentId(session.streamId, segment.textSegment.index),
      segmentIndex: segment.textSegment.index,
      errorCode: normalizedError.errorCode,
      error: normalizedError.error,
      retryable: normalizedError.errorCode !== 'cancelled',
    };
    notify(session);
  }

  function scheduleMore(session: TtsStreamSession, prefetchDepth = defaultPrefetchDepth): void {
    while (
      session.state === 'open'
      && session.nextSegmentToSchedule < session.segments.length
      && inWindowCount(session) < prefetchDepth
    ) {
      const segment = session.segments[session.nextSegmentToSchedule];
      if (!segment) {
        break;
      }
      session.nextSegmentToSchedule += 1;
      segment.status = 'synthesizing';
      const controller = new AbortController();
      segment.controller = controller;
      const synthesizePromise = options.voiceInferenceWorker.synthesizeTts({
        requestId: segment.requestId,
        text: segment.textSegment.text,
        packId: session.packId,
        voiceId: session.voiceId,
        speed: session.speed,
        output: session.output,
        signal: controller.signal,
      }).then(async (result) => {
        const bytes = await readFile(result.filePath).catch(() => Buffer.alloc(0));
        await rm(result.filePath, { force: true }).catch(() => undefined);
        const activeSession = getSession(session.streamId, session.generation);
        if (!activeSession || activeSession.state !== 'open' || controller.signal.aborted) {
          return;
        }
        segment.controller = null;
        if (
          result.output.codec !== session.output.codec
          || result.output.mimeType !== session.output.mimeType
          || bytes.byteLength === 0
        ) {
          markError(activeSession, segment, Object.assign(new Error('voice_inference_output_codec_not_supported'), {
            code: result.output.codec === session.output.codec ? 'invalid_audio_input' : 'unsupported_codec',
          }));
          return;
        }
        segment.status = 'ready';
        segment.event = {
          type: 'segment',
          streamId: session.streamId,
          generation: session.generation,
          segmentId: segmentId(session.streamId, segment.textSegment.index),
          segmentIndex: segment.textSegment.index,
          segmentCount: session.segments.length,
          text: segment.textSegment.text,
          textRange: {
            start: segment.textSegment.startOffset,
            end: segment.textSegment.endOffset,
          },
          textHash: segment.textSegment.textHash,
          output: result.output,
          audio: {
            contentBase64: Buffer.from(bytes).toString('base64'),
            sizeBytes: bytes.byteLength,
          },
          isLastSegment: segment.textSegment.isLastSegment,
        };
        notify(activeSession);
      }).catch((error) => {
        const activeSession = getSession(session.streamId, session.generation);
        if (!activeSession || controller.signal.aborted) {
          return;
        }
        segment.controller = null;
        markError(activeSession, segment, error);
      });
      synthesizePromise.catch(() => undefined);
    }
  }

  function nextReadyEvent(session: TtsStreamSession): DaemonVoiceInferenceTtsStreamEvent | null {
    if (session.errorEvent) {
      // Delivering the terminal event ends the stream: retiring it here is what
      // keeps an errored session (and anything staged for it) from outliving the
      // client that will never come back for it.
      const errorEvent = session.errorEvent;
      void closeSession(session, { cancelWorker: true, outcome: 'discarded' });
      return errorEvent;
    }
    const readySegment = session.segments.find((segment) =>
      segment.status === 'ready' && !segment.delivered && segment.event,
    );
    if (!readySegment?.event) {
      if (session.segments.every((segment) => segment.status === 'acked')) {
        const doneEvent = {
          type: 'done',
          streamId: session.streamId,
          generation: session.generation,
        } as const;
        void closeSession(session, { outcome: 'completed' });
        return doneEvent;
      }
      return null;
    }
    const event = readySegment.event;
    readySegment.delivered = true;
    readySegment.status = 'delivered';
    // The caller now owns the returned bytes. Drop daemon residency and refill
    // the synthesis window immediately; remote playback ACK remains completion
    // truth but is not an audio-prefetch pacing signal.
    readySegment.event = null;
    readySegment.ackTimer = setTimeout(() => {
      void closeSession(session, { cancelWorker: true, outcome: 'discarded' });
    }, ackTimeoutMs);
    (readySegment.ackTimer as { unref?: () => void }).unref?.();
    scheduleMore(session);
    return event;
  }

  const manager: VoiceInferenceTtsSegmentManager = {
    streamRoot,
    start: async (input) => {
      try {
        const segments = segmentTextForDaemonTts(input.text);
        if (segments.length === 0) {
          throw Object.assign(new Error('voice_inference_empty_tts_text'), { code: 'invalid_stream_state' });
        }
        const streamId = `tts-${randomUUID()}`;
        const session: TtsStreamSession = {
          requestId: input.requestId,
          streamId,
          generation: 0,
          packId: input.packId,
          voiceId: input.voiceId,
          speed: input.speed,
          output: input.output,
          segments: segments.map((textSegment) => ({
            textSegment,
            requestId: createSegmentRequestId(input.requestId, textSegment.index),
            controller: null,
            status: 'pending',
            delivered: false,
            event: null,
            ackTimer: null,
          })),
          nextSegmentToSchedule: 0,
          state: 'open',
          waiters: [],
          errorEvent: null,
          abandonTimer: null,
        };
        sessions.set(streamId, session);
        refreshAbandonDeadline(session);
        scheduleMore(session, input.prefetchDepth ?? defaultPrefetchDepth);
        return {
          ok: true,
          requestId: input.requestId,
          streamId,
          generation: session.generation,
          segmentCount: session.segments.length,
          output: input.output,
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
    next: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_tts_stream_not_found');
      }
      refreshAbandonDeadline(session);
      const ready = nextReadyEvent(session);
      if (ready) {
        return {
          ok: true,
          streamId: session.streamId,
          generation: session.generation,
          event: ready,
        };
      }
      return await new Promise<DaemonVoiceInferenceTtsStreamNextResponse>((resolve) => {
        session.waiters.push(() => {
          const activeSession = getSession(input.streamId, input.generation);
          if (!activeSession) {
            resolve(streamError('stream_not_found', 'daemon_voice_inference_tts_stream_not_found'));
            return;
          }
          const event = nextReadyEvent(activeSession);
          if (!event) {
            resolve(streamError('invalid_stream_state', 'daemon_voice_inference_tts_stream_not_ready'));
            return;
          }
          resolve({
            ok: true,
            streamId: activeSession.streamId,
            generation: activeSession.generation,
            event,
          });
        });
      });
    },
    ack: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_tts_stream_not_found');
      }
      const segment = session.segments[input.segmentIndex] ?? null;
      if (!segment || input.segmentId !== segmentId(session.streamId, input.segmentIndex)) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_tts_segment_not_found');
      }
      if (segment.status !== 'delivered' || !segment.delivered) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_tts_segment_not_delivered');
      }
      if (segment.ackTimer) {
        clearTimeout(segment.ackTimer);
        segment.ackTimer = null;
      }
      segment.status = 'acked';
      segment.event = null;
      scheduleMore(session);
      refreshAbandonDeadline(session);
      const complete = session.segments.every((candidate) => candidate.status === 'acked');
      if (complete) {
        await closeSession(session, { outcome: 'completed' });
      }
      return {
        ok: true,
        streamId: input.streamId,
        generation: input.generation,
        ackedSegmentIndex: input.segmentIndex,
        complete,
      };
    },
    cancel: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_tts_stream_not_found');
      }
      await closeSession(session, { cancelWorker: true, outcome: 'discarded' });
      return {
        ok: true,
        streamId: input.streamId,
        generation: input.generation,
      };
    },
    status: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_tts_stream_not_found');
      }
      const ackedSegmentCount = session.segments.filter((segment) => segment.status === 'acked').length;
      const deliveredSegmentCount = session.segments.filter((segment) => segment.delivered).length;
      const outstandingSegmentCount = session.segments.filter((segment) =>
        segment.status === 'synthesizing' || segment.status === 'ready',
      ).length;
      return {
        ok: true,
        streamId: session.streamId,
        generation: session.generation,
        state: session.state,
        segmentCount: session.segments.length,
        deliveredSegmentCount,
        ackedSegmentCount,
        outstandingSegmentCount,
      };
    },
    dispose: async () => {
      if (disposePromise) {
        return await disposePromise;
      }
      disposePromise = (async () => {
        await Promise.all([...sessions.values()].map((session) =>
          closeSession(session, { cancelWorker: true, outcome: 'discarded' }),
        ));
      })();
      return await disposePromise;
    },
  };

  return manager;
}
