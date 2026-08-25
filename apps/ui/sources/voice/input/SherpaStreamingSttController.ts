import { uriToFilePath } from '@/platform/fileUri';
import { randomUUID } from '@/platform/randomUUID';
import {
  getSharedVoicePcmCapture,
  type AudioStreamFrameEvent,
  type VoicePcmCapture,
  type VoicePcmCaptureLease,
} from '@happier-dev/audio-stream-native';
import {
  getOptionalHappierSherpaNativeModule,
  type SherpaNativeModule,
} from '@happier-dev/sherpa-native';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import {
  createTurnEndpointController,
  type TurnEndpointController,
  type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { VOICE_PCM_CONVERSATION_AUDIO_SESSION } from '@/voice/runtime/nativePcmAudioSession';
import { VOICE_RUNTIME_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { resolveLocalNeuralSttCaptureSettings } from './resolveLocalNeuralSttCaptureSettings';
import type { SttController, SttStartParams, SttStopResult } from './sttController';

type SherpaStreamingNativeModule = Pick<
  SherpaNativeModule,
  'createStreamingRecognizer' | 'pushAudioFrame' | 'finishStreaming' | 'cancel'
>;

type SherpaSttHandle = {
  sessionId: string;
  jobId: string;
  capture: VoicePcmCapture;
  captureLease: VoicePcmCaptureLease;
  transcript: string;
  abortController: AbortController;
  pushTail: Promise<void>;
  audioStarted: boolean;
  abortCleanup: () => void;
};

export type SherpaStreamingSttController = SttController;

export type CreateSherpaStreamingSttControllerDeps = {
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  endpointController?: TurnEndpointController;
};

function getOptionalSherpaNativeModule(): SherpaStreamingNativeModule | null {
  return getOptionalHappierSherpaNativeModule();
}

export function createSherpaStreamingSttController(deps: CreateSherpaStreamingSttControllerDeps): SherpaStreamingSttController {
  let handle: SherpaSttHandle | null = null;
  let clearHandleAttempt: Promise<void> | null = null;
  let stopping: Promise<SttStopResult> | null = null;
  const MAX_QUEUED_FRAMES = 8;
  const endpointController = deps.endpointController ?? createTurnEndpointController({
    onSignal: (signal) => deps.onEndpointSignal?.(signal),
  });

  const clearHandle = async (expected?: SherpaSttHandle): Promise<void> => {
    if (stopping) {
      await stopping;
      return;
    }
    if (clearHandleAttempt) {
      await clearHandleAttempt;
      return;
    }
    const current = handle;
    if (!current || (expected && current !== expected)) return;
    handle = null;
    const attempt = (async () => {
      endpointController.clearSession(current.sessionId);
      current.abortController.abort();
      current.abortCleanup();
      // Signal the native cancel before waiting on the capture drain and the
      // push tail, not after: the frame already inside the recognizer decodes for
      // as long as it takes, and awaiting the tail first means the mark only
      // lands once the work it was meant to stop has finished. Native cancel is a
      // registry mark that runs while a decode is in flight, so this is what makes
      // the awaits below return promptly instead of what delays them.
      const sherpa = getOptionalSherpaNativeModule();
      const cancelled = sherpa?.cancel({ jobId: current.jobId }).catch(() => {});
      await current.captureLease.release().catch(() => {});
      await current.captureLease.waitForDrain().catch(() => {});
      await current.pushTail.catch(() => {});
      await cancelled;
    })();
    clearHandleAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (clearHandleAttempt === attempt) {
        clearHandleAttempt = null;
      }
    }
  };

  const start = async ({ micSession, sink, signal }: SttStartParams): Promise<void> => {
    if (signal?.aborted) return;
    if (!micSession) throw new Error('mic_session_required');
    const normalizedSessionId = `local-neural-${Date.now()}-${Math.random()}`;

    await clearHandle();
    const capture = getSharedVoicePcmCapture();
    const sherpa = getOptionalSherpaNativeModule();
    if (!capture || !sherpa) {
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_stt_unavailable' }));
      return;
    }

    let startupLease: VoicePcmCaptureLease | null = null;
    let startupRecognizerJobId: string | null = null;
    let abortCleanup = (): void => {};
    const abortController = new AbortController();
    const releaseStartupResources = async (): Promise<void> => {
      abortCleanup();
      const lease = startupLease;
      startupLease = null;
      await lease?.release().catch(() => {});
      await lease?.waitForDrain().catch(() => {});
      if (startupRecognizerJobId) {
        await sherpa.cancel({ jobId: startupRecognizerJobId }).catch(() => {});
        startupRecognizerJobId = null;
      }
      try {
        micSession.setMuted(false);
        await micSession.teardown();
      } catch {
        // Best-effort rollback of the caller-owned permission/mic facade.
      }
    };

    if (signal) {
      if (signal.aborted) {
        abortController.abort();
        await releaseStartupResources();
        return;
      }
      const abortFromExternalSignal = (): void => abortController.abort();
      signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', abortFromExternalSignal);
    }

    await micSession.ensureActive();
    if (abortController.signal.aborted) {
      await releaseStartupResources();
      return;
    }
    const { packId, language } = resolveLocalNeuralSttCaptureSettings(deps.getSettings());
    if (!packId) {
      await releaseStartupResources();
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_pack_missing' }));
      return;
    }

    let packDirUri: string;
    try {
      const installed = await ensureModelPackInstalled({
        packId,
        mode: 'require_installed',
        manifestUrl: resolveModelPackManifestUrl({ packId }),
        timeoutMs: 10_000,
        signal: abortController.signal,
      });
      packDirUri = installed.packDirUri;
    } catch {
      await releaseStartupResources();
      if (abortController.signal.aborted) {
        return;
      }
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_pack_not_installed' }));
      return;
    }
    if (abortController.signal.aborted) {
      await releaseStartupResources();
      return;
    }

    const sampleRate = VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz;
    const channels = VOICE_RUNTIME_STT_PCM_FORMAT.channelCount;
    const jobId = randomUUID();
    try {
      await sherpa.createStreamingRecognizer({
        jobId,
        assetsDir: uriToFilePath(packDirUri),
        sampleRate,
        channels,
        language,
      });
      startupRecognizerJobId = jobId;
      if (abortController.signal.aborted) {
        await releaseStartupResources();
        return;
      }

      const processFrame = async (frame: AudioStreamFrameEvent): Promise<void> => {
        const active = handle;
        if (!active || active.sessionId !== normalizedSessionId || active.jobId !== jobId || active.abortController.signal.aborted) return;
        if (!active.audioStarted) {
          active.audioStarted = true;
          sink.onAudioStarted();
        }
        const result = await sherpa.pushAudioFrame({
          jobId,
          pcm16leBase64: frame.pcm16leBase64,
          sampleRate: frame.sampleRate,
          channels: frame.channels,
        });
        const after = handle;
        if (!after || after.sessionId !== normalizedSessionId || after.jobId !== jobId || after.abortController.signal.aborted) return;
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (text) {
          after.transcript = text;
          sink.onPartial(text);
        }
        if (result.isEndpoint) {
          sink.onFinal(after.transcript);
          sink.onEndpoint('vad');
          endpointController.signalEndpointDetected({
            sessionId: normalizedSessionId,
            source: 'native_stream',
            transcript: after.transcript,
          });
        }
      };

      startupLease = await capture.acquire({
        ownerId: `sherpa-streaming-stt:${normalizedSessionId}`,
        format: { sampleRate, channels, frameMs: 20 },
        audioSession: VOICE_PCM_CONVERSATION_AUDIO_SESSION,
        maxQueuedFrames: MAX_QUEUED_FRAMES,
        shouldDeliver: () => !abortController.signal.aborted && !micSession.isMuted(),
        onFrame: async (frame) => {
          const active = handle;
          if (!active || active.jobId !== jobId) return;
          const operation = active.pushTail.catch(() => {}).then(() => processFrame(frame));
          active.pushTail = operation;
          await operation;
        },
        onDroppedFrames: () => {
          const failedHandle = handle;
          if (!failedHandle || failedHandle.jobId !== jobId) return;
          void clearHandle(failedHandle).then(() => {
            sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_stt_pcm_backpressure' }));
          });
        },
        onError: () => {
          const failedHandle = handle;
          if (!failedHandle || failedHandle.jobId !== jobId) return;
          void clearHandle(failedHandle).then(() => {
            sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_stt_pcm_frame_failed' }));
          });
        },
      });
      if (abortController.signal.aborted) {
        await releaseStartupResources();
        return;
      }
    } catch (error) {
      await releaseStartupResources();
      throw error;
    }

    const captureLease = startupLease;
    if (!captureLease) {
      await releaseStartupResources();
      throw new Error('local_neural_audio_capture_lease_missing');
    }
    handle = {
      sessionId: normalizedSessionId,
      jobId,
      capture,
      captureLease,
      transcript: '',
      abortController,
      pushTail: Promise.resolve(),
      audioStarted: false,
      abortCleanup,
    };
    startupLease = null;
    startupRecognizerJobId = null;
    endpointController.startSession(normalizedSessionId);
  };

  const stop = async (): Promise<SttStopResult> => {
    if (stopping) {
      return stopping;
    }
    const current = handle;
    if (!current) {
      await clearHandleAttempt?.catch(() => {});
      return { finalText: '' };
    }
    const pending = (async (): Promise<SttStopResult> => {
      try {
        endpointController.clearSession(current.sessionId);
        await current.captureLease.release();
        await current.captureLease.waitForDrain();
        await current.pushTail;

        const sherpa = getOptionalSherpaNativeModule();
        if (!sherpa) {
          throw new Error('local_neural_stt_runtime_unavailable_during_finalization');
        }
        const final = await sherpa.finishStreaming({ jobId: current.jobId });
        if (final.status !== 'finalized') {
          // Native could not finalize this job: it was cancelled, or its model
          // pack was invalidated while the tail decode was claimed. The retained
          // transcript is the last revisable interim partial, never a final one,
          // so this fails typed rather than submitting unfinalized text.
          throw new Error(`local_neural_stt_not_finalized:${final.status}`);
        }
        const text = typeof final.text === 'string' ? final.text.trim() : '';
        if (text) current.transcript = text;
        // A finalized empty transcript is silence, which is a successful result.
        return { finalText: current.transcript.trim() };
      } catch {
        const sherpa = getOptionalSherpaNativeModule();
        await sherpa?.cancel({ jobId: current.jobId }).catch(() => {});
        return {
          error: createVoiceMachineError({
            kind: 'provider_error',
            reason: 'local_neural_stt_finalization_failed',
          }),
        };
      } finally {
        if (handle === current) handle = null;
        current.abortCleanup();
      }
    })();
    stopping = pending;
    try {
      return await pending;
    } finally {
      if (stopping === pending) {
        stopping = null;
      }
    }
  };

  return { start, stop };
}
