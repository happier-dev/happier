import {
  getSharedVoicePcmCapture,
  getSharedVoicePcmPlayback,
  type VoicePcmCaptureLease,
  type VoicePcmPlaybackLease,
} from '@happier-dev/audio-stream-native';
import { VOICE_PCM_CONVERSATION_AUDIO_SESSION } from '@/voice/runtime/nativePcmAudioSession';

import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import type {
  VoiceOutputFocusApplication,
  VoiceOutputFocusState,
} from '@happier-dev/plugin-sdk/voice/client';
import { decodePcm16LeBase64 } from './Pcm16LeBase64';

export { decodePcm16LeBase64, encodePcm16LeBase64 } from './Pcm16LeBase64';

type CanonicalMicPort = Readonly<{
  ensureActive?(): Promise<void>;
  isMuted?(): boolean;
  getStream(): MediaStream | null;
}>;

type NativePcmCaptureFailure =
  | 'pcm_capture_backpressure'
  | 'pcm_capture_chunk_failed'
  | 'pcm_capture_device_lost'
  | 'pcm_capture_invalid_chunk'
  | 'pcm_capture_unavailable';

const NATIVE_PCM_CAPTURE_OWNER_ID = 'voice-realtime-websocket-pcm';
const DUCK_GAIN = 0.18;

function createPcmError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function levelForPcm16Le(base64Pcm16Le: string): number {
  const samples = decodePcm16LeBase64(base64Pcm16Le);
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) {
    const normalized = sample / (sample < 0 ? 32_768 : 32_767);
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length));
}

function classifyCaptureFailure(error: unknown): NativePcmCaptureFailure {
  const message = error instanceof Error ? error.message : '';
  if (
    message === 'native_pcm_capture_dead_object'
    || message === 'native_pcm_capture_read_error'
  ) {
    return 'pcm_capture_device_lost';
  }
  return 'pcm_capture_chunk_failed';
}

async function waitForDrainOrAbort(
  playback: VoicePcmPlaybackLease,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void playback.waitForDrain().then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Native sibling of the browser PCM media owner. It consumes the package's
 * shared capture and player services, so no provider or platform leaf owns a
 * second audio session, capture stream, or player lifecycle.
 */
export function createWebSocketPcmMedia(input: Readonly<{
  mic: CanonicalMicPort;
  input: Readonly<{ sampleRate: number; chunkMs: number }>;
  output: Readonly<{
    sampleRate: number;
    maxBufferedMs: number;
    retainedOutputMaxMs?: number;
  }>;
  onInputChunk(base64Pcm16Le: string): void;
  onInputError?(code: NativePcmCaptureFailure): void;
  onOutputLevel?(level: number): void;
}>) {
  let captureLease: VoicePcmCaptureLease | null = null;
  let playbackLease: VoicePcmPlaybackLease | null = null;
  let nextStartEpoch = 0;
  let activeStartEpoch: number | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let terminalError: Error | null = null;
  let latestInputLevel = 0;
  let latestOutputLevel = 0;
  let interruptionCandidateActive = false;
  let outputFocusState: VoiceOutputFocusState = 'active';
  const terminalListeners = new Set<(error: Error) => void>();

  const publishOutputLevel = (level: number): void => {
    latestOutputLevel = outputFocusState === 'suspended'
      ? 0
      : Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    try {
      input.onOutputLevel?.(latestOutputLevel);
    } catch {
      // Meter observers do not own PCM lifecycles.
    }
  };

  const reportInputError = (code: NativePcmCaptureFailure): void => {
    try {
      input.onInputError?.(code);
    } catch {
      // The connection terminal path remains authoritative.
    }
  };

  const abortStart = (): Error => Object.assign(new Error('pcm_media_aborted'), { name: 'AbortError' });

  const releaseLeases = async (
    playback: VoicePcmPlaybackLease | null,
    capture: VoicePcmCaptureLease | null,
  ): Promise<void> => {
    try {
      await playback?.release();
    } finally {
      await capture?.release();
    }
  };

  const stopMedia = async (): Promise<void> => {
    if (stopPromise) return await stopPromise;
    stopped = true;
    nextStartEpoch += 1;
    activeStartEpoch = null;
    interruptionCandidateActive = false;
    const playback = playbackLease;
    const capture = captureLease;
    playbackLease = null;
    captureLease = null;
    if (!playback && !capture) {
      publishOutputLevel(0);
      return;
    }
    stopPromise = (async () => {
      try {
        await releaseLeases(playback, capture);
      } finally {
        publishOutputLevel(0);
      }
    })().finally(() => {
      stopPromise = null;
    });
    return await stopPromise;
  };

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

  const failCapture = (code: NativePcmCaptureFailure): void => {
    reportInputError(code);
    failTerminal(createPcmError(code));
  };

  const applyOutputGain = (): VoiceOutputFocusApplication => {
    if (terminalError) return 'unsupported';
    const playback = playbackLease;
    // Retain the native-owner focus fact before the output lease exists. The
    // exact same state is applied immediately after a late lease opens.
    if (!playback) return 'applied';
    const gain = outputFocusState === 'suspended'
      ? 0
      : outputFocusState === 'ducked' || interruptionCandidateActive
        ? DUCK_GAIN
        : 1;
    return playback.setGain(gain) ? 'applied' : 'unsupported';
  };

  const pcm = Object.freeze({
    async start(signal: AbortSignal): Promise<void> {
      if (stopPromise) await stopPromise;
      if (captureLease || playbackLease || activeStartEpoch !== null) throw new Error('pcm_media_already_started');
      if (signal.aborted) throw abortStart();
      const capture = getSharedVoicePcmCapture();
      const playback = getSharedVoicePcmPlayback();
      if (!capture || !playback) {
        const error = createPcmError('pcm_capture_unavailable');
        reportInputError('pcm_capture_unavailable');
        throw error;
      }
      const startEpoch = ++nextStartEpoch;
      activeStartEpoch = startEpoch;
      stopped = false;
      terminalError = null;
      latestInputLevel = 0;
      interruptionCandidateActive = false;
      let acquiredCapture: VoicePcmCaptureLease | null = null;
      let acquiredPlayback: VoicePcmPlaybackLease | null = null;
      const ensureCurrentStart = (): void => {
        if (terminalError) throw terminalError;
        if (
          activeStartEpoch !== startEpoch
          || stopped
          || signal.aborted
        ) {
          throw abortStart();
        }
      };
      try {
        acquiredCapture = await capture.acquire({
          ownerId: NATIVE_PCM_CAPTURE_OWNER_ID,
          format: { sampleRate: input.input.sampleRate, channels: 1, frameMs: input.input.chunkMs },
          audioSession: VOICE_PCM_CONVERSATION_AUDIO_SESSION,
          shouldDeliver: () => !stopped && input.mic.isMuted?.() !== true,
          onFrame: (frame) => {
            if (stopped) return;
            try {
              latestInputLevel = levelForPcm16Le(frame.pcm16leBase64);
              input.onInputChunk(frame.pcm16leBase64);
            } catch {
              failCapture('pcm_capture_invalid_chunk');
            }
          },
          onError: (error) => failCapture(classifyCaptureFailure(error)),
        });
        ensureCurrentStart();
        captureLease = acquiredCapture;
        acquiredCapture = null;
        acquiredPlayback = await playback.open({
          capture: {
            streamId: captureLease.streamId,
            generation: captureLease.generation,
          },
          format: {
            sampleRate: input.output.sampleRate,
            channels: 1,
            maxBufferedMs: input.output.maxBufferedMs,
          },
          onOutputLevel: publishOutputLevel,
          onError: failTerminal,
        });
        ensureCurrentStart();
        playbackLease = acquiredPlayback;
        acquiredPlayback = null;
        if (applyOutputGain() === 'unsupported') {
          throw createPcmError('pcm_output_focus_unsupported');
        }
      } catch (error) {
        await releaseLeases(acquiredPlayback, acquiredCapture);
        if (activeStartEpoch === startEpoch) await stopMedia();
        throw error;
      } finally {
        if (activeStartEpoch === startEpoch) activeStartEpoch = null;
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
    playbackCursorMs: (): number => playbackLease?.playbackCursorMs() ?? 0,
    setOutputFocusState(state: VoiceOutputFocusState): VoiceOutputFocusApplication {
      outputFocusState = state;
      return applyOutputGain();
    },
    beginOutputInterruptionCandidate: (): VoicePlaybackInterruptionMode => {
      const playback = playbackLease;
      if (!playback || terminalError) return 'unsupported';
      if (interruptionCandidateActive) return 'ducked';
      interruptionCandidateActive = true;
      if (applyOutputGain() === 'unsupported') {
        interruptionCandidateActive = false;
        return 'unsupported';
      }
      return 'ducked';
    },
    resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void {
      const playback = playbackLease;
      if (!playback || !interruptionCandidateActive) return;
      interruptionCandidateActive = false;
      if (resolution === 'confirmed') {
        playback.clear();
        publishOutputLevel(0);
        return;
      }
      applyOutputGain();
    },
  });

  return Object.freeze({
    pcm,
    enqueueOutput(base64Pcm16Le: string): boolean {
      if (terminalError || !playbackLease) return false;
      return playbackLease.enqueue(base64Pcm16Le);
    },
    clearOutput(): void {
      interruptionCandidateActive = false;
      playbackLease?.clear();
      applyOutputGain();
      publishOutputLevel(0);
    },
    beginOutputInterruptionCandidate: pcm.beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate: pcm.resolveOutputInterruptionCandidate,
    async waitForOutputDrain(signal: AbortSignal): Promise<void> {
      const playback = playbackLease;
      if (!playback) return;
      await waitForDrainOrAbort(playback, signal);
    },
    playbackCursorMs: () => playbackLease?.playbackCursorMs() ?? 0,
    inputLevel: () => latestInputLevel,
    outputLevel: () => latestOutputLevel,
  });
}
