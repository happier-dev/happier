import {
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
  VoiceRealtimeConnection,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';

type AsyncIterableValue<Value> = Value extends AsyncIterable<infer Item> ? Item : never;

export type VoiceConnectionCloseReason = Parameters<VoiceRealtimeConnection['close']>[0];
export type VoiceRealtimeConnectionKind = VoiceRealtimeConnection['kind'];
export type VoiceRealtimeConnectionState = ReturnType<VoiceRealtimeConnection['state']>;
export type VoiceRealtimeTransportEvent = AsyncIterableValue<
  ReturnType<VoiceRealtimeConnection['transportEvents']>
>;

export type VoiceConnectionDriver = Readonly<{
  open(input: Readonly<{
    signal: AbortSignal;
    onControl(event: unknown): void;
    onTransport(event: VoiceRealtimeTransportEvent): void;
    onRemoteClose(reason: string): void;
  }>): Promise<void>;
  sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
  beginOutputInterruptionCandidate?(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate?(resolution: VoicePlaybackInterruptionResolution): void;
  close(reason: VoiceConnectionCloseReason): Promise<void>;
}>;

export type VoiceNegotiatedWebRtcInput = Readonly<{
  signaling: Readonly<{
    exchangeOffer(input: Readonly<{
      offerSdp: string;
      signal: AbortSignal;
    }>): Promise<Readonly<{
      answerSdp: string;
    }>>;
  }>;
  control: Readonly<{
    label: string;
    onOpen(input: Readonly<{
      sendJson(value: VoiceRealtimeJsonValue): Promise<void>;
    }>): void | Promise<void>;
  }>;
}>;

export type VoiceHostNegotiatedWebRtcInput = VoiceNegotiatedWebRtcInput & Readonly<{
  micStream: MediaStream;
  duckGain: number;
  onClosed?(reason: VoiceConnectionCloseReason): void | Promise<void>;
}>;

export type VoicePcmConnectionMedia = Readonly<{
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  subscribeTerminal?(listener: (error: Error) => void): Readonly<{ remove: () => void }>;
  playbackCursorMs?(): number;
  beginOutputInterruptionCandidate?(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate?(resolution: VoicePlaybackInterruptionResolution): void;
}>;

export type { VoiceRealtimeConnection };

// The largest currently admitted Codex final is 394,440 B when its
// 192-code-unit id and 64-Ki-code-unit transcript both require six-byte JSON
// escapes. A 512 KiB inbound envelope leaves 129,848 B for bounded provider
// envelope growth. The largest current outbound tool-result vector is 65,636 B,
// so a 256 KiB envelope leaves 196,508 B for JSON/provider overhead. Retained
// generic sends and the native WebRTC buffer are each capped at one maximum
// outbound envelope; at most 64 ordered operations may retain work.
export const VOICE_REALTIME_CONTROL_LIMITS = Object.freeze({
  inboundControlBytes: 512 * 1024,
  outboundControlBytes: 256 * 1024,
  outboundRetainedBytes: 256 * 1024,
  outboundQueueItems: 64,
});

// Measured with Chromium 145's successful one-audio-transceiver + data-channel
// negotiation: offer 1,525 B, answer 1,371 B. Independent 64 KiB SDP envelopes
// leave >42x headroom for ICE/codec growth.
export const VOICE_WEBRTC_LIMITS = Object.freeze({
  offerSdpBytes: 64 * 1024,
  answerSdpBytes: 64 * 1024,
  inboundControlBytes: VOICE_REALTIME_CONTROL_LIMITS.inboundControlBytes,
  outboundControlBytes: VOICE_REALTIME_CONTROL_LIMITS.outboundControlBytes,
  outboundBufferedBytes: VOICE_REALTIME_CONTROL_LIMITS.outboundRetainedBytes,
  outboundQueueItems: VOICE_REALTIME_CONTROL_LIMITS.outboundQueueItems,
  controlLabelBytes: 64,
});

const controlTextEncoder = new TextEncoder();

function connectionError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function serializeControl(
  raw: VoiceRealtimeJsonValue,
  maxBytes: number,
): Readonly<{
  value: VoiceRealtimeJsonValue;
  serialized: string;
  byteLength: number;
}> {
  const value = VoiceRealtimeJsonValueSchema.parse(raw);
  const serialized = JSON.stringify(value);
  const byteLength = controlTextEncoder.encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    throw connectionError('voice_connection_outbound_control_oversized');
  }
  return { value, serialized, byteLength };
}

function abortError(): Error {
  return Object.assign(new Error('voice_connection_aborted'), { name: 'AbortError' });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidSdp(
  value: unknown,
  maxBytes: number,
  textEncoder: TextEncoder,
): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && !hasUnpairedSurrogate(value)
    && textEncoder.encode(value).byteLength <= maxBytes
  );
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortFailure: () => Error = abortError,
): Promise<T> {
  if (signal.aborted) throw abortFailure();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(abortFailure());
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

type PendingRead<T> = Readonly<{
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}>;

function createEventQueue<T>(input: Readonly<{
  maxQueuedEvents: number;
  onOverflow: () => void;
}>): Readonly<{
  publish: (event: T) => void;
  finish: (failure?: Error) => void;
  events: (signal: AbortSignal) => AsyncIterable<T>;
}> {
  const queue: T[] = [];
  const pendingReads: PendingRead<T>[] = [];
  let finished = false;
  let terminalFailure: Error | null = null;

  const finish = (failure?: Error): void => {
    if (finished) return;
    finished = true;
    terminalFailure = failure ?? null;
    queue.length = 0;
    while (pendingReads.length > 0) {
      const pending = pendingReads.shift()!;
      if (terminalFailure) pending.reject(terminalFailure);
      else pending.resolve({ done: true, value: undefined });
    }
  };

  const publish = (event: T): void => {
    if (finished) return;
    const pending = pendingReads.shift();
    if (pending) {
      pending.resolve({ done: false, value: event });
      return;
    }
    if (queue.length >= input.maxQueuedEvents) {
      input.onOverflow();
      return;
    }
    queue.push(event);
  };

  const events = (signal: AbortSignal): AsyncIterable<T> => Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (queue.length > 0) return { done: false, value: queue.shift()! };
          if (finished) {
            if (terminalFailure) throw terminalFailure;
            return { done: true, value: undefined };
          }
          if (signal.aborted) return { done: true, value: undefined };
          return await new Promise<IteratorResult<T>>((resolve, reject) => {
            const abort = (): void => {
              const index = pendingReads.indexOf(read);
              if (index >= 0) pendingReads.splice(index, 1);
              settle({ done: true, value: undefined });
            };
            const settle = (result: IteratorResult<T>): void => {
              signal.removeEventListener('abort', abort);
              resolve(result);
            };
            const fail = (error: Error): void => {
              signal.removeEventListener('abort', abort);
              reject(error);
            };
            const read: PendingRead<T> = { resolve: settle, reject: fail };
            pendingReads.push(read);
            signal.addEventListener('abort', abort, { once: true });
          });
        },
      };
    },
  });

  return Object.freeze({ publish, finish, events });
}

function createConnection(input: Readonly<{
  kind: VoiceRealtimeConnectionKind;
  driver: VoiceConnectionDriver;
  pcm?: VoicePcmConnectionMedia;
  maxQueuedControlEvents?: number;
}>): VoiceRealtimeConnection {
  const maxQueuedControlEvents = Math.max(1, Math.floor(input.maxQueuedControlEvents ?? 256));
  let currentState: VoiceRealtimeConnectionState = 'idle';
  let closePromise: Promise<void> | null = null;
  let sendTail: Promise<void> = Promise.resolve();
  let retainedSendCount = 0;
  let retainedSendBytes = 0;
  let terminalSendFailure: Error | null = null;
  let providerSessionId: string | null = null;
  let pcmTerminalSubscription: Readonly<{ remove: () => void }> | null = null;
  const lifecycleController = new AbortController();
  let controlQueue!: ReturnType<typeof createEventQueue<VoiceRealtimeJsonValue>>;
  let transportQueue!: ReturnType<typeof createEventQueue<VoiceRealtimeTransportEvent>>;

  // Keep async callback mutations visible to TypeScript. `currentState` may be
  // changed by the driver's remote-close callback while an awaited open/start
  // operation is in flight.
  const isClosed = (): boolean => currentState === 'closed';

  const close = async (reason: VoiceConnectionCloseReason): Promise<void> => {
    if (closePromise) return await closePromise;
    terminalSendFailure ??= reason.code === 'error' && reason.detail
      ? connectionError(reason.detail)
      : reason.code === 'aborted'
        ? abortError()
        : connectionError('voice_connection_not_open');
    currentState = 'closed';
    lifecycleController.abort();
    controlQueue.finish();
    transportQueue.finish();
    closePromise = (async () => {
      pcmTerminalSubscription?.remove();
      pcmTerminalSubscription = null;
      await input.pcm?.stop().catch(() => {});
      await input.driver.close(reason).catch(() => {});
    })();
    await closePromise;
  };

  const closeForOverflow = (): void => {
    void close({ code: 'error', detail: 'voice_connection_inbound_overflow' });
  };
  controlQueue = createEventQueue({
    maxQueuedEvents: maxQueuedControlEvents,
    onOverflow: closeForOverflow,
  });
  transportQueue = createEventQueue({
    maxQueuedEvents: maxQueuedControlEvents,
    onOverflow: closeForOverflow,
  });

  const publishControl = (raw: unknown): void => {
    if (currentState === 'closed') return;
    const parsed = VoiceRealtimeJsonValueSchema.safeParse(raw);
    if (!parsed.success) return;
    controlQueue.publish(parsed.data);
  };

  const publishTransport = (event: VoiceRealtimeTransportEvent): void => {
    if (currentState === 'closed') return;
    if (event.type === 'session_identity') providerSessionId = event.sessionId;
    transportQueue.publish(event);
  };

  return Object.freeze({
    kind: input.kind,
    async connect(signal: AbortSignal): Promise<void> {
      if (currentState !== 'idle') throw new Error('voice_connection_already_started');
      if (signal.aborted) {
        await close({ code: 'aborted' });
        throw abortError();
      }
      currentState = 'connecting';
      pcmTerminalSubscription = input.pcm?.subscribeTerminal?.((error) => {
        terminalSendFailure ??= error;
        void close({ code: 'error', detail: error.message });
      }) ?? null;
      const abortLifecycle = (): void => lifecycleController.abort();
      signal.addEventListener('abort', abortLifecycle, { once: true });
      try {
        const openDriver = input.driver.open({
          signal: lifecycleController.signal,
          onControl: publishControl,
          onTransport: publishTransport,
          onRemoteClose: (reason) => {
            void close({ code: 'remote_close', detail: reason });
          },
        });
        const startPcm = input.pcm?.start(lifecycleController.signal) ?? Promise.resolve();
        await raceWithAbort(
          Promise.all([openDriver, startPcm]).then(() => undefined),
          lifecycleController.signal,
        );
        if (lifecycleController.signal.aborted || isClosed()) throw abortError();
        currentState = 'open';
      } catch (error) {
        await close({ code: signal.aborted ? 'aborted' : 'error' });
        throw error;
      } finally {
        signal.removeEventListener('abort', abortLifecycle);
      }
    },
    async sendControl(raw: VoiceRealtimeJsonValue): Promise<void> {
      if (currentState !== 'open') throw connectionError('voice_connection_not_open');
      const { value: event, byteLength } = serializeControl(
        raw,
        VOICE_REALTIME_CONTROL_LIMITS.outboundControlBytes,
      );
      if (
        retainedSendCount >= VOICE_REALTIME_CONTROL_LIMITS.outboundQueueItems
        || retainedSendBytes + byteLength > VOICE_REALTIME_CONTROL_LIMITS.outboundRetainedBytes
      ) {
        const overflow = connectionError('voice_connection_outbound_overflow');
        terminalSendFailure ??= overflow;
        void close({ code: 'error', detail: overflow.message });
        throw overflow;
      }
      retainedSendCount += 1;
      retainedSendBytes += byteLength;
      const operation = sendTail.catch(() => {}).then(async () => {
        if (currentState !== 'open') {
          throw terminalSendFailure ?? connectionError('voice_connection_not_open');
        }
        await raceWithAbort(
          input.driver.sendControl(event),
          lifecycleController.signal,
          () => terminalSendFailure ?? connectionError('voice_connection_not_open'),
        );
      }).finally(() => {
        retainedSendCount -= 1;
        retainedSendBytes -= byteLength;
      });
      sendTail = operation.catch(() => {});
      await operation;
    },
    controlEvents: controlQueue.events,
    transportEvents: transportQueue.events,
    close,
    state: () => currentState,
    currentProviderSessionId: () => providerSessionId,
    playbackCursorMs: () => {
      const cursor = input.pcm?.playbackCursorMs?.();
      return typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0 ? cursor : null;
    },
    beginOutputInterruptionCandidate: () => (
      currentState === 'open'
        ? input.pcm?.beginOutputInterruptionCandidate?.()
          ?? input.driver.beginOutputInterruptionCandidate?.()
          ?? 'unsupported'
        : 'unsupported'
    ),
    resolveOutputInterruptionCandidate: (resolution) => {
      if (currentState !== 'open') return;
      if (input.pcm?.resolveOutputInterruptionCandidate) {
        input.pcm.resolveOutputInterruptionCandidate(resolution);
        return;
      }
      input.driver.resolveOutputInterruptionCandidate?.(resolution);
    },
  });
}

export function createWebSocketPcmConnection(input: Readonly<{
  driver: VoiceConnectionDriver;
  pcm: VoicePcmConnectionMedia;
  maxQueuedControlEvents?: number;
}>): VoiceRealtimeConnection {
  return createConnection({ ...input, kind: 'websocket_pcm' });
}

export type VoiceWebRtcRemoteOutputAttachment = Readonly<{
  playbackStarted?: Promise<void>;
  dispose(): void;
  beginOutputInterruptionCandidate(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void;
}>;

export function createWebRtcConnection(input: Readonly<{
  micStream: MediaStream;
  duckGain: number;
  signaling: VoiceHostNegotiatedWebRtcInput['signaling'];
  control: VoiceHostNegotiatedWebRtcInput['control'];
  onClosed?: VoiceHostNegotiatedWebRtcInput['onClosed'];
  maxQueuedControlEvents?: number;
  attachRemoteStream?: (stream: MediaStream | null) => VoiceWebRtcRemoteOutputAttachment;
  createPeerConnection?: () => RTCPeerConnection;
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream | null;
}>): VoiceRealtimeConnection {
  const remoteAudioPlaybackFailureCode = 'voice_webrtc_remote_audio_playback_failed';
  const maxQueuedControlEvents = Math.max(1, Math.floor(input.maxQueuedControlEvents ?? 256));
  const lifecycleController = new AbortController();
  const textEncoder = controlTextEncoder;
  let currentState: VoiceRealtimeConnectionState = 'idle';
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let remoteOutput: VoiceWebRtcRemoteOutputAttachment | null = null;
  let remotePlayback: Readonly<{
    abandon(): void;
  }> | null = null;
  let connectingRemotePlaybackFailure: Error | null = null;
  let closePromise: Promise<void> | null = null;
  let firstCloseReason: VoiceConnectionCloseReason | null = null;
  let sendTail: Promise<void> = Promise.resolve();
  let queuedSends = 0;
  let currentRemoteTrackId: string | null = null;
  const listeners: Array<() => void> = [];
  let controlQueue!: ReturnType<typeof createEventQueue<VoiceRealtimeJsonValue>>;
  let transportQueue!: ReturnType<typeof createEventQueue<VoiceRealtimeTransportEvent>>;

  const listen = <K extends keyof RTCPeerConnectionEventMap>(
    target: RTCPeerConnection,
    type: K,
    listener: (event: RTCPeerConnectionEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, listener as EventListener);
    listeners.push(() => target.removeEventListener(type, listener as EventListener));
  };
  const listenChannel = <K extends keyof RTCDataChannelEventMap>(
    target: RTCDataChannel,
    type: K,
    listener: (event: RTCDataChannelEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, listener as EventListener);
    listeners.push(() => target.removeEventListener(type, listener as EventListener));
  };
  const disposeRemoteOutput = (): void => {
    remotePlayback?.abandon();
    remotePlayback = null;
    const output = remoteOutput;
    remoteOutput = null;
    output?.dispose();
  };
  const close = async (reason: VoiceConnectionCloseReason): Promise<void> => {
    if (closePromise) return await closePromise;
    firstCloseReason = reason;
    currentState = 'closed';
    lifecycleController.abort();
    const terminalFailure = reason.code === 'error' && reason.detail
      ? Object.assign(new Error(reason.detail), { code: reason.detail })
      : undefined;
    controlQueue.finish(terminalFailure);
    transportQueue.finish(terminalFailure);
    closePromise = Promise.resolve().then(async () => {
      while (listeners.length > 0) listeners.pop()?.();
      disposeRemoteOutput();
      if (channel && channel.readyState !== 'closed') channel.close();
      channel = null;
      peer?.close();
      peer = null;
      currentRemoteTrackId = null;
      await input.onClosed?.(reason);
    });
    await closePromise;
  };
  const fail = (detail: string): void => {
    void close({ code: 'error', detail });
  };
  const failRemoteAudioPlayback = (): Error => {
    const error = Object.assign(new Error(remoteAudioPlaybackFailureCode), {
      code: remoteAudioPlaybackFailureCode,
    });
    if (currentState === 'connecting') connectingRemotePlaybackFailure ??= error;
    fail(remoteAudioPlaybackFailureCode);
    return error;
  };
  controlQueue = createEventQueue({
    maxQueuedEvents: maxQueuedControlEvents,
    onOverflow: () => fail('voice_connection_inbound_overflow'),
  });
  transportQueue = createEventQueue({
    maxQueuedEvents: maxQueuedControlEvents,
    onOverflow: () => fail('voice_connection_inbound_overflow'),
  });

  const waitForOutboundCapacity = async (
    dataChannel: RTCDataChannel,
    byteLength: number,
  ): Promise<void> => {
    const lowThreshold = VOICE_WEBRTC_LIMITS.outboundBufferedBytes - byteLength;
    while (dataChannel.bufferedAmount > lowThreshold) {
      dataChannel.bufferedAmountLowThreshold = lowThreshold;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          dataChannel.removeEventListener('bufferedamountlow', onBufferedAmountLow);
          dataChannel.removeEventListener('close', onClose);
          lifecycleController.signal.removeEventListener('abort', onAbort);
        };
        const onBufferedAmountLow = (): void => {
          if (dataChannel.bufferedAmount > lowThreshold) return;
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error('voice_connection_not_open'));
        };
        const onAbort = (): void => {
          cleanup();
          reject(abortError());
        };
        dataChannel.addEventListener('bufferedamountlow', onBufferedAmountLow);
        dataChannel.addEventListener('close', onClose, { once: true });
        lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
        if (dataChannel.bufferedAmount <= lowThreshold) onBufferedAmountLow();
      });
    }
  };
  const enqueueSend = async (
    raw: VoiceRealtimeJsonValue,
    allowConnecting: boolean,
  ): Promise<void> => {
    const { serialized, byteLength } = serializeControl(
      raw,
      VOICE_REALTIME_CONTROL_LIMITS.outboundControlBytes,
    );
    const stateAllowsSend = (): boolean => (
      currentState === 'open' || (allowConnecting && currentState === 'connecting')
    );
    if (!stateAllowsSend() || !channel || channel.readyState !== 'open') {
      throw new Error('voice_connection_not_open');
    }
    if (queuedSends >= VOICE_WEBRTC_LIMITS.outboundQueueItems) {
      const error = new Error('voice_connection_outbound_overflow');
      fail('voice_connection_outbound_overflow');
      throw error;
    }
    queuedSends += 1;
    const operation = sendTail.catch(() => {}).then(async () => {
      if (!stateAllowsSend() || !channel || channel.readyState !== 'open') {
        throw new Error('voice_connection_not_open');
      }
      const activeChannel = channel;
      await waitForOutboundCapacity(activeChannel, byteLength);
      if (
        !stateAllowsSend()
        || channel !== activeChannel
        || activeChannel.readyState !== 'open'
      ) {
        throw new Error('voice_connection_not_open');
      }
      try {
        activeChannel.send(serialized);
      } catch {
        const failureCode = 'voice_webrtc_data_channel_send_failed';
        const error = Object.assign(new Error(failureCode), { code: failureCode });
        await close({ code: 'error', detail: failureCode });
        throw error;
      }
    }).finally(() => {
      queuedSends -= 1;
    });
    sendTail = operation.catch(() => {});
    await operation;
  };
  const waitForChannelOpen = async (dataChannel: RTCDataChannel): Promise<void> => {
    if (lifecycleController.signal.aborted) throw abortError();
    if (dataChannel.readyState === 'open') return;
    if (dataChannel.readyState === 'closing' || dataChannel.readyState === 'closed') {
      throw Object.assign(new Error('voice_webrtc_data_channel_closed'), {
        code: 'voice_webrtc_data_channel_closed',
      });
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        dataChannel.removeEventListener('open', opened);
        dataChannel.removeEventListener('close', closed);
        lifecycleController.signal.removeEventListener('abort', aborted);
      };
      const opened = (): void => {
        cleanup();
        resolve();
      };
      const closed = (): void => {
        cleanup();
        reject(Object.assign(new Error('voice_webrtc_data_channel_closed'), {
          code: 'voice_webrtc_data_channel_closed',
        }));
      };
      const aborted = (): void => {
        cleanup();
        reject(abortError());
      };
      dataChannel.addEventListener('open', opened, { once: true });
      dataChannel.addEventListener('close', closed, { once: true });
      lifecycleController.signal.addEventListener('abort', aborted, { once: true });
      if (lifecycleController.signal.aborted) {
        aborted();
      } else if (dataChannel.readyState === 'open') {
        opened();
      } else if (dataChannel.readyState === 'closing' || dataChannel.readyState === 'closed') {
        closed();
      }
    });
  };
  const attachRemoteStream: (
    stream: MediaStream | null,
  ) => VoiceWebRtcRemoteOutputAttachment = input.attachRemoteStream ?? ((stream) => {
    if (typeof document === 'undefined') {
      return Object.freeze({
        dispose: () => {},
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate: () => {},
      });
    }
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    let playbackStarted: Promise<void>;
    try {
      playbackStarted = Promise.resolve(audio.play()).then(() => undefined);
    } catch {
      playbackStarted = Promise.reject(new Error(remoteAudioPlaybackFailureCode));
    }
    let candidateActive = false;
    return Object.freeze({
      playbackStarted,
      dispose() {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      },
      beginOutputInterruptionCandidate() {
        candidateActive = true;
        audio.volume = Math.max(0, Math.min(1, input.duckGain));
        return 'ducked' as const;
      },
      resolveOutputInterruptionCandidate(_resolution: VoicePlaybackInterruptionResolution) {
        if (!candidateActive) return;
        candidateActive = false;
        audio.volume = 1;
      },
    });
  });

  return Object.freeze({
    kind: 'webrtc' as const,
    async connect(signal: AbortSignal): Promise<void> {
      if (currentState !== 'idle') throw new Error('voice_connection_already_started');
      if (signal.aborted) {
        await close({ code: 'aborted' });
        throw abortError();
      }
      currentState = 'connecting';
      const abortLifecycle = (): void => lifecycleController.abort();
      const connectInterruptionError = (): Error => {
        if (firstCloseReason) {
          const failureCode = firstCloseReason.detail
            ?? `voice_connection_${firstCloseReason.code}`;
          return firstCloseReason.code === 'error'
            ? Object.assign(new Error(failureCode), { code: failureCode })
            : new Error(failureCode);
        }
        return signal.aborted ? abortError() : new Error('voice_connection_closed');
      };
      signal.addEventListener('abort', abortLifecycle, { once: true });
      try {
        if (
          input.control.label.length === 0
          || textEncoder.encode(input.control.label).byteLength > VOICE_WEBRTC_LIMITS.controlLabelBytes
          || /[\u0000-\u001f\u007f-\u009f]/u.test(input.control.label)
          || hasUnpairedSurrogate(input.control.label)
        ) {
          throw new Error('voice_webrtc_control_label_invalid');
        }
        if (!input.createPeerConnection && typeof RTCPeerConnection !== 'function') {
          throw new Error('voice_webrtc_unavailable');
        }
        const nextPeer = input.createPeerConnection?.() ?? new RTCPeerConnection();
        peer = nextPeer;
        const nextChannel = nextPeer.createDataChannel(input.control.label);
        channel = nextChannel;
        for (const track of input.micStream.getAudioTracks()) {
          nextPeer.addTrack(track, input.micStream);
        }
        listen(nextPeer, 'track', (event) => {
          const stream = event.streams[0]
            ?? input.createMediaStream?.([event.track])
            ?? (typeof MediaStream === 'function' ? new MediaStream([event.track]) : null);
          disposeRemoteOutput();
          let nextRemoteOutput: VoiceWebRtcRemoteOutputAttachment;
          try {
            nextRemoteOutput = attachRemoteStream(stream);
          } catch {
            failRemoteAudioPlayback();
            return;
          }
          remoteOutput = nextRemoteOutput;
          if (nextRemoteOutput.playbackStarted) {
            let abandonPlayback!: () => void;
            const abandoned = new Promise<void>((resolve) => {
              abandonPlayback = resolve;
            });
            const playbackSettlement = Promise.race([
              nextRemoteOutput.playbackStarted.catch(() => {
                if (remoteOutput !== nextRemoteOutput || currentState === 'closed') return;
                throw failRemoteAudioPlayback();
              }),
              abandoned,
            ]);
            remotePlayback = Object.freeze({
              abandon: abandonPlayback,
            });
            void playbackSettlement.catch(() => {});
          }
          transportQueue.publish({
            type: 'webrtc_remote_track',
            track: event.track,
            streams: event.streams,
            ...(currentRemoteTrackId && currentRemoteTrackId !== event.track.id
              ? { replacesTrackId: currentRemoteTrackId }
              : {}),
          });
          currentRemoteTrackId = event.track.id;
        });
        listen(nextPeer, 'iceconnectionstatechange', () => {
          transportQueue.publish({
            type: 'webrtc_ice_state',
            state: nextPeer.iceConnectionState,
          });
          if (nextPeer.iceConnectionState === 'closed' || nextPeer.iceConnectionState === 'failed') {
            fail(`voice_webrtc_ice_${nextPeer.iceConnectionState}`);
          }
        });
        listen(nextPeer, 'connectionstatechange', () => {
          if (nextPeer.connectionState === 'closed' || nextPeer.connectionState === 'failed') {
            fail(`voice_webrtc_${nextPeer.connectionState}`);
          }
        });
        listenChannel(nextChannel, 'open', () => {
          transportQueue.publish({ type: 'webrtc_data_channel_state', state: 'open' });
        });
        listenChannel(nextChannel, 'closing', () => {
          transportQueue.publish({ type: 'webrtc_data_channel_state', state: 'closing' });
        });
        listenChannel(nextChannel, 'close', () => {
          transportQueue.publish({ type: 'webrtc_data_channel_state', state: 'closed' });
          fail('voice_webrtc_data_channel_closed');
        });
        listenChannel(nextChannel, 'error', () => {
          fail('voice_webrtc_data_channel_error');
        });
        listenChannel(nextChannel, 'message', (event) => {
          if (typeof event.data !== 'string') {
            fail('voice_webrtc_control_binary');
            return;
          }
          if (textEncoder.encode(event.data).byteLength > VOICE_WEBRTC_LIMITS.inboundControlBytes) {
            fail('voice_webrtc_control_oversized');
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(event.data);
          } catch {
            fail('voice_webrtc_control_malformed');
            return;
          }
          const parsed = VoiceRealtimeJsonValueSchema.safeParse(raw);
          if (!parsed.success) {
            fail('voice_webrtc_control_invalid_json');
            return;
          }
          controlQueue.publish(parsed.data);
        });

        const offer = await raceWithAbort(
          nextPeer.createOffer(),
          lifecycleController.signal,
          connectInterruptionError,
        );
        const offerSdp = offer.sdp ?? '';
        if (!isValidSdp(offerSdp, VOICE_WEBRTC_LIMITS.offerSdpBytes, textEncoder)) {
          throw new Error('voice_webrtc_offer_invalid');
        }
        await raceWithAbort(
          nextPeer.setLocalDescription(offer),
          lifecycleController.signal,
          connectInterruptionError,
        );
        const answer = await raceWithAbort(
          input.signaling.exchangeOffer({
            offerSdp,
            signal: lifecycleController.signal,
          }),
          lifecycleController.signal,
          connectInterruptionError,
        );
        if (!isValidSdp(
          answer.answerSdp,
          VOICE_WEBRTC_LIMITS.answerSdpBytes,
          textEncoder,
        )) {
          throw new Error('voice_webrtc_answer_invalid');
        }
        await raceWithAbort(
          nextPeer.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp }),
          lifecycleController.signal,
          connectInterruptionError,
        );
        await waitForChannelOpen(nextChannel);
        if (lifecycleController.signal.aborted) throw abortError();
        let acceptsInitialControls = true;
        let initialControlBarrier: Promise<void> = Promise.resolve();
        const sendInitialJson = (value: VoiceRealtimeJsonValue): Promise<void> => {
          if (!acceptsInitialControls) {
            const rejection = Promise.reject<void>(connectionError(
              'voice_webrtc_initial_control_barrier_closed',
            ));
            void rejection.catch(() => {});
            return rejection;
          }
          const operation = enqueueSend(value, true);
          const guardedOperation = operation.catch((error: unknown) => {
            const failureCode = error
              && typeof error === 'object'
              && 'code' in error
              && typeof error.code === 'string'
              ? error.code
              : 'voice_webrtc_initial_control_failed';
            fail(failureCode);
            throw error;
          });
          initialControlBarrier = Promise.all([
            initialControlBarrier,
            guardedOperation,
          ]).then(() => undefined);
          void initialControlBarrier.catch(() => {});
          return operation;
        };
        try {
          await raceWithAbort(
            Promise.resolve(input.control.onOpen({ sendJson: sendInitialJson })),
            lifecycleController.signal,
            connectInterruptionError,
          );
        } finally {
          acceptsInitialControls = false;
        }
        await raceWithAbort(
          initialControlBarrier,
          lifecycleController.signal,
          connectInterruptionError,
        );
        if (lifecycleController.signal.aborted) throw abortError();
        currentState = 'open';
      } catch (error) {
        const firstCloseFailureCode = firstCloseReason?.detail
          ?? (firstCloseReason ? `voice_connection_${firstCloseReason.code}` : null);
        const firstCloseFailure = firstCloseFailureCode
          ? (
              firstCloseReason?.code === 'error'
                ? Object.assign(new Error(firstCloseFailureCode), { code: firstCloseFailureCode })
                : new Error(firstCloseFailureCode)
            )
          : null;
        await close({ code: signal.aborted ? 'aborted' : 'error' });
        throw connectingRemotePlaybackFailure ?? firstCloseFailure ?? error;
      } finally {
        signal.removeEventListener('abort', abortLifecycle);
      }
    },
    async sendControl(event: VoiceRealtimeJsonValue): Promise<void> {
      await enqueueSend(event, false);
    },
    controlEvents: controlQueue.events,
    transportEvents: transportQueue.events,
    close,
    state: () => currentState,
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => (
      currentState === 'open'
        ? remoteOutput?.beginOutputInterruptionCandidate() ?? 'unsupported'
        : 'unsupported'
    ),
    resolveOutputInterruptionCandidate: (resolution) => {
      if (currentState !== 'open') return;
      remoteOutput?.resolveOutputInterruptionCandidate(resolution);
    },
  });
}

export function createSdkHandleConnection(input: Readonly<{
  driver: VoiceConnectionDriver;
  maxQueuedControlEvents?: number;
}>): VoiceRealtimeConnection {
  return createConnection({ ...input, kind: 'sdk_handle' });
}
