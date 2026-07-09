import { randomUUID } from '@/platform/randomUUID';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { getOptionalHappierAudioStreamNativeModule } from '@happier-dev/audio-stream-native';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import {
  createTurnEndpointController,
  type TurnEndpointController,
  type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { VOICE_RUNTIME_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { resolveLocalNeuralSttCaptureSettings } from './resolveLocalNeuralSttCaptureSettings';
import type { SttController, SttStartParams } from './sttController';

type AudioStreamFrameEvent = {
  streamId: string;
  pcm16leBase64: string;
  sampleRate: number;
  channels: number;
};

type AudioStreamModuleLike = {
  start(params: { sampleRate: number; channels: number; frameMs: number }): Promise<{ streamId: string }>;
  stop(params: { streamId: string }): Promise<void>;
  addListener(eventName: 'audioFrame', cb: (event: AudioStreamFrameEvent) => void): { remove(): void };
};

type SherpaNativeModuleLike = {
  createStreamingRecognizer(params: { jobId: string; assetsDir: string; sampleRate: number; channels: number; language: string | null }): Promise<void>;
  pushAudioFrame(params: { jobId: string; pcm16leBase64: string; sampleRate: number; channels: number }): Promise<{ text: string; isEndpoint: boolean }>;
  finishStreaming(params: { jobId: string }): Promise<{ text: string }>;
  cancel(params: { jobId: string }): Promise<void>;
};

type SherpaSttHandle = {
  sessionId: string;
  jobId: string;
  streamId: string;
  transcript: string;
  subscriptions: { remove(): void }[];
  abortController: AbortController;
  pushing: boolean;
  queuedFrames: Array<{ pcm16leBase64: string; sampleRate: number; channels: number }>;
  pushLoop: Promise<void> | null;
  audioStarted: boolean;
  abortCleanup: () => void;
};

export type SherpaStreamingSttController = SttController;

export type CreateSherpaStreamingSttControllerDeps = {
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  endpointController?: TurnEndpointController;
};

function getOptionalAudioStreamModule(): AudioStreamModuleLike | null {
  return (getOptionalHappierAudioStreamNativeModule() as unknown as AudioStreamModuleLike | null) ?? null;
}

function getOptionalSherpaNativeModule(): SherpaNativeModuleLike | null {
  return (getOptionalHappierSherpaNativeModule() as unknown as SherpaNativeModuleLike | null) ?? null;
}

export function createSherpaStreamingSttController(deps: CreateSherpaStreamingSttControllerDeps): SherpaStreamingSttController {
  let handle: SherpaSttHandle | null = null;
  const MAX_QUEUED_FRAMES = 8;
  const endpointController = deps.endpointController ?? createTurnEndpointController({
    onSignal: (signal) => {
      deps.onEndpointSignal?.(signal);
    },
  });

  const uriToFilePath = (uri: string): string => {
    return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  };

  const clearHandle = async () => {
    const h = handle;
    if (!h) return;
    handle = null;
    endpointController.clearSession(h.sessionId);
    try {
      h.abortController.abort();
    } catch {
      // ignore
    }
    h.abortCleanup();
    try {
      h.subscriptions.forEach((s) => s.remove());
    } catch {
      // ignore
    }
    const audioStream = getOptionalAudioStreamModule();
    if (audioStream) {
      try {
        await audioStream.stop({ streamId: h.streamId });
      } catch {
        // ignore
      }
    }
    const sherpa = getOptionalSherpaNativeModule();
    if (sherpa) {
      try {
        await sherpa.cancel({ jobId: h.jobId });
      } catch {
        // ignore
      }
    }
  };

  const start = async ({ micSession, sink, signal }: SttStartParams) => {
    if (signal?.aborted) {
      return;
    }
    if (!micSession) {
      throw new Error('mic_session_required');
    }
    const normalizedSessionId = `local-neural-${Date.now()}-${Math.random()}`;

    const permission = await requestMicrophonePermission();
    if (!permission.granted) {
      showMicrophonePermissionDeniedAlert(permission.canAskAgain);
      throw new Error('mic_permission_denied');
    }

    await clearHandle();

    const audioStream = getOptionalAudioStreamModule();
    const sherpa = getOptionalSherpaNativeModule();
    if (!audioStream || !sherpa) {
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_stt_unavailable' }));
      return;
    }

    // Single transactional cleanup path for ANY startup failure after the mic is
    // active: releases every native resource staged so far (recognizer, audio
    // stream, frame subscriptions) AND the injected mic capture, so a failed start
    // never leaks mic/audio. Mic teardown is also performed by the capture owner
    // (the mic's lifecycle owner) for the device path; both are best-effort and
    // idempotent so a defence-in-depth double-release cannot strand state.
    let startupStreamId: string | null = null;
    let startupRecognizerJobId: string | null = null;
    let abortCleanup = (): void => {};
    const startupSubscriptions: SherpaSttHandle['subscriptions'] = [];
    const releaseStartupResources = async (): Promise<void> => {
      abortCleanup();
      try {
        startupSubscriptions.forEach((s) => s.remove());
      } catch {
        // ignore
      }
      startupSubscriptions.length = 0;
      if (startupRecognizerJobId !== null) {
        try {
          await sherpa.cancel({ jobId: startupRecognizerJobId });
        } catch {
          // ignore
        }
        startupRecognizerJobId = null;
      }
      if (startupStreamId !== null) {
        try {
          await audioStream.stop({ streamId: startupStreamId });
        } catch {
          // ignore
        }
        startupStreamId = null;
      }
      try {
        micSession.setMuted(false);
        await micSession.teardown();
      } catch {
        // ignore
      }
    };

    await micSession.ensureActive();

    const { packId, language } = resolveLocalNeuralSttCaptureSettings(deps.getSettings());
    if (!packId) {
      await releaseStartupResources();
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_pack_missing' }));
      return;
    }

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        abortController.abort();
        await releaseStartupResources();
        return;
      }
      const abortFromExternalSignal = () => abortController.abort();
      signal.addEventListener('abort', abortFromExternalSignal, { once: true });
      abortCleanup = () => {
        signal.removeEventListener('abort', abortFromExternalSignal);
      };
    }
    const manifestUrl = resolveModelPackManifestUrl({ packId });
    let packDirUri: string;
    try {
      const installed = await ensureModelPackInstalled({
        packId,
        mode: 'require_installed',
        manifestUrl,
        timeoutMs: 10_000,
        signal: abortController.signal,
      });
      packDirUri = installed.packDirUri;
    } catch {
      await releaseStartupResources();
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'local_neural_pack_not_installed' }));
      return;
    }

    const assetsDir = uriToFilePath(packDirUri);

    const sampleRate = VOICE_RUNTIME_STT_PCM_FORMAT.sampleRateHz;
    const channels = VOICE_RUNTIME_STT_PCM_FORMAT.channelCount;
    const frameMs = 20;

    let jobId: string;
    try {
      const started = await audioStream.start({ sampleRate, channels, frameMs });
      startupStreamId = started.streamId;
      jobId = randomUUID();
      await sherpa.createStreamingRecognizer({ jobId, assetsDir, sampleRate, channels, language });
      startupRecognizerJobId = jobId;
    } catch (error) {
      // Half-open startup (stream up, recognizer down — or vice versa): release
      // every staged resource + the mic before propagating, so nothing leaks.
      await releaseStartupResources();
      throw error;
    }
    if (startupStreamId === null) {
      // Defensive: the successful try guarantees a stream id; treat its absence as
      // a startup failure rather than committing a handle with no stream.
      await releaseStartupResources();
      throw new Error('local_neural_audio_stream_missing');
    }
    const streamId: string = startupStreamId;

    const processFrame = async (frame: { pcm16leBase64: string; sampleRate: number; channels: number }) => {
      const active = handle;
      if (!active || active.sessionId !== normalizedSessionId || active.jobId !== jobId) return;
      if (active.abortController.signal.aborted) return;

      const res = await sherpa.pushAudioFrame({
        jobId,
        pcm16leBase64: frame.pcm16leBase64,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
      });

      const after = handle;
      if (!after || after.sessionId !== normalizedSessionId || after.jobId !== jobId) return;
      const text = typeof res?.text === 'string' ? res.text : '';
      if (text.trim().length > 0) {
        const trimmed = text.trim();
        after.transcript = trimmed;
        sink.onPartial(trimmed);
      }
      if (res?.isEndpoint === true) {
        sink.onFinal(after.transcript);
        sink.onEndpoint('vad');
        endpointController.signalEndpointDetected({
          sessionId: normalizedSessionId,
          source: 'native_stream',
          transcript: after.transcript,
        });
      }
    };

    const startPushLoop = (first: { pcm16leBase64: string; sampleRate: number; channels: number }) => {
      const active = handle;
      if (!active || active.sessionId !== normalizedSessionId || active.jobId !== jobId) return;
      if (active.pushing) return;
      active.pushing = true;

      active.pushLoop = (async () => {
        let currentFrame: { pcm16leBase64: string; sampleRate: number; channels: number } | null = first;
        while (currentFrame) {
          try {
            await processFrame(currentFrame);
          } catch {
            // ignore
          }

          const after = handle;
          if (!after || after.sessionId !== normalizedSessionId || after.jobId !== jobId) return;
          if (after.abortController.signal.aborted) return;
          currentFrame = after.queuedFrames.shift() ?? null;
        }
      })().finally(() => {
        const after = handle;
        if (!after || after.sessionId !== normalizedSessionId || after.jobId !== jobId) return;
        after.pushing = false;
        after.pushLoop = null;
      });
    };

    const subscriptions: SherpaSttHandle['subscriptions'] = startupSubscriptions;
    subscriptions.push(
      audioStream.addListener('audioFrame', (event) => {
        if (!handle || handle.sessionId !== normalizedSessionId || handle.streamId !== event.streamId) return;
        if (!handle.audioStarted) {
          handle.audioStarted = true;
          sink.onAudioStarted();
        }
        const frame = {
          pcm16leBase64: String(event.pcm16leBase64 ?? ''),
          sampleRate: event.sampleRate ?? sampleRate,
          channels: event.channels ?? channels,
        };

        // Serialize frames into a bounded queue to prevent unbounded concurrent native work.
        if (handle.pushing) {
          handle.queuedFrames.push(frame);
          while (handle.queuedFrames.length > MAX_QUEUED_FRAMES) {
            handle.queuedFrames.shift();
          }
          return;
        }

        startPushLoop(frame);
      }),
    );

    handle = {
      sessionId: normalizedSessionId,
      jobId,
      streamId,
      transcript: '',
      subscriptions,
      abortController,
      pushing: false,
      queuedFrames: [],
      pushLoop: null,
      audioStarted: false,
      abortCleanup,
    };
    endpointController.startSession(normalizedSessionId);
  };

  const stop = async () => {
    if (!handle) return { finalText: '' };
    const current = handle;
    const normalizedSessionId = current.sessionId;
    endpointController.clearSession(normalizedSessionId);

    try {
      current.subscriptions.forEach((s) => s.remove());
    } catch {
      // ignore
    }

    const audioStream = getOptionalAudioStreamModule();
    if (audioStream) {
      try {
        await audioStream.stop({ streamId: current.streamId });
      } catch {
        // ignore
      }
    }

    const sherpa = getOptionalSherpaNativeModule();
    if (sherpa) {
      try {
        await current.pushLoop?.catch(() => {});
        const final = await sherpa.finishStreaming({ jobId: current.jobId });
        const text = typeof final?.text === 'string' ? final.text.trim() : '';
        if (text) current.transcript = text;
      } catch {
        // ignore
      }
    }

    if (handle && handle.sessionId === normalizedSessionId) {
      handle = null;
    }
    current.abortCleanup();
    return { finalText: current.transcript.trim() };
  };

  return {
    start,
    stop,
  };
}
