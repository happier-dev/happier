import type {
  DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkResponse,
  DaemonVoiceInferenceSttStreamEvent,
  DaemonVoiceInferenceSttStreamFinishRequest,
  DaemonVoiceInferenceSttStreamFinishResponse,
  DaemonVoiceInferenceSttStreamStartRequest,
  DaemonVoiceInferenceSttStreamStartResponse,
} from '@happier-dev/protocol';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT } from '@happier-dev/protocol';

import {
  createDaemonSpeechStreamRpcCompatibilityCarrierAdapter,
  describeDaemonSpeechStreamRpcCompatibilityTransport,
  type DaemonSpeechStreamCarrierAdapter,
  type DaemonSpeechStreamCarrierFrame,
  type DaemonSpeechStreamRpcCompatibilityTransportDescriptor,
} from './DaemonSpeechStreamCarrier';

type ActiveStream = Readonly<{
  streamId: string;
  generation: number;
}>;

export type DaemonSpeechStreamTransport = Readonly<{
  start: (input: DaemonVoiceInferenceSttStreamStartRequest) => Promise<DaemonVoiceInferenceSttStreamStartResponse>;
  chunk: (input: DaemonSpeechStreamTransportChunkRequest) => Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  finish: (input: DaemonVoiceInferenceSttStreamFinishRequest) => Promise<DaemonVoiceInferenceSttStreamFinishResponse>;
  cancel: (input: Readonly<{ streamId: string; generation: number }>) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
}>;

export type DaemonSpeechStreamTransportChunkRequest = Readonly<{
  streamId: string;
  generation: number;
  seq: number;
  carrierFrame: DaemonSpeechStreamCarrierFrame;
  compatibilityTransport: DaemonSpeechStreamRpcCompatibilityTransportDescriptor | null;
}>;

export type DaemonSpeechStreamSenderOptions = Readonly<{
  requestId: string;
  packId?: string | null;
  language?: string | null;
  maxBufferedChunks?: number;
  finishTimeoutMs?: number;
  carrierAdapter?: DaemonSpeechStreamCarrierAdapter;
  transport: DaemonSpeechStreamTransport;
}>;

type PendingChunk = {
  readonly seq: number;
  readonly pcm16Bytes: Uint8Array;
  resolve: (events: readonly DaemonVoiceInferenceSttStreamEvent[]) => void;
  reject: (error: unknown) => void;
};

const DEFAULT_MAX_BUFFERED_CHUNKS = 64;
const DEFAULT_FINISH_TIMEOUT_MS = 10_000;

function createSenderError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function throwIfErrorResponse(response: Readonly<{ ok: boolean; errorCode?: string; error?: string }>): void {
  if (response.ok) {
    return;
  }
  throw createSenderError(response.errorCode ?? response.error ?? 'daemon_speech_stream_error');
}

export class DaemonSpeechStreamSender {
  private readonly requestId: string;
  private readonly packId: string | null;
  private readonly language: string | null;
  private readonly maxBufferedChunks: number;
  private readonly finishTimeoutMs: number;
  private readonly carrierAdapter: DaemonSpeechStreamCarrierAdapter;
  private readonly transport: DaemonSpeechStreamTransport;

  private activeStream: ActiveStream | null = null;
  private closed = false;
  private localOwnerGeneration = 0;
  private nextSeq = 0;
  private lastAckSeq = -1;
  private readonly pendingChunks = new Map<number, PendingChunk>();
  private sendTail: Promise<void> = Promise.resolve();

  constructor(options: DaemonSpeechStreamSenderOptions) {
    this.requestId = options.requestId;
    this.packId = options.packId ?? null;
    this.language = options.language ?? null;
    this.maxBufferedChunks = Math.max(1, Math.trunc(options.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS));
    this.finishTimeoutMs = Math.max(1, Math.trunc(options.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS));
    this.carrierAdapter = options.carrierAdapter ?? createDaemonSpeechStreamRpcCompatibilityCarrierAdapter();
    this.transport = options.transport;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw createSenderError('daemon_speech_stream_closed');
    }
    const ownerGeneration = ++this.localOwnerGeneration;
    const response = await this.transport.start({
      requestId: this.requestId,
      packId: this.packId,
      language: this.language,
      streamingMode: 'runtime',
      format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
    });
    if (ownerGeneration !== this.localOwnerGeneration || this.closed) {
      throw createSenderError('daemon_speech_stream_stale_start');
    }
    throwIfErrorResponse(response);
    if (!response.ok) {
      return;
    }
    this.activeStream = {
      streamId: response.streamId,
      generation: response.generation,
    };
    this.applyAck(response.ackSeq);
    this.flushPending(ownerGeneration);
  }

  async restart(): Promise<void> {
    if (this.closed) {
      throw createSenderError('daemon_speech_stream_closed');
    }
    await this.start();
  }

  pushChunk(pcm16Bytes: Uint8Array): Promise<readonly DaemonVoiceInferenceSttStreamEvent[]> {
    if (this.closed) {
      return Promise.reject(createSenderError('daemon_speech_stream_closed'));
    }
    if (this.pendingChunks.size >= this.maxBufferedChunks) {
      return Promise.reject(createSenderError('daemon_speech_stream_backpressure'));
    }
    const seq = this.nextSeq++;
    const promise = new Promise<readonly DaemonVoiceInferenceSttStreamEvent[]>((resolve, reject) => {
      this.pendingChunks.set(seq, {
        seq,
        pcm16Bytes: new Uint8Array(pcm16Bytes),
        resolve,
        reject,
      });
    });
    if (this.activeStream) {
      this.scheduleChunk(seq, this.localOwnerGeneration);
    }
    return promise;
  }

  async waitForDrain(): Promise<void> {
    await this.sendTail;
  }

  async finish(): Promise<DaemonVoiceInferenceSttStreamFinishResponse> {
    if (this.closed) {
      throw createSenderError('daemon_speech_stream_closed');
    }
    try {
      await this.withFinishTimeout(this.waitForDrain());
      const active = this.activeStream;
      if (!active) {
        throw createSenderError('daemon_speech_stream_not_started');
      }
      const ownerGeneration = this.localOwnerGeneration;
      const response = await this.withFinishTimeout(this.transport.finish({
        streamId: active.streamId,
        generation: active.generation,
        finalSeq: Math.max(0, this.nextSeq - 1),
      }));
      if (ownerGeneration !== this.localOwnerGeneration || this.closed) {
        throw createSenderError('daemon_speech_stream_stale_finish');
      }
      throwIfErrorResponse(response);
      if (response.ok) {
        this.applyAck(response.ackSeq);
      }
      this.closePending(createSenderError('daemon_speech_stream_closed'));
      this.closed = true;
      this.activeStream = null;
      return response;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'daemon_speech_stream_finish_timeout') {
        await this.cancel();
      }
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) {
      return;
    }
    const active = this.activeStream;
    this.closed = true;
    this.activeStream = null;
    ++this.localOwnerGeneration;
    this.closePending(createSenderError('daemon_speech_stream_closed'));
    this.sendTail = Promise.resolve();
    if (active) {
      await this.transport.cancel(active);
    }
  }

  private flushPending(ownerGeneration: number): void {
    for (const seq of [...this.pendingChunks.keys()].sort((a, b) => a - b)) {
      this.scheduleChunk(seq, ownerGeneration);
    }
  }

  private scheduleChunk(seq: number, ownerGeneration: number): void {
    this.sendTail = this.sendTail
      .catch(() => undefined)
      .then(async () => {
        await this.sendChunk(seq, ownerGeneration);
      });
  }

  private async sendChunk(seq: number, ownerGeneration: number): Promise<void> {
    const pending = this.pendingChunks.get(seq);
    const active = this.activeStream;
    if (!pending || !active || ownerGeneration !== this.localOwnerGeneration || this.closed) {
      return;
    }
    try {
      const carrierFrame = this.carrierAdapter.encodeInputAppendFrame({
        streamId: active.streamId,
        generation: active.generation,
        seq: pending.seq,
        pcm16Bytes: pending.pcm16Bytes,
      });
      const response = await this.transport.chunk({
        streamId: active.streamId,
        generation: active.generation,
        seq: pending.seq,
        carrierFrame,
        compatibilityTransport: carrierFrame.kind === 'json_base64_v1_fallback'
          ? describeDaemonSpeechStreamRpcCompatibilityTransport()
          : null,
      });
      if (ownerGeneration !== this.localOwnerGeneration || this.closed) {
        return;
      }
      throwIfErrorResponse(response);
      if (!response.ok) {
        return;
      }
      this.applyAck(response.ackSeq);
      pending.resolve(response.events);
    } catch (error) {
      if (ownerGeneration === this.localOwnerGeneration && !this.closed) {
        pending.reject(error);
      }
    }
  }

  private applyAck(ackSeq: number): void {
    if (ackSeq <= this.lastAckSeq) {
      return;
    }
    this.lastAckSeq = ackSeq;
    for (const [seq] of this.pendingChunks) {
      if (seq <= ackSeq) {
        this.pendingChunks.delete(seq);
      }
    }
  }

  private closePending(error: unknown): void {
    for (const pending of this.pendingChunks.values()) {
      pending.reject(error);
    }
    this.pendingChunks.clear();
  }

  private async withFinishTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(createSenderError('daemon_speech_stream_finish_timeout')), this.finishTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createDaemonSpeechStreamSender(options: DaemonSpeechStreamSenderOptions): DaemonSpeechStreamSender {
  return new DaemonSpeechStreamSender(options);
}
