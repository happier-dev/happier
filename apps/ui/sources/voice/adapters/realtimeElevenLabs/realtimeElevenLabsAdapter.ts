import { voiceHooks } from '@/voice/context/voiceHooks';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';

export function createRealtimeElevenLabsVoiceAdapter(): VoiceAdapterController {
  const id = 'realtime_elevenlabs';

  const getSnapshot = (): VoiceSessionSnapshot => realtimeTransport.getSessionSnapshot();

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

  const subscribe = (listener: () => void) => realtimeTransport.subscribe(listener);

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
  };
}
