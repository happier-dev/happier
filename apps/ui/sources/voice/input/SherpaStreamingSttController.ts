import { randomUUID } from '@/platform/randomUUID';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { getOptionalHappierAudioStreamNativeModule } from '@happier-dev/audio-stream-native';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';

type DeviceSttStatePatch = {
  status?: 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';
  sessionId?: string | null;
  error?: string | null;
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
};

export type SherpaStreamingSttController = Readonly<{
  clearHandsFreeSession: (sessionId?: string) => void;
  isHandsFreeSession: (sessionId: string) => boolean;
  start: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  setHandsFreeSession: (sessionId: string | null) => void;
}>;

function getOptionalAudioStreamModule(): AudioStreamModuleLike | null {
  return (getOptionalHappierAudioStreamNativeModule() as unknown as AudioStreamModuleLike | null) ?? null;
}

function getOptionalSherpaNativeModule(): SherpaNativeModuleLike | null {
  return (getOptionalHappierSherpaNativeModule() as unknown as SherpaNativeModuleLike | null) ?? null;
}

export function createSherpaStreamingSttController(deps: {
  setState: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
}): SherpaStreamingSttController {
  let handle: SherpaSttHandle | null = null;
  let handsFreeSessionId: string | null = null;

  const uriToFilePath = (uri: string): string => {
    return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  };

  const clearHandle = async () => {
    const h = handle;
    if (!h) return;
    handle = null;
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

  const clearHandsFreeSession = (sessionId?: string) => {
    if (sessionId && handsFreeSessionId && handsFreeSessionId !== sessionId) return;
    handsFreeSessionId = null;
  };

  const start = async (sessionId: string) => {
    const permission = await requestMicrophonePermission();
    if (!permission.granted) {
      showMicrophonePermissionDeniedAlert(permission.canAskAgain);
      return;
    }

    await clearHandle();

    const audioStream = getOptionalAudioStreamModule();
    const sherpa = getOptionalSherpaNativeModule();
    if (!audioStream || !sherpa) {
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_stt_unavailable' });
      return;
    }

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
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_pack_missing' });
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
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_pack_not_installed' });
      return;
    }

    const assetsDir = uriToFilePath(packDirUri);

    const sampleRate = 16000;
    const channels = 1;
    const frameMs = 20;

    const { streamId } = await audioStream.start({ sampleRate, channels, frameMs });
    const jobId = randomUUID();

    await sherpa.createStreamingRecognizer({ jobId, assetsDir, sampleRate, channels, language });

    const subscriptions: SherpaSttHandle['subscriptions'] = [];
    subscriptions.push(
      audioStream.addListener('audioFrame', (event) => {
        if (!handle || handle.sessionId !== sessionId || handle.streamId !== event.streamId) return;
        void sherpa
          .pushAudioFrame({
            jobId,
            pcm16leBase64: String(event.pcm16leBase64 ?? ''),
            sampleRate: event.sampleRate ?? sampleRate,
            channels: event.channels ?? channels,
          })
          .then((res) => {
            if (!handle || handle.sessionId !== sessionId) return;
            const text = typeof res?.text === 'string' ? res.text : '';
            if (text.trim().length > 0) handle.transcript = text.trim();
          })
          .catch(() => {});
      }),
    );

    handle = { sessionId, jobId, streamId, transcript: '', subscriptions, abortController };
    deps.setState({ status: 'recording', sessionId, error: null });
  };

  const stop = async (sessionId: string): Promise<string> => {
    if (!handle || handle.sessionId !== sessionId) return '';
    const current = handle;
    handle = null;

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
        const final = await sherpa.finishStreaming({ jobId: current.jobId });
        const text = typeof final?.text === 'string' ? final.text.trim() : '';
        if (text) current.transcript = text;
      } catch {
        // ignore
      }
    }

    return current.transcript.trim();
  };

  return {
    clearHandsFreeSession,
    isHandsFreeSession: (sessionId: string) => handsFreeSessionId === sessionId,
    setHandsFreeSession: (sessionId: string | null) => {
      handsFreeSessionId = sessionId;
    },
    start,
    stop,
  };
}
