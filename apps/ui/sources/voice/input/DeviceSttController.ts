import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { computeTurnEndpointDelayMs, normalizeTurnEndpointPolicy } from '@/voice/input/TurnEndpointDetector';
import { Platform } from 'react-native';

type DeviceSttStatePatch = {
  status?: 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';
  sessionId?: string | null;
  error?: string | null;
};

type DeviceSttHandle = {
  sessionId: string;
  transcript: string;
  isFinal: boolean;
  pendingAutoStop: boolean;
  startedAt: number;
  autoStopTimer: ReturnType<typeof setTimeout> | null;
  module: any;
  resolveEnd: () => void;
  endPromise: Promise<void>;
  subscriptions: { remove(): void }[];
};

export type DeviceSttController = Readonly<{
  clearHandsFreeSession: (sessionId?: string) => void;
  isHandsFreeSession: (sessionId: string) => boolean;
  start: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  setHandsFreeSession: (sessionId: string | null) => void;
}>;

export function createDeviceSttController(deps: {
  setState: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  canAutoStopTurn: (sessionId: string) => boolean;
  onAutoStopTurn: (sessionId: string) => void;
}): DeviceSttController {
  let handle: DeviceSttHandle | null = null;
  let handsFreeSessionId: string | null = null;

  const isDomRuntime = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

  const isHandsFreeDeviceSttEnabled = (): boolean => {
    const settings = deps.getSettings();
    const voice = settings?.voice ?? null;
    const providerId = voice?.providerId;
    const adapter =
      providerId === 'local_direct'
        ? voice?.adapters?.local_direct
        : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;
    const stt = adapter?.stt ?? null;
    const provider =
      typeof stt?.provider === 'string'
        ? stt.provider
        : stt?.useDeviceStt === true
          ? 'device'
          : 'openai_compat';
    const useDeviceStt = provider === 'device';
    const handsFreeEnabled = adapter?.handsFree?.enabled === true;
    return useDeviceStt && handsFreeEnabled;
  };

  const clearHandleTimer = () => {
    if (!handle?.autoStopTimer) return;
    clearTimeout(handle.autoStopTimer);
    handle.autoStopTimer = null;
  };

  const scheduleHandsFreeStop = (sessionId: string, expectedHandle: DeviceSttHandle) => {
    if (expectedHandle.autoStopTimer) {
      clearTimeout(expectedHandle.autoStopTimer);
      expectedHandle.autoStopTimer = null;
    }

    const settings = deps.getSettings();
    const voice = settings?.voice ?? null;
    const providerId = voice?.providerId;
    const adapter =
      providerId === 'local_direct'
        ? voice?.adapters?.local_direct
        : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;
    const policy = normalizeTurnEndpointPolicy({
      silenceMs: adapter?.handsFree?.endpointing?.silenceMs ?? 450,
      minSpeechMs: adapter?.handsFree?.endpointing?.minSpeechMs ?? 120,
    });
    const elapsedMs = Date.now() - expectedHandle.startedAt;
    const waitMs = computeTurnEndpointDelayMs(policy, elapsedMs);

    const triggerStop = () => {
      expectedHandle.autoStopTimer = null;
      if (!handle || handle !== expectedHandle || handle.sessionId !== sessionId) return;
      if (!isHandsFreeDeviceSttEnabled()) return;
      if (handsFreeSessionId !== sessionId) return;
      if (!deps.canAutoStopTurn(sessionId)) return;
      deps.onAutoStopTurn(sessionId);
    };

    if (waitMs <= 0) {
      queueMicrotask(triggerStop);
      return;
    }

    expectedHandle.autoStopTimer = setTimeout(triggerStop, waitMs);
  };

  const cleanupListeners = () => {
    const subscriptions = handle?.subscriptions ?? [];
    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }
  };

  const clearHandsFreeSession = (sessionId?: string) => {
    if (sessionId && handsFreeSessionId && handsFreeSessionId !== sessionId) {
      return;
    }
    handsFreeSessionId = null;
  };

  const start = async (sessionId: string) => {
    const microphonePermission = await requestMicrophonePermission();
    if (!microphonePermission.granted) {
      showMicrophonePermissionDeniedAlert(microphonePermission.canAskAgain);
      return;
    }

    const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');

    if (typeof ExpoSpeechRecognitionModule?.isRecognitionAvailable === 'function' && !ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      deps.setState({ status: 'idle', sessionId: null, error: 'device_stt_unavailable' });
      return;
    }

    // `expo-speech-recognition` logs noisy "not supported on web" warnings for this call.
    // Prefer DOM detection over Platform.OS so web builds remain resilient even if Platform.OS is surprising.
    if (Platform.OS !== 'web' && !isDomRuntime()) {
      try {
        const permissionsResponse = await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        if (permissionsResponse && permissionsResponse.granted === false) {
          deps.setState({ status: 'idle', sessionId: null, error: 'device_stt_permission_denied' });
          return;
        }
      } catch {
        // Permission request best-effort.
      }
    }

    clearHandleTimer();
    cleanupListeners();

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    const nextHandle: DeviceSttHandle = {
      sessionId,
      transcript: '',
      isFinal: false,
      pendingAutoStop: false,
      startedAt: Date.now(),
      autoStopTimer: null,
      module: ExpoSpeechRecognitionModule,
      resolveEnd: () => resolveEnd?.(),
      endPromise,
      subscriptions: [],
    };

    handle = nextHandle;

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
        const results = Array.isArray(event?.results) ? event.results : [];
        const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
        if (!transcript) return;

        nextHandle.transcript = transcript;
        if (event?.isFinal) {
          nextHandle.isFinal = true;
          if (!nextHandle.pendingAutoStop && isHandsFreeDeviceSttEnabled()) {
            nextHandle.pendingAutoStop = true;
            scheduleHandsFreeStop(sessionId, nextHandle);
          }
        }
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        nextHandle.resolveEnd();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('error', () => {
        nextHandle.resolveEnd();
      })
    );

    const settings = deps.getSettings();
    const language = typeof settings?.voice?.assistantLanguage === 'string' && settings.voice.assistantLanguage.trim()
      ? settings.voice.assistantLanguage.trim()
      : undefined;

    try {
      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        maxAlternatives: 1,
        continuous: true,
      } as any);
    } catch (error) {
      handle = null;
      deps.setState({ status: 'idle', sessionId: null, error: 'device_stt_start_failed' });
      throw error;
    }

    deps.setState({ status: 'recording', sessionId, error: null });
  };

  const stop = async (sessionId: string): Promise<string> => {
    if (!handle || handle.sessionId !== sessionId) {
      return '';
    }

    clearHandleTimer();

    try {
      handle.module?.stop?.();
    } catch {
      // ignore
    }

    await Promise.race([handle.endPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);

    const text = handle.transcript.trim();
    const subscriptions = handle.subscriptions;
    if (handle.autoStopTimer) {
      clearTimeout(handle.autoStopTimer);
    }
    handle = null;

    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }

    return text;
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
