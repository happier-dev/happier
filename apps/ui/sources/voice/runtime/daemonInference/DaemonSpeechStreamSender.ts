import type {
  DaemonVoiceInferenceSttStreamCancelResponse,
  DaemonVoiceInferenceSttStreamChunkResponse,
  DaemonVoiceInferenceSttStreamEvent,
  DaemonVoiceInferenceSttStreamFinishRequest,
  DaemonVoiceInferenceSttStreamFinishResponse,
  DaemonVoiceInferenceSttStreamStartRequest,
  DaemonVoiceInferenceSttStreamStartResponse,
  VoiceSpeechDiagnosticsCaptureContextV1,
} from '@happier-dev/protocol';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT } from '@happier-dev/protocol/daemon/voiceInference';
import {
  DEFAULT_MAX_PENDING_APPLICATION_DISPATCHES as DEFAULT_MAX_IN_FLIGHT_CHUNKS,
  DEFAULT_MAX_PENDING_APPLICATION_DISPATCH_BYTES as DEFAULT_MAX_IN_FLIGHT_BYTES,
} from '@happier-dev/peer-transport/duplexFrames';

import type { DaemonSpeechStreamTransportKind } from './daemonSpeechStreamDiagnostics';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

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
  /** PCM capacity of one negotiated carrier frame, after its encoding overhead. */
  maxPcm16ChunkBytes?: number;
  /** Bytes retained by downstream packet admission, including carrier encoding. */
  measureInFlightChunkBytes?: (pcm16ByteLength: number) => number;
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
  diagnostics?: VoiceSpeechDiagnosticsCaptureContextV1;
  maxInFlightChunks?: number;
  maxInFlightBytes?: number;
  finishTimeoutMs?: number;
  carrierAdapter?: DaemonSpeechStreamCarrierAdapter;
  transport: DaemonSpeechStreamTransport;
  transportKind?: Extract<DaemonSpeechStreamTransportKind, 'binary_tunnel' | 'json_rpc_compat'>;
}>;

type PendingChunk = {
  readonly seq: number;
  pcm16Bytes: Uint8Array;
  scheduledGeneration: number | null;
  acknowledged: boolean;
  responseEvents: readonly DaemonVoiceInferenceSttStreamEvent[] | null;
  resolve: (events: readonly DaemonVoiceInferenceSttStreamEvent[]) => void;
  reject: (error: unknown) => void;
  followers: Array<Readonly<{ resolve: (events: readonly DaemonVoiceInferenceSttStreamEvent[]) => void; reject: (error: unknown) => void }>>;
};

function createSenderError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function throwIfErrorResponse(response: Readonly<{ ok: boolean; errorCode?: string; error?: string }>): void {
  if (response.ok) {
    return;
  }
  const error = createSenderError(response.errorCode ?? response.error ?? 'daemon_speech_stream_error');
  Object.defineProperty(error, 'cause', { value: response, enumerable: false });
  throw error;
}

export class DaemonSpeechStreamSender {
  readonly transportKind: Extract<DaemonSpeechStreamTransportKind, 'binary_tunnel' | 'json_rpc_compat'>;
  private readonly requestId: string;
  private readonly packId: string | null;
  private readonly language: string | null;
  private readonly diagnostics: VoiceSpeechDiagnosticsCaptureContextV1 | undefined;
  private readonly maxInFlightChunks: number;
  private readonly maxInFlightBytes: number;
  private readonly finishTimeoutMs: number;
  private readonly carrierAdapter: DaemonSpeechStreamCarrierAdapter;
  private readonly transport: DaemonSpeechStreamTransport;

  private activeStream: ActiveStream | null = null;
  private closed = false;
  private localOwnerGeneration = 0;
  private nextSeq = 0;
  private lastAckSeq = -1;
  private highestSentSeq = -1;
  private readonly pendingChunks = new Map<number, PendingChunk>();
  private pendingBytes = 0;
  private inFlightChunks = 0;
  private inFlightBytes = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(options: DaemonSpeechStreamSenderOptions) {
    this.transportKind = options.transportKind ?? 'json_rpc_compat';
    this.requestId = options.requestId;
    this.packId = options.packId ?? null;
    this.language = options.language ?? null;
    this.diagnostics = options.diagnostics;
    this.maxInFlightChunks = Math.max(1, Math.trunc(options.maxInFlightChunks ?? DEFAULT_MAX_IN_FLIGHT_CHUNKS));
    this.maxInFlightBytes = Math.max(1, Math.trunc(options.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES));
    this.finishTimeoutMs = Math.max(1, Math.trunc(options.finishTimeoutMs ?? DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS));
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
      ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}),
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
    this.inFlightChunks = 0;
    this.inFlightBytes = 0;
    this.highestSentSeq = response.ackSeq;
    this.applyAck(response.ackSeq);
    this.pump(ownerGeneration);
  }

  pushChunk(pcm16Bytes: Uint8Array): Promise<readonly DaemonVoiceInferenceSttStreamEvent[]> {
    if (this.closed) {
      return Promise.reject(createSenderError('daemon_speech_stream_closed'));
    }
    // Only the real downstream packet-admission window bounds a send. Retain
    // accepted capture while it is occupied; a delayed ACK must not end a call.
    if (this.measureInFlightChunkBytes(pcm16Bytes.byteLength) > this.maxInFlightBytes) {
      return Promise.reject(createSenderError('daemon_speech_stream_backpressure'));
    }
    // Capture cadence is not packet cadence. While response slots are occupied,
    // fill an unsent packet up to the negotiated carrier capacity rather than
    // spending another slot on each 20ms capture frame. Never mutate sent PCM.
    const tail = this.pendingChunks.get(this.nextSeq - 1);
    const packetBudget = Math.min(this.transport.maxPcm16ChunkBytes ?? 0, this.maxInFlightBytes);
    if (tail && pcm16Bytes.byteLength > 0 && tail.pcm16Bytes.byteLength > 0
      && tail.scheduledGeneration === null && !tail.acknowledged
      && tail.pcm16Bytes.byteLength + pcm16Bytes.byteLength <= packetBudget
      && this.measureInFlightChunkBytes(tail.pcm16Bytes.byteLength + pcm16Bytes.byteLength) <= this.maxInFlightBytes) {
      const combined = new Uint8Array(tail.pcm16Bytes.byteLength + pcm16Bytes.byteLength);
      combined.set(tail.pcm16Bytes);
      combined.set(pcm16Bytes, tail.pcm16Bytes.byteLength);
      tail.pcm16Bytes = combined;
      this.pendingBytes += pcm16Bytes.byteLength;
      return new Promise((resolve, reject) => { tail.followers.push({ resolve, reject }); });
    }
    const seq = this.nextSeq++;
    const promise = new Promise<readonly DaemonVoiceInferenceSttStreamEvent[]>((resolve, reject) => {
      this.pendingChunks.set(seq, {
        seq,
        pcm16Bytes: new Uint8Array(pcm16Bytes),
        scheduledGeneration: null,
        acknowledged: false,
        responseEvents: null,
        resolve,
        reject,
        followers: [],
      });
    });
    this.pendingBytes += pcm16Bytes.byteLength;
    if (this.activeStream) {
      this.pump(this.localOwnerGeneration);
    }
    return promise;
  }

  async waitForDrain(): Promise<void> {
    if (this.isDrained()) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
      this.resolveDrainIfNeeded();
    });
  }

  async finish(): Promise<DaemonVoiceInferenceSttStreamFinishResponse> {
    if (this.closed) {
      throw createSenderError('daemon_speech_stream_closed');
    }
    try {
      // Draining may span several valid credit windows. The RPC deadline owns
      // the finish request below, not audio that has not reached that request.
      await this.waitForDrain();
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
    this.inFlightChunks = 0;
    this.inFlightBytes = 0;
    this.resolveDrainIfNeeded();
    if (active) {
      await this.transport.cancel(active);
    }
  }

  private pump(ownerGeneration: number): void {
    if (!this.activeStream || this.closed || ownerGeneration !== this.localOwnerGeneration) return;
    // Sequence allocation and scheduling are contiguous. Start after the last
    // send rather than copying/scanning the retained backlog on every capture.
    for (let seq = this.highestSentSeq + 1; seq < this.nextSeq; seq += 1) {
      if (this.inFlightChunks >= this.maxInFlightChunks) break;
      const pending = this.pendingChunks.get(seq);
      if (!pending) continue;
      if (pending.acknowledged) continue;
      if (pending.scheduledGeneration === ownerGeneration) continue;
      const sentByteLength = this.measureInFlightChunkBytes(pending.pcm16Bytes.byteLength);
      if (this.inFlightBytes + sentByteLength > this.maxInFlightBytes) break;
      pending.scheduledGeneration = ownerGeneration;
      this.highestSentSeq = Math.max(this.highestSentSeq, pending.seq);
      this.inFlightChunks += 1;
      this.inFlightBytes += sentByteLength;
      void this.sendChunk(pending, ownerGeneration).finally(() => {
        if (ownerGeneration !== this.localOwnerGeneration) return;
        this.inFlightChunks = Math.max(0, this.inFlightChunks - 1);
        this.inFlightBytes = Math.max(0, this.inFlightBytes - sentByteLength);
        this.pump(ownerGeneration);
        this.resolveDrainIfNeeded();
      });
    }
  }

  private measureInFlightChunkBytes(pcm16ByteLength: number): number {
    return this.transport.measureInFlightChunkBytes?.(pcm16ByteLength) ?? pcm16ByteLength;
  }

  private async sendChunk(pending: PendingChunk, ownerGeneration: number): Promise<void> {
    const active = this.activeStream;
    if (!active || ownerGeneration !== this.localOwnerGeneration || this.closed) {
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
        compatibilityTransport: carrierFrame.kind === 'machine_rpc_json_base64'
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
      pending.responseEvents = response.events;
      this.applyAck(response.ackSeq);
      this.settlePendingIfComplete();
    } catch (error) {
      if (ownerGeneration === this.localOwnerGeneration && !this.closed) {
        this.failActiveStream(error);
      }
    }
  }

  private applyAck(ackSeq: number): void {
    if (!Number.isSafeInteger(ackSeq) || ackSeq < -1 || ackSeq > this.highestSentSeq) {
      throw createSenderError('daemon_speech_stream_invalid_ack');
    }
    if (ackSeq <= this.lastAckSeq) {
      return;
    }
    this.lastAckSeq = ackSeq;
    for (const [seq, pending] of this.pendingChunks) {
      if (seq > ackSeq) break;
      if (!pending.acknowledged) {
        pending.acknowledged = true;
        this.pendingBytes = Math.max(0, this.pendingBytes - pending.pcm16Bytes.byteLength);
        pending.pcm16Bytes = new Uint8Array(0);
      }
    }
    this.settlePendingIfComplete();
    this.resolveDrainIfNeeded();
  }

  private settlePendingIfComplete(): void {
    // Cumulative ACKs can arrive before an earlier chunk's recognizer events.
    // Publish only the contiguous completed prefix of the same stream.
    for (const pending of this.pendingChunks.values()) {
      if (!pending.acknowledged || pending.responseEvents === null) return;
      this.pendingChunks.delete(pending.seq);
      pending.resolve(pending.responseEvents);
      // One packet yields one recognizer event batch, even when several capture
      // callbacks await its acknowledgement.
      for (const follower of pending.followers) follower.resolve([]);
    }
  }

  private closePending(error: unknown): void {
    for (const pending of this.pendingChunks.values()) {
      pending.reject(error);
      for (const follower of pending.followers) follower.reject(error);
    }
    this.pendingChunks.clear();
    this.pendingBytes = 0;
  }

  private failActiveStream(error: unknown): void {
    const active = this.activeStream;
    this.closed = true;
    this.activeStream = null;
    ++this.localOwnerGeneration;
    this.closePending(error);
    this.inFlightChunks = 0;
    this.inFlightBytes = 0;
    this.resolveDrainIfNeeded();
    if (active) void this.transport.cancel(active).catch(() => undefined);
  }

  private isDrained(): boolean {
    return this.pendingChunks.size === 0 && this.inFlightChunks === 0;
  }

  private resolveDrainIfNeeded(): void {
    if (!this.isDrained()) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
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
