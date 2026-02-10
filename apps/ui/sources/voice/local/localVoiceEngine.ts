import { AudioModule, RecordingPresets, createAudioPlayer } from 'expo-audio';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { buildOpenAiTranscriptionRequest } from './openaiCompat';
import { fetchOpenAiCompatSpeechAudio } from './fetchOpenAiCompatSpeechAudio';
import { DaemonMediatorClient } from '@/voice/mediator/daemonMediatorClient';
import { OpenAiCompatMediatorClient } from '@/voice/mediator/openaiCompatMediatorClient';
import type { VoiceMediatorClient } from '@/voice/mediator/types';
import { buildVoiceInitialContext } from '@/voice/context/buildVoiceInitialContext';
import { resolveDaemonVoiceMediatorModelIds } from '@/voice/mediator/resolveDaemonMediatorModels';
import { isRpcMethodNotAvailableError } from '@/sync/runtime/rpcErrors';

export type LocalVoiceStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

type LocalVoiceState = {
  status: LocalVoiceStatus;
  sessionId: string | null;
  error: string | null;
};

const useLocalVoiceStore = create<LocalVoiceState>(() => ({
  status: 'idle',
  sessionId: null,
  error: null,
}));

export function getLocalVoiceState(): LocalVoiceState {
  return useLocalVoiceStore.getState();
}

export const useLocalVoiceStatus = () => useLocalVoiceStore((s) => s.status);

let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
let inFlight: Promise<void> | null = null;

type MediatorHandle = { client: VoiceMediatorClient; mediatorId: string; backend: 'daemon' | 'openai_compat' };
const mediatorBySessionId = new Map<string, MediatorHandle>();
const mediatorPendingContextBySessionId = new Map<string, string[]>();
let openaiCompatMediatorClient: OpenAiCompatMediatorClient | null = null;
let daemonMediatorClient: DaemonMediatorClient | null = null;

function setState(patch: Partial<LocalVoiceState>) {
  useLocalVoiceStore.setState((s) => ({ ...s, ...patch }));
}

function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  // expo-audio HIGH_QUALITY preset uses .m4a on native
  return 'audio/mp4';
}

async function startRecording(sessionId: string) {
  const perm = await requestMicrophonePermission();
  if (!perm.granted) {
    showMicrophonePermissionDeniedAlert(perm.canAskAgain);
    return;
  }

  const nextRecorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  try {
    await nextRecorder.prepareToRecordAsync();
    nextRecorder.record();
    recorder = nextRecorder;
    setState({ status: 'recording', sessionId, error: null });
  } catch (e) {
    try {
      await nextRecorder.stop?.();
    } catch {
      // best-effort
    }
    recorder = null;
    setState({ status: 'idle', sessionId: null, error: 'recording_start_failed' });
    throw e;
  }
}

async function stopAndSend(sessionId: string) {
  if (!recorder) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  setState({ status: 'transcribing', error: null });
  let uri: string | null = null;
  try {
    await recorder.stop();
    uri = recorder.uri;
  } catch {
    recorder = null;
    setState({ status: 'idle', sessionId: null, error: 'recording_stop_failed' });
    return;
  }
  recorder = null;

  if (!uri) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  const settings = storage.getState().settings as any;
  const sttBaseUrl = (settings.voiceLocalSttBaseUrl ?? '').trim();
  if (!sttBaseUrl) {
    setState({ status: 'idle', sessionId: null, error: 'missing_stt_base_url' });
    throw new Error('missing_stt_base_url');
  }

  const sttApiKey = settings.voiceLocalSttApiKey ? (sync.decryptSecretValue(settings.voiceLocalSttApiKey) ?? null) : null;
  const sttModel = (settings.voiceLocalSttModel ?? 'whisper-1') as string;

  const fileName = (RecordingPresets.HIGH_QUALITY as any)?.extension
    ? `recording${(RecordingPresets.HIGH_QUALITY as any).extension}`
    : 'recording.m4a';

  const transcriptionReq = await (async () => {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
      const blob = await (await fetch(uri)).blob();
      return buildOpenAiTranscriptionRequest({
        baseUrl: sttBaseUrl,
        apiKey: sttApiKey,
        model: sttModel,
        file: { kind: 'web', blob, name: fileName.replace(/\.m4a$/i, '.webm') },
      });
    }
    return buildOpenAiTranscriptionRequest({
      baseUrl: sttBaseUrl,
      apiKey: sttApiKey,
      model: sttModel,
      file: { kind: 'native', uri, name: fileName, mimeType: guessMimeType(fileName) },
    });
  })();

  let res: Response;
  try {
    res = await fetch(transcriptionReq.url, transcriptionReq.init);
  } catch {
    setState({ status: 'idle', sessionId: null, error: 'stt_failed' });
    return;
  }
  if (!res.ok) {
    setState({ status: 'idle', sessionId: null, error: 'stt_failed' });
    return;
  }
  const json = await res.json().catch(() => null);
  const text = json && typeof json.text === 'string' ? json.text.trim() : '';
  if (!text) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  const conversationMode = (settings.voiceLocalConversationMode ?? 'direct_session') as 'direct_session' | 'mediator';
  if (conversationMode === 'mediator') {
    setState({ status: 'sending' });
    try {
      const assistantText = await sendMediatorTurn(sessionId, text);

      const autoSpeak = settings.voiceLocalAutoSpeakReplies !== false;
      if (!autoSpeak) {
        return;
      }

      const ttsBaseUrl = (settings.voiceLocalTtsBaseUrl ?? '').trim();
      if (!ttsBaseUrl) {
        return;
      }

      const ttsApiKey = settings.voiceLocalTtsApiKey ? (sync.decryptSecretValue(settings.voiceLocalTtsApiKey) ?? null) : null;
      const ttsModel = (settings.voiceLocalTtsModel ?? 'tts-1') as string;
      const ttsVoice = (settings.voiceLocalTtsVoice ?? 'alloy') as string;
      const ttsFormat = (settings.voiceLocalTtsFormat ?? 'mp3') as 'mp3' | 'wav';

      if (assistantText) {
        setState({ status: 'speaking' });
        await speakText({
          baseUrl: ttsBaseUrl,
          apiKey: ttsApiKey,
          model: ttsModel,
          voice: ttsVoice,
          format: ttsFormat,
          input: assistantText,
        }).catch(() => {});
      }
      return;
    } catch (error) {
      console.error('[localVoiceEngine] mediator turn failed', error);
      setState({ status: 'idle', sessionId: null, error: 'send_failed' });
      return;
    } finally {
      setState({ status: 'idle', sessionId: null });
    }
  }

  const baselineMessages = ((storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? []) as any[];
  const baselineCount = baselineMessages.length;
  const baselineIds = new Set<string>(baselineMessages.map((m: any) => m?.id).filter((id: any) => typeof id === 'string'));

  setState({ status: 'sending' });
  try {
    await sync.sendMessage(sessionId, text);
  } catch (error) {
    setState({ status: 'idle', sessionId: null, error: 'send_failed' });
    throw error;
  }

  // v1: if auto-speak is disabled, we're done after sending.
  // Speaking/waiting for assistant replies is handled when enabled.
  const autoSpeak = settings.voiceLocalAutoSpeakReplies !== false;
  if (!autoSpeak) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  const assistantText = await waitForNextAssistantTextMessage(sessionId, baselineIds, baselineCount, 60_000);
  if (!assistantText) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  const ttsBaseUrl = (settings.voiceLocalTtsBaseUrl ?? '').trim();
  if (!ttsBaseUrl) {
    setState({ status: 'idle', sessionId: null });
    return;
  }

  const ttsApiKey = settings.voiceLocalTtsApiKey ? (sync.decryptSecretValue(settings.voiceLocalTtsApiKey) ?? null) : null;
  const ttsModel = (settings.voiceLocalTtsModel ?? 'tts-1') as string;
  const ttsVoice = (settings.voiceLocalTtsVoice ?? 'alloy') as string;
  const ttsFormat = (settings.voiceLocalTtsFormat ?? 'mp3') as 'mp3' | 'wav';

  setState({ status: 'speaking' });
  await speakText({
    baseUrl: ttsBaseUrl,
    apiKey: ttsApiKey,
    model: ttsModel,
    voice: ttsVoice,
    format: ttsFormat,
    input: assistantText,
  }).catch(() => {});

  setState({ status: 'idle', sessionId: null });
}

async function getMediatorHandle(sessionId: string): Promise<MediatorHandle> {
  const existing = mediatorBySessionId.get(sessionId);
  if (existing) return existing;

  const settings: any = storage.getState().settings;
  const requestedBackend = (settings.voiceLocalMediatorBackend ?? 'daemon') as 'daemon' | 'openai_compat';
  const permissionPolicy = (settings.voiceMediatorPermissionPolicy ?? 'read_only') as 'no_tools' | 'read_only';
  const idleTtlSeconds = Number(settings.voiceMediatorIdleTtlSeconds ?? 300);
  const verbosity = (settings.voiceMediatorVerbosity ?? 'short') as 'short' | 'balanced';
  const agentSource = (settings.voiceMediatorAgentSource ?? 'session') as 'session' | 'agent';
  const agentId = agentSource === 'agent' ? (settings.voiceMediatorAgentId ?? 'claude') : null;

  const resolveModelIds = (backend: 'daemon' | 'openai_compat') => {
    if (backend === 'openai_compat') {
      const chatModelId = String(settings.voiceLocalChatChatModel ?? 'default');
      const commitModelId = String(settings.voiceLocalChatCommitModel ?? chatModelId);
      return { chatModelId, commitModelId };
    }

    const session = storage.getState().sessions?.[sessionId] ?? null;
    if (!session) {
      const chatModelId = String(settings.voiceMediatorChatModelId ?? 'default');
      const commitModelId = String(settings.voiceMediatorCommitModelId ?? chatModelId);
      return { chatModelId, commitModelId };
    }

    return resolveDaemonVoiceMediatorModelIds({
      session,
      settings,
    });
  };

  const initialContext = buildVoiceInitialContext(sessionId);

  const shouldFallbackFromDaemon = (e: unknown) => {
    const err: any = e;
    if (isRpcMethodNotAvailableError(err)) return true;
    if (typeof err?.rpcErrorCode === 'string' && err.rpcErrorCode === 'VOICE_MEDIATOR_UNSUPPORTED') return true;
    return false;
  };

  let backend: 'daemon' | 'openai_compat' = requestedBackend;
  let { chatModelId, commitModelId } = resolveModelIds(backend);
  let client: VoiceMediatorClient =
    backend === 'openai_compat'
      ? (openaiCompatMediatorClient ?? (openaiCompatMediatorClient = new OpenAiCompatMediatorClient()))
      : (daemonMediatorClient ?? (daemonMediatorClient = new DaemonMediatorClient()));

  const startArgs = {
    sessionId,
    agentSource,
    ...(typeof agentId === 'string' ? { agentId } : {}),
    verbosity,
    permissionPolicy,
    idleTtlSeconds,
    initialContext,
  };

  const started = await (async () => {
    try {
      return await client.start({
        ...startArgs,
        chatModelId,
        commitModelId,
      });
    } catch (e) {
      if (requestedBackend !== 'daemon') throw e;
      if (!shouldFallbackFromDaemon(e)) throw e;

      const baseUrl = String(settings.voiceLocalChatBaseUrl ?? '').trim();
      if (!baseUrl) throw e;

      backend = 'openai_compat';
      ({ chatModelId, commitModelId } = resolveModelIds(backend));
      client = openaiCompatMediatorClient ?? (openaiCompatMediatorClient = new OpenAiCompatMediatorClient());
      return await client.start({
        ...startArgs,
        chatModelId,
        commitModelId,
      });
    }
  })();

  const handle: MediatorHandle = { client, mediatorId: started.mediatorId, backend };
  mediatorBySessionId.set(sessionId, handle);
  return handle;
}

async function sendMediatorTurn(sessionId: string, userText: string): Promise<string> {
  const handle = await getMediatorHandle(sessionId);
  const pending = mediatorPendingContextBySessionId.get(sessionId) ?? [];
  if (pending.length > 0) {
    mediatorPendingContextBySessionId.delete(sessionId);
    userText = `Context updates since your last voice turn:\n\n${pending.join('\n\n---\n\n')}\n\nUser said:\n${userText}`;
  }
  const res = await handle.client.sendTurn({ sessionId, mediatorId: handle.mediatorId, userText });
  return res.assistantText;
}

export async function commitLocalVoiceMediator(sessionId: string): Promise<string> {
  const handle = await getMediatorHandle(sessionId);
  const res = await handle.client.commit({ sessionId, mediatorId: handle.mediatorId, kind: 'session_instruction' });
  return res.commitText;
}

export async function stopLocalVoiceMediator(sessionId: string): Promise<void> {
  const handle = mediatorBySessionId.get(sessionId);
  if (!handle) return;
  mediatorBySessionId.delete(sessionId);
  mediatorPendingContextBySessionId.delete(sessionId);
  try {
    await handle.client.stop({ sessionId, mediatorId: handle.mediatorId });
  } catch {
    // best-effort only
  }
}

export function isLocalVoiceMediatorActive(sessionId: string): boolean {
  return mediatorBySessionId.has(sessionId);
}

export function appendLocalVoiceMediatorContextUpdate(sessionId: string, update: string): void {
  const text = update.trim();
  if (!text) return;
  const existing = mediatorPendingContextBySessionId.get(sessionId) ?? [];
  existing.push(text);
  // Bound memory: keep only the last few updates.
  const capped = existing.slice(Math.max(0, existing.length - 8));
  mediatorPendingContextBySessionId.set(sessionId, capped);
}

export async function toggleLocalVoiceTurn(sessionId: string): Promise<void> {
  if (inFlight) {
    await inFlight;
  }

  const current = getLocalVoiceState();
  if (current.status === 'idle') {
    inFlight = startRecording(sessionId).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    if (current.sessionId !== sessionId) {
      return;
    }
    inFlight = stopAndSend(sessionId).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
}

async function waitForNextAssistantTextMessage(
  sessionId: string,
  baselineIds: Set<string>,
  baselineCount: number,
  timeoutMs: number
): Promise<string | null> {
  return await new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: null | (() => void) = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      try {
        unsubscribe?.();
      } catch {
        // Best-effort cleanup; ignore unsubscribe errors.
      }
      unsubscribe = null;
    };

    const done = (text: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };

    const check = () => {
      try {
        const messages = (storage.getState() as any).sessionMessages?.[sessionId]?.messages ?? [];
        const startIndex = messages.length >= baselineCount ? baselineCount : 0;
        for (let idx = startIndex; idx < messages.length; idx++) {
          const m = messages[idx];
          if (m?.kind !== 'agent-text') continue;
          if (typeof m?.text !== 'string') continue;
          if (typeof m?.id === 'string' && baselineIds.has(m.id)) continue;
          done(m.text);
          return;
        }
      } catch {
        done(null);
      }
    };

    timeout = setTimeout(() => done(null), timeoutMs);
    try {
      unsubscribe = storage.subscribe(check);
    } catch {
      done(null);
      return;
    }
    check();
  });
}

async function speakText(opts: {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  voice: string;
  format: 'mp3' | 'wav';
  input: string;
}): Promise<void> {
  const buffer = await fetchOpenAiCompatSpeechAudio({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    voice: opts.voice,
    format: opts.format,
    input: opts.input,
  });

  if (Platform.OS === 'web') {
    const blob = new Blob([buffer], { type: opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const player = createAudioPlayer(url);
    let subscription: { remove(): void } | null = null;
    const cleanup = () => {
      try {
        subscription?.remove();
      } catch {
        // ignore
      }
      subscription = null;
      try {
        player.remove();
      } catch {
        // ignore
      }
      URL.revokeObjectURL(url);
    };

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const safeReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      subscription = player.addListener('playbackStatusUpdate', (status: any) => {
        if (status?.didJustFinish) {
          cleanup();
          safeResolve();
        }
      });

      try {
        player.play();
      } catch (error) {
        cleanup();
        safeReject(error);
      }
    });
  }

  const ext = opts.format === 'wav' ? '.wav' : '.mp3';
  const { File, Paths, deleteAsync } = await import('expo-file-system');
  const file = new File(Paths.cache, `happier-voice-${Date.now()}${ext}`);
  await file.write(new Uint8Array(buffer));

  const player = createAudioPlayer(file.uri);
  let subscription: { remove(): void } | null = null;
  const cleanup = async () => {
    try {
      subscription?.remove();
    } catch {
      // ignore
    }
    subscription = null;
    try {
      player.remove();
    } catch {
      // ignore
    }
    try {
      await deleteAsync(file.uri, { idempotent: true });
    } catch {
      // ignore
    }
  };

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const safeReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    subscription = player.addListener('playbackStatusUpdate', (status: any) => {
      if (!status?.didJustFinish) return;
      void cleanup()
        .then(() => safeResolve())
        .catch((e) => safeReject(e));
    });

    try {
      player.play();
    } catch (error) {
      void cleanup()
        .then(() => safeReject(error))
        .catch(() => safeReject(error));
    }
  });
}
