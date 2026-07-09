import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

type AudioProcessEventLike = Readonly<{
  inputBuffer: Readonly<{
    sampleRate: number;
    numberOfChannels: number;
    getChannelData: (channel: number) => Float32Array;
  }>;
  outputBuffer?: Readonly<{
    numberOfChannels: number;
    getChannelData: (channel: number) => Float32Array;
  }>;
}>;

type ScriptProcessorNodeLike = Readonly<{
  connect: (destination: unknown) => void;
  disconnect: () => void;
}> & {
  onaudioprocess: ((event: AudioProcessEventLike) => void) | null;
};

type AudioWorkletPortLike = {
  close?: () => void;
  onmessage: ((event: Readonly<{ data: unknown }>) => void) | null;
};

type AudioWorkletNodeLike = Readonly<{
  connect: (destination: unknown) => void;
  disconnect: () => void;
  port: AudioWorkletPortLike;
}>;

type AudioWorkletNodeConstructorLike = new (
  context: unknown,
  name: string,
  options?: AudioWorkletNodeOptions,
) => AudioWorkletNodeLike;

type MediaStreamAudioSourceNodeLike = Readonly<{
  connect: (destination: unknown) => void;
  disconnect: () => void;
}>;

type AudioContextLike = Readonly<{
  destination: unknown;
  sampleRate: number;
  state?: AudioContextState | string;
  resume?: () => Promise<void>;
  audioWorklet?: Readonly<{
    addModule: (moduleUrl: string) => Promise<void>;
  }>;
  createMediaStreamSource: (stream: MediaStream) => MediaStreamAudioSourceNodeLike;
  createScriptProcessor: (bufferSize: number, inputChannels: number, outputChannels: number) => ScriptProcessorNodeLike;
}>;

type DocumentLike = Readonly<{
  visibilityState?: string;
  addEventListener?: (eventName: 'visibilitychange', listener: () => void) => void;
  removeEventListener?: (eventName: 'visibilitychange', listener: () => void) => void;
}>;

type UrlLike = Readonly<{
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}>;

export type WebDaemonSpeechPcmCaptureOptions = Readonly<{
  micSession: MicSession;
  onAudioStarted: () => void;
  onChunk: (pcm16Bytes: Uint8Array) => Promise<void>;
  onError?: (error: ReturnType<typeof createVoiceMachineError>) => void;
  signal?: AbortSignal | null;
  processorBufferSize?: number;
  maxQueuedChunks?: number;
}>;

export type WebDaemonSpeechPcmCapture = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
  waitForDrain: () => Promise<void>;
  isActive: () => boolean;
}>;

const DEFAULT_PROCESSOR_BUFFER_SIZE = 4096;
const DEFAULT_MAX_QUEUED_CHUNKS = 8;
const TARGET_SAMPLE_RATE = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz;
const AUDIO_WORKLET_PROCESSOR_NAME = 'happier-daemon-speech-pcm-capture';
const AUDIO_WORKLET_SOURCE = `
class HappierDaemonSpeechPcmCaptureProcessor extends AudioWorkletProcessor {
  mixToMono(input) {
    const channelCount = Math.max(1, input.length);
    const firstChannel = input[0];
    const frameCount = firstChannel ? firstChannel.length : 0;
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = input[channel] || firstChannel;
      for (let index = 0; index < frameCount; index += 1) {
        const value = channelData ? channelData[index] : 0;
        mono[index] += (typeof value === 'number' ? value : 0) / channelCount;
      }
    }
    return mono;
  }

  resampleLinear(samples) {
    const sourceSampleRate = sampleRate;
    const targetSampleRate = ${TARGET_SAMPLE_RATE};
    if (sourceSampleRate === targetSampleRate) {
      return samples;
    }
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || samples.length === 0) {
      return new Float32Array();
    }
    const outputLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceSampleRate / targetSampleRate;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const leftIndex = Math.min(samples.length - 1, Math.floor(position));
      const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
      const fraction = position - leftIndex;
      const leftValue = samples[leftIndex];
      const left = typeof leftValue === 'number' ? leftValue : 0;
      const rightValue = samples[rightIndex];
      const right = typeof rightValue === 'number' ? rightValue : left;
      output[index] = left + (right - left) * fraction;
    }
    return output;
  }

  floatToInt16(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }

  encodePcm16Bytes(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index];
      view.setInt16(index * 2, this.floatToInt16(typeof value === 'number' ? value : 0), true);
    }
    return bytes;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (const channel of output) {
        channel.fill(0);
      }
    }
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }
    const pcm16Bytes = this.encodePcm16Bytes(this.resampleLinear(this.mixToMono(input)));
    if (pcm16Bytes.byteLength > 0) {
      this.port.postMessage({ type: 'pcm16', pcm16Bytes: pcm16Bytes.buffer }, [pcm16Bytes.buffer]);
    }
    return true;
  }
}

registerProcessor('${AUDIO_WORKLET_PROCESSOR_NAME}', HappierDaemonSpeechPcmCaptureProcessor);
`;

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function zeroOutputBuffer(event: AudioProcessEventLike): void {
  const output = event.outputBuffer;
  if (!output) {
    return;
  }
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

function resampleLinear(samples: Float32Array, sourceSampleRate: number): Float32Array {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    return samples;
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || samples.length === 0) {
    return new Float32Array();
  }
  const outputLength = Math.max(1, Math.round(samples.length * TARGET_SAMPLE_RATE / sourceSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.min(samples.length - 1, Math.floor(position));
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = position - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    output[index] = left + (right - left) * fraction;
  }
  return output;
}

function floatToInt16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0
    ? Math.round(clamped * 32768)
    : Math.round(clamped * 32767);
}

function encodePcm16Bytes(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, floatToInt16(samples[index] ?? 0), true);
  }
  return bytes;
}

function isAudioContextSuspended(audioContext: AudioContextLike): boolean {
  const state = String(audioContext.state ?? '');
  return state === 'suspended' || state === 'interrupted';
}

async function resumeAudioContextIfNeeded(audioContext: AudioContextLike): Promise<void> {
  if (!isAudioContextSuspended(audioContext) || typeof audioContext.resume !== 'function') {
    return;
  }
  await audioContext.resume().catch(() => {});
}

function getDocumentLike(): DocumentLike | null {
  const documentLike = (globalThis as typeof globalThis & { document?: DocumentLike }).document;
  return documentLike ?? null;
}

function getUrlLike(): UrlLike | null {
  const urlLike = (globalThis as typeof globalThis & { URL?: UrlLike }).URL;
  return urlLike ?? null;
}

function getAudioWorkletNodeConstructor(): AudioWorkletNodeConstructorLike | null {
  const constructor = (globalThis as typeof globalThis & {
    AudioWorkletNode?: AudioWorkletNodeConstructorLike;
  }).AudioWorkletNode;
  return typeof constructor === 'function' ? constructor : null;
}

function createAudioWorkletModuleUrl(): string | null {
  const urlLike = getUrlLike();
  if (typeof Blob !== 'function' || typeof urlLike?.createObjectURL !== 'function') {
    return null;
  }
  return urlLike.createObjectURL(new Blob([AUDIO_WORKLET_SOURCE], { type: 'application/javascript' }));
}

function revokeAudioWorkletModuleUrl(moduleUrl: string | null): void {
  if (!moduleUrl) {
    return;
  }
  try {
    getUrlLike()?.revokeObjectURL?.(moduleUrl);
  } catch {
    // Best-effort blob URL cleanup.
  }
}

function readPcm16BytesFromWorkletMessage(data: unknown): Uint8Array | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const payload = data as Readonly<{ type?: unknown; pcm16Bytes?: unknown }>;
  if (payload.type !== 'pcm16') {
    return null;
  }
  const value = payload.pcm16Bytes;
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export function createWebDaemonSpeechPcmCapture(
  options: WebDaemonSpeechPcmCaptureOptions,
): WebDaemonSpeechPcmCapture {
  const processorBufferSize = normalizePositiveInteger(options.processorBufferSize, DEFAULT_PROCESSOR_BUFFER_SIZE);
  const maxQueuedChunks = normalizePositiveInteger(options.maxQueuedChunks, DEFAULT_MAX_QUEUED_CHUNKS);
  let active = false;
  let sourceNode: MediaStreamAudioSourceNodeLike | null = null;
  let processorNode: ScriptProcessorNodeLike | null = null;
  let workletNode: AudioWorkletNodeLike | null = null;
  let workletModuleUrl: string | null = null;
  let audioStarted = false;
  let queuedChunks = 0;
  let drainTail: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let unlinkAbort = (): void => {};
  let unlinkVisibilityResume = (): void => {};

  const reportError = (reason: string): void => {
    options.onError?.(createVoiceMachineError({ kind: 'provider_error', reason }));
  };

  const cleanupNodes = (): void => {
    active = false;
    unlinkAbort();
    unlinkAbort = (): void => {};
    unlinkVisibilityResume();
    unlinkVisibilityResume = (): void => {};
    if (workletNode) {
      workletNode.port.onmessage = null;
      try {
        workletNode.port.close?.();
      } catch {
        // ignore
      }
      try {
        workletNode.disconnect();
      } catch {
        // ignore
      }
      workletNode = null;
    }
    revokeAudioWorkletModuleUrl(workletModuleUrl);
    workletModuleUrl = null;
    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {
        // ignore
      }
      processorNode = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // ignore
      }
      sourceNode = null;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      cleanupNodes();
      await drainTail.catch(() => {});
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const enqueueChunk = (pcm16Bytes: Uint8Array): void => {
    if (!active) {
      return;
    }
    if (queuedChunks >= maxQueuedChunks) {
      reportError('daemon_streaming_stt_pcm_backpressure');
      void stop();
      return;
    }
    queuedChunks += 1;
    drainTail = drainTail
      .catch(() => undefined)
      .then(async () => {
        await options.onChunk(pcm16Bytes);
      })
      .catch(() => {
        reportError('daemon_streaming_stt_pcm_chunk_failed');
        void stop();
      })
      .finally(() => {
        queuedChunks = Math.max(0, queuedChunks - 1);
      });
  };

  const handleAudioProcess = (event: AudioProcessEventLike): void => {
    zeroOutputBuffer(event);
    if (!active) {
      return;
    }
    if (options.micSession.isMuted()) {
      return;
    }
    if (!audioStarted) {
      audioStarted = true;
      options.onAudioStarted();
    }
    const mono = mixToMono(event.inputBuffer);
    const resampled = resampleLinear(mono, event.inputBuffer.sampleRate);
    if (resampled.length === 0) {
      return;
    }
    enqueueChunk(encodePcm16Bytes(resampled));
  };

  const handleWorkletMessage = (event: Readonly<{ data: unknown }>): void => {
    if (!active || options.micSession.isMuted()) {
      return;
    }
    const pcm16Bytes = readPcm16BytesFromWorkletMessage(event.data);
    if (!pcm16Bytes || pcm16Bytes.byteLength === 0) {
      return;
    }
    if (!audioStarted) {
      audioStarted = true;
      options.onAudioStarted();
    }
    enqueueChunk(pcm16Bytes);
  };

  const attachVisibilityResume = (audioContext: AudioContextLike): void => {
    const documentLike = getDocumentLike();
    if (
      typeof documentLike?.addEventListener !== 'function' ||
      typeof documentLike.removeEventListener !== 'function'
    ) {
      return;
    }
    const handleVisibilityChange = (): void => {
      if (active && documentLike.visibilityState === 'visible') {
        void resumeAudioContextIfNeeded(audioContext);
      }
    };
    documentLike.addEventListener('visibilitychange', handleVisibilityChange);
    unlinkVisibilityResume = () => {
      documentLike.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };
  };

  const tryStartAudioWorklet = async (audioContext: AudioContextLike): Promise<boolean> => {
    const addModule = audioContext.audioWorklet?.addModule;
    const AudioWorkletNodeConstructor = getAudioWorkletNodeConstructor();
    if (typeof addModule !== 'function' || !AudioWorkletNodeConstructor) {
      return false;
    }
    const moduleUrl = createAudioWorkletModuleUrl();
    if (!moduleUrl) {
      return false;
    }
    workletModuleUrl = moduleUrl;
    try {
      await addModule(moduleUrl);
      if (options.signal?.aborted) {
        return true;
      }
      workletNode = new AudioWorkletNodeConstructor(audioContext, AUDIO_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      workletNode.port.onmessage = handleWorkletMessage;
      sourceNode?.connect(workletNode);
      workletNode.connect(audioContext.destination);
      return true;
    } catch {
      if (workletNode) {
        workletNode.port.onmessage = null;
        try {
          workletNode.disconnect();
        } catch {
          // ignore
        }
        workletNode = null;
      }
      revokeAudioWorkletModuleUrl(workletModuleUrl);
      workletModuleUrl = null;
      return false;
    }
  };

  const startFallbackProcessor = (audioContext: AudioContextLike): boolean => {
    if (typeof audioContext.createScriptProcessor !== 'function') {
      return false;
    }
    processorNode = audioContext.createScriptProcessor(processorBufferSize, 1, 1);
    processorNode.onaudioprocess = handleAudioProcess;
    sourceNode?.connect(processorNode);
    processorNode.connect(audioContext.destination);
    return true;
  };

  const start = async (): Promise<void> => {
    if (active) {
      return;
    }
    if (options.signal?.aborted) {
      return;
    }
    await options.micSession.ensureActive();
    const stream = options.micSession.getStream();
    const audioContext = options.micSession.getAudioContext?.() as AudioContextLike | null | undefined;
    if (!stream || !audioContext) {
      reportError('daemon_streaming_stt_web_mic_unavailable');
      return;
    }
    await resumeAudioContextIfNeeded(audioContext);
    if (options.signal?.aborted) {
      return;
    }
    attachVisibilityResume(audioContext);
    sourceNode = audioContext.createMediaStreamSource(stream);
    const startedAudioWorklet = await tryStartAudioWorklet(audioContext);
    if (options.signal?.aborted) {
      await stop();
      return;
    }
    if (!startedAudioWorklet && !startFallbackProcessor(audioContext)) {
      cleanupNodes();
      reportError('daemon_streaming_stt_pcm_capture_unavailable');
      return;
    }
    active = true;
    if (options.signal) {
      const abort = () => {
        void stop();
      };
      options.signal.addEventListener('abort', abort, { once: true });
      unlinkAbort = () => {
        options.signal?.removeEventListener('abort', abort);
      };
    }
  };

  return {
    start,
    stop,
    waitForDrain: async () => {
      await drainTail;
    },
    isActive: () => active,
  };
}
