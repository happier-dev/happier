import {
  createWebPcmCapture,
  type WebPcmCapture,
  type WebPcmCaptureError,
} from '@/voice/runtime/input/WebPcmCapture.web';
import {
  decodePcm16LeBase64,
  encodePcm16LeBase64,
} from './Pcm16LeBase64';
import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import type {
  VoiceOutputFocusApplication,
  VoiceOutputFocusState,
} from '@happier-dev/plugin-sdk/voice/client';
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
  setOutputFocusState(state: VoiceOutputFocusState): VoiceOutputFocusApplication;
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

export { decodePcm16LeBase64, encodePcm16LeBase64 } from './Pcm16LeBase64';

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
  let outputFocusState: VoiceOutputFocusState = 'active';
  const gainNode = typeof input.context.createGain === 'function' ? input.context.createGain() : null;
  if (gainNode) gainNode.connect(input.context.destination);
  const setGain = (value: number): boolean => {
    if (!gainNode) return false;
    const normalized = Math.max(0, Math.min(1, value));
    if (typeof gainNode.gain.setTargetAtTime === 'function') {
      gainNode.gain.setTargetAtTime(normalized, input.context.currentTime, 0.015);
    } else {
      gainNode.gain.value = normalized;
    }
    return true;
  };
  const applyOutputFocus = (): VoiceOutputFocusApplication => {
    if (!gainNode) return outputFocusState === 'active' ? 'applied' : 'unsupported';
    const gain = outputFocusState === 'suspended'
      ? 0
      : outputFocusState === 'ducked'
        ? VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.duckGain
        : 1;
    return setGain(gain) ? 'applied' : 'unsupported';
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
    applyOutputFocus();
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
      applyOutputFocus();
      for (const samples of pending) schedule(samples);
      settleDrain();
    },
    setOutputFocusState(state: VoiceOutputFocusState): VoiceOutputFocusApplication {
      outputFocusState = state;
      return applyOutputFocus();
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
    outputLevel: () => candidateActive || outputFocusState === 'suspended' ? 0 : level,
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
  let terminalError: Error | null = null;
  let outputFocusState: VoiceOutputFocusState = 'active';
  const terminalListeners = new Set<(error: Error) => void>();
  const publishOutputLevel = (level: number): void => {
    try {
      input.onOutputLevel?.(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)));
    } catch {
      // Meter observers are diagnostics/UI only and cannot retain media.
    }
  };

  /**
   * The browser sibling of the native PCM terminal contract. A capture fault
   * stops both media halves, so the connection must learn the session is dead:
   * without this the transport stays nominally open while the microphone and
   * the assistant's voice are both gone. The failure is latched so a subscriber
   * attached after the fault is told immediately rather than waiting forever.
   */
  const failTerminal = (error: Error): void => {
    if (terminalError || stopped) return;
    terminalError = error;
    for (const listener of terminalListeners) {
      try {
        listener(error);
      } catch {
        // One observer cannot prevent connection teardown or other observers.
      }
    }
    void stopMedia();
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
      // Playback is released before capture shutdown is awaited (the same order the
      // native transport uses): a capture stop that rejects or never settles must
      // not leave the assistant still audible after Stop.
      currentPlayback?.stop();
      publishOutputLevel(0);
      await currentCapture?.stop();
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
      terminalError = null;
      playback = createOutputScheduler({ context, ...input.output });
      if (playback.setOutputFocusState(outputFocusState) === 'unsupported') {
        throw Object.assign(new Error('pcm_output_focus_unsupported'), {
          code: 'pcm_output_focus_unsupported',
        });
      }
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
            failTerminal(Object.assign(new Error(error), { code: error }));
          }
        },
        onChunk({ bytes, level }) {
          if (stopped) return;
          latestInputLevel = Math.max(0, Math.min(1, level));
          input.onInputChunk(encodePcm16LeBase64(new Int16Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / 2,
          )));
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
    subscribeTerminal(listener: (error: Error) => void): Readonly<{ remove: () => void }> {
      terminalListeners.add(listener);
      if (terminalError) listener(terminalError);
      return Object.freeze({ remove: () => terminalListeners.delete(listener) });
    },
    playbackCursorMs: (): number => playback?.playbackCursorMs() ?? 0,
    setOutputFocusState(state: VoiceOutputFocusState): VoiceOutputFocusApplication {
      outputFocusState = state;
      if (terminalError) return 'unsupported';
      return playback?.setOutputFocusState(state) ?? 'applied';
    },
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
