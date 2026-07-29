import {
  createWebPcmCapture,
  type WebPcmCapture,
  type WebPcmCaptureError,
} from '@/voice/runtime/input/WebPcmCapture.web';
import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

type CanonicalMicPort = Readonly<{
  ensureActive?(): Promise<void>;
  isMuted?(): boolean;
  getStream(): MediaStream | null;
  getAudioContext?(): AudioContext | null;
}>;

type OutputScheduler = Readonly<{
  enqueue(samples: Int16Array): boolean;
  beginCandidate(): VoicePlaybackInterruptionMode;
  resolveCandidate(resolution: VoicePlaybackInterruptionResolution): void;
  clear(): void;
  stop(): void;
  waitForDrain(signal: AbortSignal): Promise<void>;
  playbackCursorMs(): number;
  outputLevel(): number;
}>;

type CreateOutputScheduler = (input: Readonly<{
  context: AudioContext;
  sampleRate: number;
  maxBufferedMs: number;
  retainedOutputMaxMs?: number;
}>) => OutputScheduler;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBytesBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const combined = (a << 16) | (b << 8) | c;
    output += BASE64[(combined >>> 18) & 63];
    output += BASE64[(combined >>> 12) & 63];
    output += index + 1 < bytes.length ? BASE64[(combined >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64[combined & 63] : '=';
  }
  return output;
}

function decodeBytesBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw Object.assign(new Error('invalid_pcm_base64'), { code: 'invalid_pcm_base64' });
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const values = [0, 1, 2, 3].map((delta) => {
      const character = normalized[index + delta]!;
      return character === '=' ? 0 : BASE64.indexOf(character);
    });
    if (values.some((entry) => entry < 0)) throw Object.assign(new Error('invalid_pcm_base64'), { code: 'invalid_pcm_base64' });
    const combined = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (offset < bytes.length) bytes[offset++] = (combined >>> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (combined >>> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = combined & 255;
  }
  return bytes;
}

export function encodePcm16LeBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index]!, true);
  return encodeBytesBase64(bytes);
}

export function decodePcm16LeBase64(value: string): Int16Array {
  const bytes = decodeBytesBase64(value);
  if (bytes.byteLength % 2 !== 0) throw Object.assign(new Error('invalid_pcm16_length'), { code: 'invalid_pcm16_length' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
  return samples;
}

function createDefaultOutputScheduler(input: Parameters<CreateOutputScheduler>[0]): OutputScheduler {
  type ScheduledSource = Readonly<{
    source: AudioBufferSourceNode;
    samples: Int16Array;
    startAt: number;
  }>;
  const sources = new Set<ScheduledSource>();
  const retained: Int16Array[] = [];
  const maxRetainedSamples = Math.max(1, Math.floor(
    input.sampleRate * Math.min(
      input.maxBufferedMs,
      input.retainedOutputMaxMs
        ?? VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.retainedOutputMaxMs,
    ) / 1_000,
  ));
  let retainedSamples = 0;
  let nextStart = input.context.currentTime;
  let playedSeconds = 0;
  let level = 0;
  let stopped = false;
  let candidateActive = false;
  const gainNode = typeof input.context.createGain === 'function' ? input.context.createGain() : null;
  if (gainNode) gainNode.connect(input.context.destination);
  const setGain = (value: number): void => {
    if (!gainNode) return;
    const normalized = Math.max(0, Math.min(1, value));
    if (typeof gainNode.gain.setTargetAtTime === 'function') {
      gainNode.gain.setTargetAtTime(normalized, input.context.currentTime, 0.015);
    } else {
      gainNode.gain.value = normalized;
    }
  };
  const drainWaiters = new Set<() => void>();
  const settleDrain = () => {
    if (sources.size > 0 || retainedSamples > 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const appendRetained = (samples: Int16Array, allowPartial: boolean): boolean => {
    const available = Math.max(0, maxRetainedSamples - retainedSamples);
    if (samples.length > available && !allowPartial) return false;
    const accepted = Math.min(samples.length, available);
    if (accepted > 0) {
      retained.push(samples.slice(0, accepted));
      retainedSamples += accepted;
    }
    return accepted === samples.length;
  };
  const stopScheduled = (retainTail: boolean): void => {
    const now = input.context.currentTime;
    const ordered = [...sources].sort((left, right) => left.startAt - right.startAt);
    for (const scheduled of ordered) {
      const elapsedSamples = Math.max(0, Math.min(
        scheduled.samples.length,
        Math.floor((now - scheduled.startAt) * input.sampleRate),
      ));
      playedSeconds += elapsedSamples / input.sampleRate;
      if (retainTail && elapsedSamples < scheduled.samples.length) {
        appendRetained(scheduled.samples.subarray(elapsedSamples), true);
      }
      scheduled.source.onended = null;
      try { scheduled.source.stop(); } catch {}
      try { scheduled.source.disconnect(); } catch {}
    }
    sources.clear();
    nextStart = now;
    level = 0;
  };
  const clearRetained = (): void => {
    retained.length = 0;
    retainedSamples = 0;
  };
  const clear = (): void => {
    stopScheduled(false);
    clearRetained();
    candidateActive = false;
    setGain(1);
    settleDrain();
  };
  const schedule = (samples: Int16Array): boolean => {
    if (stopped || samples.length === 0) return false;
    const duration = samples.length / input.sampleRate;
    const bufferedMs = Math.max(0, nextStart - input.context.currentTime) * 1_000;
    if (bufferedMs + duration * 1_000 > input.maxBufferedMs) return false;
    const buffer = input.context.createBuffer(1, samples.length, input.sampleRate);
    const channel = buffer.getChannelData(0);
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]! / (samples[index]! < 0 ? 32768 : 32767);
      channel[index] = sample;
      sum += sample * sample;
    }
    level = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)));
    const source = input.context.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode ?? input.context.destination);
    const startAt = Math.max(input.context.currentTime, nextStart);
    nextStart = startAt + duration;
    const scheduled: ScheduledSource = { source, samples: samples.slice(), startAt };
    sources.add(scheduled);
    source.onended = () => {
      if (!sources.delete(scheduled)) return;
      playedSeconds += duration;
      if (sources.size === 0) level = 0;
      try { source.disconnect(); } catch {}
      settleDrain();
    };
    source.start(startAt);
    return true;
  };
  return Object.freeze({
    enqueue(samples: Int16Array): boolean {
      if (candidateActive) return appendRetained(samples, false);
      return schedule(samples);
    },
    beginCandidate(): VoicePlaybackInterruptionMode {
      if (stopped) return 'unsupported';
      if (candidateActive) return 'retained';
      candidateActive = true;
      stopScheduled(true);
      settleDrain();
      return 'retained';
    },
    resolveCandidate(resolution): void {
      if (!candidateActive) return;
      candidateActive = false;
      if (resolution === 'confirmed') {
        clear();
        return;
      }
      const pending = retained.splice(0);
      retainedSamples = 0;
      setGain(1);
      for (const samples of pending) schedule(samples);
      settleDrain();
    },
    clear,
    stop() {
      if (stopped) return;
      stopped = true;
      clear();
      try { gainNode?.disconnect(); } catch {}
    },
    async waitForDrain(signal: AbortSignal): Promise<void> {
      if (sources.size === 0 && retainedSamples === 0) return;
      await new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener('abort', aborted); drainWaiters.delete(done); resolve(); };
        const aborted = () => done();
        drainWaiters.add(done);
        signal.addEventListener('abort', aborted, { once: true });
      });
    },
    playbackCursorMs: () => {
      const now = input.context.currentTime;
      let activeSeconds = 0;
      for (const scheduled of sources) {
        activeSeconds += Math.max(0, Math.min(
          scheduled.samples.length / input.sampleRate,
          now - scheduled.startAt,
        ));
      }
      return Math.round((playedSeconds + activeSeconds) * 1_000);
    },
    outputLevel: () => candidateActive ? 0 : level,
  });
}

export function createWebSocketPcmMedia(input: Readonly<{
  mic: CanonicalMicPort;
  input: Readonly<{ sampleRate: number; chunkMs: number }>;
  output: Readonly<{
    sampleRate: number;
    maxBufferedMs: number;
    retainedOutputMaxMs?: number;
  }>;
  onInputChunk(base64Pcm16Le: string): void;
  onInputError?(error: WebPcmCaptureError): void;
  onOutputLevel?(level: number): void;
  createCapture?: typeof createWebPcmCapture;
  createOutputScheduler?: CreateOutputScheduler;
}>) {
  const createCapture = input.createCapture ?? createWebPcmCapture;
  const createOutputScheduler = input.createOutputScheduler ?? createDefaultOutputScheduler;
  let capture: WebPcmCapture | null = null;
  let playback: OutputScheduler | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let latestInputLevel = 0;
  const publishOutputLevel = (level: number): void => {
    try {
      input.onOutputLevel?.(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)));
    } catch {
      // Meter observers are diagnostics/UI only and cannot retain media.
    }
  };

  const stopMedia = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    if (stopped) return;
    stopped = true;
    const currentCapture = capture;
    const currentPlayback = playback;
    capture = null;
    playback = null;
    latestInputLevel = 0;
    stopPromise = (async () => {
      await currentCapture?.stop();
      currentPlayback?.stop();
      publishOutputLevel(0);
    })().finally(() => {
      stopPromise = null;
    });
    await stopPromise;
  };

  const pcm = Object.freeze({
    async start(signal: AbortSignal): Promise<void> {
      if (stopPromise) await stopPromise;
      if (capture || playback) throw new Error('pcm_media_already_started');
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const context = input.mic.getAudioContext?.() ?? null;
      if (!context) throw Object.assign(new Error('pcm_media_unavailable'), { code: 'pcm_media_unavailable' });
      stopped = false;
      playback = createOutputScheduler({ context, ...input.output });
      capture = createCapture({
        mic: {
          ensureActive: input.mic.ensureActive ?? (async () => {}),
          isMuted: input.mic.isMuted ?? (() => false),
          getStream: input.mic.getStream,
          getAudioContext: input.mic.getAudioContext,
        },
        format: { sampleRate: input.input.sampleRate, channels: 1, encoding: 'pcm16le' },
        chunkMs: input.input.chunkMs,
        fallback: 'allow_script_processor',
        signal,
        onError(error) {
          try {
            input.onInputError?.(error);
          } catch {
            // Diagnostic observers must not retain capture or playback resources.
          } finally {
            void stopMedia();
          }
        },
        onChunk({ bytes, level }) {
          if (stopped) return;
          latestInputLevel = Math.max(0, Math.min(1, level));
          input.onInputChunk(encodeBytesBase64(bytes));
        },
      });
      try {
        await capture.start();
        if (!capture.isActive()) {
          throw Object.assign(new Error('pcm_media_unavailable'), { code: 'pcm_media_unavailable' });
        }
      } catch (error) {
        await stopMedia();
        throw error;
      }
    },
    async stop(): Promise<void> {
      await stopMedia();
    },
    playbackCursorMs: (): number => playback?.playbackCursorMs() ?? 0,
  });

  return Object.freeze({
    pcm,
    enqueueOutput(base64Pcm16Le: string): boolean {
      const samples = decodePcm16LeBase64(base64Pcm16Le);
      if (!playback) return false;
      const accepted = playback.enqueue(samples);
      if (accepted) publishOutputLevel(playback.outputLevel());
      return accepted;
    },
    clearOutput() {
      playback?.clear();
      publishOutputLevel(0);
    },
    beginOutputInterruptionCandidate: (): VoicePlaybackInterruptionMode => {
      const mode = playback?.beginCandidate() ?? 'unsupported';
      publishOutputLevel(playback?.outputLevel() ?? 0);
      return mode;
    },
    resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void {
      playback?.resolveCandidate(resolution);
      publishOutputLevel(playback?.outputLevel() ?? 0);
    },
    async waitForOutputDrain(signal: AbortSignal) { await playback?.waitForDrain(signal); },
    playbackCursorMs: () => playback?.playbackCursorMs() ?? 0,
    inputLevel: () => capture?.level() ?? latestInputLevel,
    outputLevel: () => playback?.outputLevel() ?? 0,
  });
}
