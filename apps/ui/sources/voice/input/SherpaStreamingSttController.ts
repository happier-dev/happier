import { randomUUID } from '@/platform/randomUUID';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { getOptionalHappierAudioStreamNativeModule } from '@happier-dev/audio-stream-native';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { createTurnEndpointDetector, type TurnEndpointDetector } from '@/voice/input/TurnEndpointDetector';
import {
  isHandsFreeSttEnabled,
  resolveHandsFreeTurnEndpointPolicy,
  resolveLocalVoiceAdapterSettings,
  type LocalVoiceSettingsInput,
} from '@/voice/local/localVoiceSettings';
import { fileUriToNativePath } from '@/voice/modelPacks/nativePath';

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

type AudioStreamErrorEvent = {
  streamId: string;
  code?: string;
  message?: string;
};

type AudioStreamModuleLike = {
  start(params: { sampleRate: number; channels: number; frameMs: number }): Promise<{ streamId: string }>;
  stop(params: { streamId: string }): Promise<void>;
  addListener(eventName: 'audioFrame', cb: (event: AudioStreamFrameEvent) => void): { remove(): void };
  addListener(eventName: 'audioError', cb: (event: AudioStreamErrorEvent) => void): { remove(): void };
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
  sampleRate: number;
  channels: number;
  startedAt: number;
  transcript: string;
  subscriptions: { remove(): void }[];
  pendingChunks: Uint8Array[];
  pendingBytes: number;
  pushLoop: Promise<void> | null;
  endpointDetector: TurnEndpointDetector;
  /** Set synchronously when stop begins; stop is idempotent and auto-stop is disarmed from then on. */
  stopPromise: Promise<string> | null;
};

type StartAttempt = {
  sessionId: string;
  cancelled: boolean;
  abortController: AbortController;
};

export type SherpaStreamingSttController = Readonly<{
  clearHandsFreeSession: (sessionId?: string) => void;
  isHandsFreeSession: (sessionId: string) => boolean;
  start: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  setHandsFreeSession: (sessionId: string | null) => void;
}>;

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const FRAME_MS = 20;

/**
 * Audio is pushed to the native recognizer in batches of at least this much PCM instead of per
 * 20 ms capture frame. Each push is one JS→native bridge round-trip plus a decode pass; at 20 ms
 * that is 50 calls/s, which a busy JS thread could not keep up with, so the old bounded queue
 * dropped audio (gaps in recognition). 100 ms cuts bridge calls 5x while adding at most 100 ms to
 * partial results and endpoint detection — small next to the native endpoint rules (0.6–1.2 s of
 * trailing silence). Audio that arrives while a push is in flight is coalesced into the next push,
 * never dropped; pending audio is bounded by the recording length (32 KB per second at 16 kHz).
 */
const MIN_PUSH_BATCH_MS = 100;

function getOptionalAudioStreamModule(): AudioStreamModuleLike | null {
  return (getOptionalHappierAudioStreamNativeModule() as unknown as AudioStreamModuleLike | null) ?? null;
}

function getOptionalSherpaNativeModule(): SherpaNativeModuleLike | null {
  return (getOptionalHappierSherpaNativeModule() as unknown as SherpaNativeModuleLike | null) ?? null;
}


function resolvePackId(settings: LocalVoiceSettingsInput): string {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  const parsed = VoiceLocalSttSchema.safeParse(config?.stt ?? {});
  const stt = parsed.success ? parsed.data : VoiceLocalSttSchema.parse({});
  const configured = stt.localNeural.assetId?.trim();
  if (configured) return configured;
  return VoiceLocalSttSchema.parse({}).localNeural.assetId?.trim() ?? '';
}

function pendingMs(h: SherpaSttHandle): number {
  const bytesPerMs = (h.sampleRate * h.channels * 2) / 1000;
  return bytesPerMs > 0 ? h.pendingBytes / bytesPerMs : 0;
}

function takePending(h: SherpaSttHandle): Uint8Array {
  const out = new Uint8Array(h.pendingBytes);
  let offset = 0;
  for (const chunk of h.pendingChunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  h.pendingChunks = [];
  h.pendingBytes = 0;
  return out;
}

export function createSherpaStreamingSttController(deps: {
  setState: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  canAutoStopTurn: (sessionId: string) => boolean;
  onAutoStopTurn: (sessionId: string) => void;
}): SherpaStreamingSttController {
  let handle: SherpaSttHandle | null = null;
  let startAttempt: StartAttempt | null = null;
  let handsFreeSessionId: string | null = null;

  const releaseNative = async (params: { streamId: string | null; jobId: string }) => {
    const audioStream = getOptionalAudioStreamModule();
    if (audioStream && params.streamId) {
      await audioStream.stop({ streamId: params.streamId }).catch(() => {});
    }
    const sherpa = getOptionalSherpaNativeModule();
    if (sherpa) {
      await sherpa.cancel({ jobId: params.jobId }).catch(() => {});
    }
  };

  const detachHandle = (h: SherpaSttHandle) => {
    if (handle === h) handle = null;
    h.endpointDetector.cancel();
    h.subscriptions.forEach((s) => s.remove());
    h.subscriptions = [];
  };

  const cancelStartAttempt = () => {
    const attempt = startAttempt;
    if (!attempt) return;
    startAttempt = null;
    attempt.cancelled = true;
    attempt.abortController.abort();
  };

  const clearHandle = async () => {
    const h = handle;
    if (!h) return;
    detachHandle(h);
    await releaseNative({ streamId: h.streamId, jobId: h.jobId });
  };

  const failActive = async (h: SherpaSttHandle, error: string) => {
    if (handle !== h) return;
    detachHandle(h);
    if (handsFreeSessionId === h.sessionId) handsFreeSessionId = null;
    await releaseNative({ streamId: h.streamId, jobId: h.jobId });
    deps.setState({ status: 'idle', sessionId: null, error });
  };

  const isHandsFreeActive = (h: SherpaSttHandle): boolean =>
    handsFreeSessionId === h.sessionId && isHandsFreeSttEnabled(deps.getSettings());

  const onPushResult = (h: SherpaSttHandle, res: { text?: unknown; isEndpoint?: unknown }) => {
    const text = typeof res?.text === 'string' ? res.text.trim() : '';
    if (text) h.transcript = text;
    if (h.stopPromise || !isHandsFreeActive(h)) {
      h.endpointDetector.cancel();
      return;
    }

    h.endpointDetector.observe({
      transcript: h.transcript,
      isEndpoint: res?.isEndpoint === true,
      policy: resolveHandsFreeTurnEndpointPolicy(deps.getSettings()),
      speechElapsedMs: Date.now() - h.startedAt,
    });
  };

  const pushPending = async (sherpa: SherpaNativeModuleLike, h: SherpaSttHandle) => {
    const batch = takePending(h);
    const res = await sherpa.pushAudioFrame({
      jobId: h.jobId,
      pcm16leBase64: encodeBase64(batch),
      sampleRate: h.sampleRate,
      channels: h.channels,
    });
    onPushResult(h, res);
  };

  const ensurePushLoop = (sherpa: SherpaNativeModuleLike, h: SherpaSttHandle) => {
    if (h.pushLoop || pendingMs(h) < MIN_PUSH_BATCH_MS) return;
    h.pushLoop = (async () => {
      while (handle === h && pendingMs(h) >= MIN_PUSH_BATCH_MS) {
        await pushPending(sherpa, h);
      }
    })()
      .catch(() => failActive(h, 'stt_failed'))
      .finally(() => {
        h.pushLoop = null;
      });
  };

  const clearHandsFreeSession = (sessionId?: string) => {
    if (sessionId && handsFreeSessionId && handsFreeSessionId !== sessionId) return;
    handsFreeSessionId = null;
  };

  const runStart = async (attempt: StartAttempt) => {
    const { sessionId } = attempt;
    const permission = await requestMicrophonePermission();
    if (attempt.cancelled) return;
    if (!permission.granted) {
      showMicrophonePermissionDeniedAlert(permission.canAskAgain);
      return;
    }

    const audioStream = getOptionalAudioStreamModule();
    const sherpa = getOptionalSherpaNativeModule();
    if (!audioStream || !sherpa) {
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_stt_unavailable' });
      return;
    }

    const packId = resolvePackId(deps.getSettings());
    if (!packId) {
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_pack_missing' });
      return;
    }

    let packDirUri: string;
    try {
      const installed = await ensureModelPackInstalled({
        packId,
        mode: 'require_installed',
        manifestUrl: resolveModelPackManifestUrl({ packId }),
        timeoutMs: 10_000,
        signal: attempt.abortController.signal,
      });
      packDirUri = installed.packDirUri;
    } catch {
      if (attempt.cancelled) return;
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_pack_not_installed' });
      return;
    }
    if (attempt.cancelled) return;

    const jobId = randomUUID();
    let streamId: string | null = null;
    try {
      ({ streamId } = await audioStream.start({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frameMs: FRAME_MS }));
      if (attempt.cancelled) throw new Error('local_neural_stt_start_cancelled');
      // Streaming zipformer packs are single-language; the recognizer language comes from the pack.
      await sherpa.createStreamingRecognizer({
        jobId,
        assetsDir: fileUriToNativePath(packDirUri),
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        language: null,
      });
      if (attempt.cancelled) throw new Error('local_neural_stt_start_cancelled');
    } catch {
      await releaseNative({ streamId, jobId });
      if (attempt.cancelled) return;
      deps.setState({ status: 'idle', sessionId: null, error: 'local_neural_stt_start_failed' });
      return;
    }

    const h: SherpaSttHandle = {
      sessionId,
      jobId,
      streamId,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      startedAt: Date.now(),
      transcript: '',
      subscriptions: [],
      pendingChunks: [],
      pendingBytes: 0,
      pushLoop: null,
      endpointDetector: createTurnEndpointDetector({
        onEndpoint: () => {
          if (handle !== h || h.stopPromise || !isHandsFreeActive(h)) return;
          if (!deps.canAutoStopTurn(h.sessionId)) return;
          deps.onAutoStopTurn(h.sessionId);
        },
      }),
      stopPromise: null,
    };
    h.subscriptions.push(
      audioStream.addListener('audioFrame', (event) => {
        if (handle !== h || event.streamId !== h.streamId) return;
        const bytes = decodeBase64(String(event.pcm16leBase64 ?? ''));
        if (bytes.length === 0) return;
        h.sampleRate = event.sampleRate || h.sampleRate;
        h.channels = event.channels || h.channels;
        h.pendingChunks.push(bytes);
        h.pendingBytes += bytes.length;
        ensurePushLoop(sherpa, h);
      }),
      audioStream.addListener('audioError', (event) => {
        if (handle !== h || event.streamId !== h.streamId) return;
        void failActive(h, 'local_neural_audio_capture_failed');
      }),
    );
    handle = h;
    deps.setState({ status: 'recording', sessionId, error: null });
  };

  const start = async (sessionId: string) => {
    cancelStartAttempt();
    await clearHandle();

    const attempt: StartAttempt = { sessionId, cancelled: false, abortController: new AbortController() };
    startAttempt = attempt;
    try {
      await runStart(attempt);
    } finally {
      if (startAttempt === attempt) startAttempt = null;
    }
  };

  const stop = async (sessionId: string): Promise<string> => {
    if (startAttempt?.sessionId === sessionId) {
      cancelStartAttempt();
      return '';
    }
    const h = handle;
    if (!h || h.sessionId !== sessionId) return '';
    h.stopPromise ??= finishStop(h);
    return await h.stopPromise;
  };

  const finishStop = async (h: SherpaSttHandle): Promise<string> => {
    h.endpointDetector.cancel();
    h.subscriptions.forEach((s) => s.remove());
    h.subscriptions = [];

    const audioStream = getOptionalAudioStreamModule();
    await audioStream?.stop({ streamId: h.streamId }).catch(() => {});

    const sherpa = getOptionalSherpaNativeModule();
    if (sherpa) {
      try {
        await h.pushLoop;
        if (h.pendingBytes > 0) await pushPending(sherpa, h);
        const final = await sherpa.finishStreaming({ jobId: h.jobId });
        const text = typeof final?.text === 'string' ? final.text.trim() : '';
        if (text) h.transcript = text;
      } catch {
        // Keep the latest partial transcript and release the native job.
        await sherpa.cancel({ jobId: h.jobId }).catch(() => {});
      }
    }

    if (handle === h) handle = null;
    return h.transcript.trim();
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
