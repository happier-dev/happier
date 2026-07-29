type AudioProcessEventLike = Readonly<{
  inputBuffer: Readonly<{
    sampleRate: number;
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }>;
  outputBuffer?: Readonly<{
    numberOfChannels: number;
    getChannelData(channel: number): Float32Array;
  }>;
}>;

type ScriptProcessorNodeLike = Readonly<{
  connect(destination: unknown): void;
  disconnect(): void;
}> & {
  onaudioprocess: ((event: AudioProcessEventLike) => void) | null;
};

type AudioWorkletPortLike = {
  close?(): void;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
};

type AudioWorkletNodeLike = Readonly<{
  connect(destination: unknown): void;
  disconnect(): void;
  port: AudioWorkletPortLike;
}>;

type AudioWorkletNodeConstructorLike = new (
  context: unknown,
  name: string,
  options?: AudioWorkletNodeOptions,
) => AudioWorkletNodeLike;

type MediaStreamAudioSourceNodeLike = Readonly<{
  connect(destination: unknown): void;
  disconnect(): void;
}>;

type AudioContextLike = Readonly<{
  destination: unknown;
  sampleRate: number;
  state?: AudioContextState | string;
  resume?(): Promise<void>;
  audioWorklet?: Readonly<{ addModule(moduleUrl: string): Promise<void> }>;
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike;
  createScriptProcessor?(
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ): ScriptProcessorNodeLike;
}>;

type DocumentLike = Readonly<{
  visibilityState?: string;
  addEventListener?(eventName: 'visibilitychange', listener: () => void): void;
  removeEventListener?(eventName: 'visibilitychange', listener: () => void): void;
}>;

type UrlLike = Readonly<{
  createObjectURL?(blob: Blob): string;
  revokeObjectURL?(url: string): void;
}>;

type AudioTrackLike = Readonly<{
  addEventListener?(eventName: 'ended', listener: () => void): void;
  removeEventListener?(eventName: 'ended', listener: () => void): void;
}>;

export type WebPcmCaptureError =
  | 'web_pcm_capture_backpressure'
  | 'web_pcm_capture_chunk_failed'
  | 'web_pcm_capture_device_lost'
  | 'web_pcm_capture_invalid_chunk'
  | 'web_pcm_capture_media_source_failed'
  | 'web_pcm_capture_mic_acquisition_failed'
  | 'web_pcm_capture_mic_state_unavailable'
  | 'web_pcm_capture_resume_failed'
  | 'web_pcm_capture_unavailable';

export type WebPcmCaptureChunk = Readonly<{
  bytes: Uint8Array;
  level: number;
}>;

export type WebPcmCaptureOptions = Readonly<{
  mic: Readonly<{
    ensureActive?(): Promise<void>;
    isMuted?(): boolean;
    getStream(): MediaStream | null;
    getAudioContext?(): AudioContext | null;
  }>;
  format: Readonly<{
    sampleRate: number;
    channels: 1;
    encoding: 'pcm16le';
  }>;
  chunkMs: number;
  fallback: 'allow_script_processor' | 'disabled';
  onChunk(chunk: WebPcmCaptureChunk): Promise<void> | void;
  onError?(error: WebPcmCaptureError): void;
  onFallbackActivated?(kind: 'script_processor'): void;
  signal?: AbortSignal | null;
  processorBufferSize?: number;
  maxQueuedChunks?: number;
}>;

export type WebPcmCapture = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForDrain(): Promise<void>;
  isActive(): boolean;
  level(): number;
}>;

const DEFAULT_PROCESSOR_BUFFER_SIZE = 4096;
const DEFAULT_MAX_QUEUED_CHUNKS = 8;
let nextWorkletId = 1;

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function normalizeLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function zeroOutputBuffer(event: AudioProcessEventLike): void {
  const output = event.outputBuffer;
  if (!output) return;
  for (let channel = 0; channel < output.numberOfChannels; channel += 1) {
    output.getChannelData(channel).fill(0);
  }
}

function mixToMono(inputBuffer: AudioProcessEventLike['inputBuffer']): Float32Array {
  const channelCount = Math.max(1, Math.trunc(inputBuffer.numberOfChannels || 1));
  const reference = inputBuffer.getChannelData(0);
  const mixed = new Float32Array(reference.length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const channelData = inputBuffer.getChannelData(channel);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] += (channelData[index] ?? 0) / channelCount;
    }
  }
  return mixed;
}

function calculateLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return normalizeLevel(Math.sqrt(sum / samples.length));
}

function createStreamingLinearResampler(targetRate: number): Readonly<{
  push(samples: Float32Array, sourceRate: number): Float32Array;
  reset(): void;
}> {
  let pending: number[] = [];
  let position = 0;
  let currentSourceRate: number | null = null;
  const reset = (): void => {
    pending = [];
    position = 0;
    currentSourceRate = null;
  };
  return Object.freeze({
    push(samples, sourceRate) {
      if (samples.length === 0 || !Number.isFinite(sourceRate) || sourceRate <= 0) {
        return new Float32Array();
      }
      if (currentSourceRate !== null && currentSourceRate !== sourceRate) reset();
      currentSourceRate = sourceRate;
      if (sourceRate === targetRate && pending.length === 0) return samples;
      for (const sample of samples) pending.push(sample);
      const output: number[] = [];
      const ratio = sourceRate / targetRate;
      while (position + 1 < pending.length) {
        const leftIndex = Math.floor(position);
        const fraction = position - leftIndex;
        const left = pending[leftIndex] ?? 0;
        const right = pending[leftIndex + 1] ?? left;
        output.push(left + (right - left) * fraction);
        position += ratio;
      }
      const removable = Math.min(Math.floor(position), Math.max(0, pending.length - 1));
      if (removable > 0) {
        pending.splice(0, removable);
        position -= removable;
      }
      return Float32Array.from(output);
    },
    reset,
  });
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

function encodePcm16Le(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

function isAudioContextSuspended(context: AudioContextLike): boolean {
  const state = String(context.state ?? '');
  return state === 'suspended' || state === 'interrupted';
}

async function resumeAudioContextIfNeeded(context: AudioContextLike): Promise<void> {
  if (!isAudioContextSuspended(context) || typeof context.resume !== 'function') return;
  await context.resume();
}

function getDocumentLike(): DocumentLike | null {
  return (globalThis as typeof globalThis & { document?: DocumentLike }).document ?? null;
}

function getUrlLike(): UrlLike | null {
  return (globalThis as typeof globalThis & { URL?: UrlLike }).URL ?? null;
}

function getAudioWorkletNodeConstructor(): AudioWorkletNodeConstructorLike | null {
  const constructor = (globalThis as typeof globalThis & {
    AudioWorkletNode?: AudioWorkletNodeConstructorLike;
  }).AudioWorkletNode;
  return typeof constructor === 'function' ? constructor : null;
}

function readBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function readWorkletChunk(data: unknown, expectedBytes: number): WebPcmCaptureChunk | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Readonly<{ type?: unknown; bytes?: unknown; level?: unknown }>;
  if (payload.type !== 'pcm16le') return null;
  const bytes = readBytes(payload.bytes);
  if (!bytes || bytes.byteLength !== expectedBytes || bytes.byteLength % 2 !== 0) return null;
  return { bytes, level: normalizeLevel(payload.level) };
}

function buildAudioWorkletSource(input: Readonly<{
  processorName: string;
  targetSampleRate: number;
  targetSamplesPerChunk: number;
}>): string {
  return `
class HappierWebPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.sourcePending = [];
    this.sourcePosition = 0;
  }

  mixToMono(channels) {
    const first = channels[0];
    const length = first ? first.length : 0;
    const mono = new Float32Array(length);
    const count = Math.max(1, channels.length);
    for (let channel = 0; channel < count; channel += 1) {
      const values = channels[channel] || first;
      for (let index = 0; index < length; index += 1) {
        mono[index] += (values && typeof values[index] === 'number' ? values[index] : 0) / count;
      }
    }
    return mono;
  }

  resample(samples) {
    const targetRate = ${input.targetSampleRate};
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) return new Float32Array();
    if (sampleRate === targetRate && this.sourcePending.length === 0) return samples;
    for (const sample of samples) this.sourcePending.push(sample);
    const output = [];
    const ratio = sampleRate / targetRate;
    while (this.sourcePosition + 1 < this.sourcePending.length) {
      const leftIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - leftIndex;
      const left = typeof this.sourcePending[leftIndex] === 'number' ? this.sourcePending[leftIndex] : 0;
      const right = typeof this.sourcePending[leftIndex + 1] === 'number' ? this.sourcePending[leftIndex + 1] : left;
      output.push(left + (right - left) * fraction);
      this.sourcePosition += ratio;
    }
    const removable = Math.min(Math.floor(this.sourcePosition), Math.max(0, this.sourcePending.length - 1));
    if (removable > 0) {
      this.sourcePending.splice(0, removable);
      this.sourcePosition -= removable;
    }
    return Float32Array.from(output);
  }

  toInt16(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels || !channels[0] || channels[0].length === 0) return true;
    const mono = this.mixToMono(channels);
    let sum = 0;
    for (const sample of mono) sum += sample * sample;
    const level = Math.max(0, Math.min(1, Math.sqrt(sum / Math.max(1, mono.length))));
    const resampled = this.resample(mono);
    for (const sample of resampled) this.pending.push(this.toInt16(sample));
    const chunkSize = ${input.targetSamplesPerChunk};
    while (this.pending.length >= chunkSize) {
      const samples = this.pending.splice(0, chunkSize);
      const bytes = new Uint8Array(samples.length * 2);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index], true);
      this.port.postMessage({ type: 'pcm16le', bytes: bytes.buffer, level }, [bytes.buffer]);
    }
    return true;
  }
}

registerProcessor('${input.processorName}', HappierWebPcmCaptureProcessor);
`;
}

export function createWebPcmCapture(options: WebPcmCaptureOptions): WebPcmCapture {
  const targetSampleRate = normalizePositiveInteger(options.format.sampleRate, 16_000);
  const targetSamplesPerChunk = Math.max(
    1,
    Math.round(targetSampleRate * normalizePositiveInteger(options.chunkMs, 20) / 1_000),
  );
  const processorBufferSize = normalizePositiveInteger(
    options.processorBufferSize,
    DEFAULT_PROCESSOR_BUFFER_SIZE,
  );
  const maxQueuedChunks = normalizePositiveInteger(
    options.maxQueuedChunks,
    DEFAULT_MAX_QUEUED_CHUNKS,
  );

  let active = false;
  let failed = false;
  let lifecycleVersion = 0;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let sourceNode: MediaStreamAudioSourceNodeLike | null = null;
  let processorNode: ScriptProcessorNodeLike | null = null;
  let workletNode: AudioWorkletNodeLike | null = null;
  let workletModuleUrl: string | null = null;
  let pendingSamples: number[] = [];
  const resampler = createStreamingLinearResampler(targetSampleRate);
  let queuedChunks = 0;
  let latestLevel = 0;
  let drainTail: Promise<void> = Promise.resolve();
  let unlinkAbort = (): void => {};
  let unlinkVisibility = (): void => {};
  let unlinkDeviceLoss = (): void => {};

  const cleanup = (): void => {
    active = false;
    pendingSamples = [];
    resampler.reset();
    latestLevel = 0;
    unlinkAbort();
    unlinkAbort = () => {};
    unlinkVisibility();
    unlinkVisibility = () => {};
    unlinkDeviceLoss();
    unlinkDeviceLoss = () => {};
    if (workletNode) {
      workletNode.port.onmessage = null;
      try { workletNode.port.close?.(); } catch {}
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }
    if (workletModuleUrl) {
      try { getUrlLike()?.revokeObjectURL?.(workletModuleUrl); } catch {}
      workletModuleUrl = null;
    }
    if (processorNode) {
      processorNode.onaudioprocess = null;
      try { processorNode.disconnect(); } catch {}
      processorNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
      sourceNode = null;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    lifecycleVersion += 1;
    const pendingStart = startPromise;
    stopPromise = (async () => {
      cleanup();
      await pendingStart?.catch(() => {});
      cleanup();
      await drainTail.catch(() => {});
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const fail = (reason: WebPcmCaptureError): void => {
    if (failed) return;
    failed = true;
    try {
      options.onError?.(reason);
    } catch {
      // Error observers must not prevent deterministic capture teardown.
    } finally {
      void stop();
    }
  };

  const enqueueChunk = (chunk: WebPcmCaptureChunk): void => {
    if (!active || options.mic.isMuted?.() === true) return;
    latestLevel = normalizeLevel(chunk.level);
    if (queuedChunks >= maxQueuedChunks) {
      fail('web_pcm_capture_backpressure');
      return;
    }
    queuedChunks += 1;
    drainTail = drainTail
      .catch(() => undefined)
      .then(async () => options.onChunk(chunk))
      .catch(() => fail('web_pcm_capture_chunk_failed'))
      .finally(() => {
        queuedChunks = Math.max(0, queuedChunks - 1);
      });
  };

  const flushFallbackSamples = (level: number): void => {
    while (pendingSamples.length >= targetSamplesPerChunk && active) {
      const samples = pendingSamples.splice(0, targetSamplesPerChunk);
      enqueueChunk({ bytes: encodePcm16Le(samples), level });
    }
  };

  const handleAudioProcess = (event: AudioProcessEventLike): void => {
    zeroOutputBuffer(event);
    if (!active || options.mic.isMuted?.() === true) return;
    const mono = mixToMono(event.inputBuffer);
    const level = calculateLevel(mono);
    const resampled = resampler.push(mono, event.inputBuffer.sampleRate);
    for (const sample of resampled) pendingSamples.push(floatToInt16(sample));
    flushFallbackSamples(level);
  };

  const attachVisibilityResume = (context: AudioContextLike): void => {
    const documentLike = getDocumentLike();
    if (typeof documentLike?.addEventListener !== 'function'
      || typeof documentLike.removeEventListener !== 'function') return;
    const onVisibilityChange = (): void => {
      if (active && documentLike.visibilityState === 'visible') {
        void resumeAudioContextIfNeeded(context).catch(() => {
          fail('web_pcm_capture_resume_failed');
        });
      }
    };
    documentLike.addEventListener('visibilitychange', onVisibilityChange);
    unlinkVisibility = () => documentLike.removeEventListener?.('visibilitychange', onVisibilityChange);
  };

  const attachDeviceLoss = (stream: MediaStream): void => {
    const tracks = typeof stream.getAudioTracks === 'function'
      ? stream.getAudioTracks() as readonly AudioTrackLike[]
      : [];
    const onEnded = (): void => fail('web_pcm_capture_device_lost');
    for (const track of tracks) track.addEventListener?.('ended', onEnded);
    unlinkDeviceLoss = () => {
      for (const track of tracks) track.removeEventListener?.('ended', onEnded);
    };
  };

  const tryStartWorklet = async (
    context: AudioContextLike,
    version: number,
  ): Promise<boolean> => {
    const addModule = context.audioWorklet?.addModule;
    const WorkletNode = getAudioWorkletNodeConstructor();
    const urlLike = getUrlLike();
    if (typeof addModule !== 'function'
      || !WorkletNode
      || typeof Blob !== 'function'
      || typeof urlLike?.createObjectURL !== 'function') return false;

    const processorName = `happier-web-pcm-capture-${nextWorkletId++}`;
    workletModuleUrl = urlLike.createObjectURL(new Blob([
      buildAudioWorkletSource({ processorName, targetSampleRate, targetSamplesPerChunk }),
    ], { type: 'application/javascript' }));
    try {
      await addModule(workletModuleUrl);
      if (version !== lifecycleVersion || options.signal?.aborted) return true;
      workletNode = new WorkletNode(context, processorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      workletNode.port.onmessage = (event) => {
        if (!active || options.mic.isMuted?.() === true) return;
        const chunk = readWorkletChunk(event.data, targetSamplesPerChunk * 2);
        if (!chunk) {
          fail('web_pcm_capture_invalid_chunk');
          return;
        }
        enqueueChunk(chunk);
      };
      sourceNode?.connect(workletNode);
      workletNode.connect(context.destination);
      return true;
    } catch {
      if (version !== lifecycleVersion || options.signal?.aborted) return true;
      if (workletNode) {
        workletNode.port.onmessage = null;
        try { workletNode.disconnect(); } catch {}
        workletNode = null;
      }
      if (workletModuleUrl) {
        try { urlLike.revokeObjectURL?.(workletModuleUrl); } catch {}
        workletModuleUrl = null;
      }
      return false;
    }
  };

  const startFallback = (context: AudioContextLike): boolean => {
    if (options.fallback !== 'allow_script_processor'
      || typeof context.createScriptProcessor !== 'function') return false;
    processorNode = context.createScriptProcessor(processorBufferSize, 1, 1);
    try { options.onFallbackActivated?.('script_processor'); } catch {}
    processorNode.onaudioprocess = handleAudioProcess;
    sourceNode?.connect(processorNode);
    processorNode.connect(context.destination);
    return true;
  };

  const performStart = async (version: number): Promise<void> => {
    failed = false;
    queuedChunks = 0;
    pendingSamples = [];
    drainTail = Promise.resolve();
    if (options.signal?.aborted || version !== lifecycleVersion) return;

    if (options.signal) {
      const onAbort = (): void => { void stop(); };
      options.signal.addEventListener('abort', onAbort, { once: true });
      unlinkAbort = () => options.signal?.removeEventListener('abort', onAbort);
    }

    try {
      await options.mic.ensureActive?.();
    } catch {
      fail('web_pcm_capture_mic_acquisition_failed');
      return;
    }
    if (options.signal?.aborted || version !== lifecycleVersion) {
      cleanup();
      return;
    }
    const stream = options.mic.getStream();
    const context = options.mic.getAudioContext?.() as AudioContextLike | null | undefined;
    if (!stream || !context) {
      fail('web_pcm_capture_mic_state_unavailable');
      return;
    }
    try {
      await resumeAudioContextIfNeeded(context);
    } catch {
      fail('web_pcm_capture_resume_failed');
      return;
    }
    if (options.signal?.aborted || version !== lifecycleVersion) {
      cleanup();
      return;
    }

    attachVisibilityResume(context);
    attachDeviceLoss(stream);
    try {
      sourceNode = context.createMediaStreamSource(stream);
    } catch {
      fail('web_pcm_capture_media_source_failed');
      return;
    }
    const workletStarted = await tryStartWorklet(context, version);
    if (options.signal?.aborted || version !== lifecycleVersion) {
      cleanup();
      return;
    }
    if (!workletStarted) {
      try {
        if (!startFallback(context)) {
          fail('web_pcm_capture_unavailable');
          return;
        }
      } catch {
        fail('web_pcm_capture_unavailable');
        return;
      }
    }
    active = true;
  };

  const start = async (): Promise<void> => {
    if (stopPromise) await stopPromise;
    if (active) return;
    if (startPromise) return startPromise;
    const version = ++lifecycleVersion;
    startPromise = performStart(version).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  return Object.freeze({
    start,
    stop,
    waitForDrain: async () => { await drainTail; },
    isActive: () => active,
    level: () => latestLevel,
  });
}
