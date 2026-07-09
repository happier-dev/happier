import { voiceHooks } from '@/voice/context/voiceHooks';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  getVoiceConversationRuntimeSnapshot,
  useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';

export function createRealtimeElevenLabsVoiceAdapter(): VoiceAdapterController {
  const id = 'realtime_elevenlabs';

  // The runtime machine is the single source of truth for the realtime
  // lifecycle: the transport drives machine transitions and the adapter
  // projects the machine snapshot for this adapter id (mirroring the local
  // adapters). The transport no longer keeps a private session snapshot.
  const getSnapshot = (): VoiceSessionSnapshot =>
    deriveLocalVoiceSessionSnapshot(id, getVoiceConversationRuntimeSnapshot());

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    const initialContext = opts.initialContext ?? voiceHooks.onVoiceStarted(opts.sessionId);
    await realtimeTransport.startRealtimeSession(opts.sessionId, initialContext);
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await realtimeTransport.stopRealtimeSession();
    voiceHooks.onVoiceStopped();
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => start(opts);

  const interrupt = async (_opts: Readonly<{ sessionId: string }>) => {
    await stop(_opts);
  };

  const setMuted = async (opts: Readonly<{ sessionId: string; muted: boolean }>) => {
    void opts.sessionId;
    realtimeTransport.setMicMuted(opts.muted);
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    const voice = realtimeTransport.getVoiceSession();
    if (!voice || !realtimeTransport.isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(opts.update);
  };

  const sendTextTurn = async (opts: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) => {
    void opts.conversationSessionId;
    if (!realtimeTransport.isVoiceSessionStarted()) {
      await realtimeTransport.startRealtimeSession(opts.controlSessionId, undefined, false, { textOnly: true });
    }
    const voice = realtimeTransport.getVoiceSession();
    if (!voice) {
      throw new Error('voice_service_unavailable');
    }
    voice.sendTextMessage(opts.text);
  };

  const subscribe = (listener: () => void) =>
    useVoiceConversationRuntimeStore.subscribe(() => listener());

  // Realtime speech-to-speech always projects a synthetic transcript: the
  // provider streams audio, so UI-side turns are reconstructed locally.
  const resolveBindingTranscriptMode = () => 'synthetic' as const;

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    setMuted,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe,
    resolveBindingTranscriptMode,
  };
}
