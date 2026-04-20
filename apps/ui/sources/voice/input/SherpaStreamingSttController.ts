import { randomUUID } from '@/platform/randomUUID';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { getOptionalHappierAudioStreamNativeModule } from '@happier-dev/audio-stream-native';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import {
  createTurnEndpointController,
  type TurnEndpointController,
  type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

type DeviceSttStatePatch = {
  controlSessionId: string;
  reason: string;
};

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
};

export type SherpaStreamingSttController = Readonly<{
  start: (sessionId: string, micSession: MicSession) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
}>;

function getOptionalAudioStreamModule(): AudioStreamModuleLike | null {
  return (getOptionalHappierAudioStreamNativeModule() as unknown as AudioStreamModuleLike | null) ?? null;
}

function getOptionalSherpaNativeModule(): SherpaNativeModuleLike | null {
  return (getOptionalHappierSherpaNativeModule() as unknown as SherpaNativeModuleLike | null) ?? null;
}

export function createSherpaStreamingSttController(deps: {
  onCaptureStarted: (controlSessionId: string) => void;
  onCaptureError: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  endpointController?: TurnEndpointController;
}): SherpaStreamingSttController {
  let handle: SherpaSttHandle | null = null;
  const MAX_QUEUED_FRAMES = 8;
  const normalizeSessionId = (sessionId: string | null | undefined): string | null => normalizeNonEmptyString(sessionId);
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

  const start = async (sessionId: string, micSession: MicSession) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
    if (!micSession) {
      throw new Error('mic_session_required');
    }

    const permission = await requestMicrophonePermission();
    if (!permission.granted) {
      showMicrophonePermissionDeniedAlert(permission.canAskAgain);
      throw new Error('mic_permission_denied');
    }

    await clearHandle();

    const audioStream = getOptionalAudioStreamModule();
    const sherpa = getOptionalSherpaNativeModule();
    if (!audioStream || !sherpa) {
      deps.onCaptureError({ controlSessionId: normalizedSessionId, reason: 'local_neural_stt_unavailable' });
      return;
    }

    await micSession.ensureActive();

    const settings = deps.getSettings();
    const voice = settings?.voice ?? null;
    const providerId = voice?.providerId;
    const adapter =
      providerId === 'local_direct'
        ? voice?.adapters?.local_direct
        : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;
    const stt = adapter?.stt ?? null;
    let normalizedStt: any;
    try {
      normalizedStt = VoiceLocalSttSchema.parse(stt ?? {});
    } catch {
      normalizedStt = VoiceLocalSttSchema.parse({});
    }

    const defaultPackId = VoiceLocalSttSchema.parse({})?.localNeural?.assetId ?? null;
    const rawPackId = normalizedStt?.localNeural?.assetId;
    const packId =
      typeof rawPackId === 'string' && rawPackId.trim().length > 0
        ? rawPackId.trim()
        : typeof defaultPackId === 'string' && defaultPackId.trim().length > 0
          ? defaultPackId.trim()
          : '';
    const rawLanguage = normalizedStt?.localNeural?.language;
    const language = typeof rawLanguage === 'string' && rawLanguage.trim() ? rawLanguage.trim() : null;
    if (!packId) {
      deps.onCaptureError({ controlSessionId: normalizedSessionId, reason: 'local_neural_pack_missing' });
      return;
    }

    const abortController = new AbortController();
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
      deps.onCaptureError({ controlSessionId: normalizedSessionId, reason: 'local_neural_pack_not_installed' });
      return;
    }

    const assetsDir = uriToFilePath(packDirUri);

    const sampleRate = 16000;
    const channels = 1;
    const frameMs = 20;

    const { streamId } = await audioStream.start({ sampleRate, channels, frameMs });
    const jobId = randomUUID();

    await sherpa.createStreamingRecognizer({ jobId, assetsDir, sampleRate, channels, language });

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
      if (text.trim().length > 0) after.transcript = text.trim();
      if (res?.isEndpoint === true) {
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

    const subscriptions: SherpaSttHandle['subscriptions'] = [];
    subscriptions.push(
      audioStream.addListener('audioFrame', (event) => {
        if (!handle || handle.sessionId !== normalizedSessionId || handle.streamId !== event.streamId) return;
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
    };
    endpointController.startSession(normalizedSessionId);
    deps.onCaptureStarted(normalizedSessionId);
  };

  const stop = async (sessionId: string): Promise<string> => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!handle || !normalizedSessionId || handle.sessionId !== normalizedSessionId) return '';
    const current = handle;
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
    return current.transcript.trim();
  };

  return {
    start,
    stop,
  };
}
