import { voiceHooks } from '@/voice/context/voiceHooks';
import {
  getVoiceSession,
  isVoiceSessionStarted,
  startRealtimeSession,
  stopRealtimeSession,
} from '@/realtime/RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import type { VoiceAdapterController, VoiceSessionMode, VoiceSessionSnapshot, VoiceSessionStatus } from '@/voice/session/types';

function mapRealtimeStatus(status: any): VoiceSessionStatus {
  if (status === 'connecting' || status === 'connected' || status === 'error') return status;
  return 'disconnected';
}

function mapRealtimeMode(mode: any): VoiceSessionMode {
  if (mode === 'speaking') return 'speaking';
  return 'idle';
}

export function createRealtimeElevenLabsVoiceAdapter(): VoiceAdapterController {
  const id = 'realtime_elevenlabs';

  const getSnapshot = (): VoiceSessionSnapshot => {
    const state: any = storage.getState();
    const status = mapRealtimeStatus(state?.realtimeStatus);
    const mode = mapRealtimeMode(state?.realtimeMode);
    return {
      adapterId: id,
      // Realtime voice is account-scoped; the connection is not owned by any single session.
      sessionId: null,
      status,
      mode,
      canStop: status === 'connected' || status === 'connecting',
    };
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    const initialContext = opts.initialContext ?? voiceHooks.onVoiceStarted(opts.sessionId);
    await startRealtimeSession(opts.sessionId, initialContext);
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await stopRealtimeSession();
    voiceHooks.onVoiceStopped();
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    const snap = getSnapshot();
    if (snap.status === 'connecting') {
      return;
    }
    if (snap.status === 'connected') {
      await stop({ sessionId: opts.sessionId });
      return;
    }
    await start({ sessionId: opts.sessionId });
  };

  const interrupt = async (_opts: Readonly<{ sessionId: string }>) => {
    // Realtime voice supports a call-like UX; for now interrupt == stop.
    const snap = getSnapshot();
    if (snap.status === 'connected' || snap.status === 'connecting') {
      await stopRealtimeSession().catch(() => {});
      voiceHooks.onVoiceStopped();
    }
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(opts.update);
  };

  const subscribe = (listener: () => void) => {
    return storage.subscribe((state: any, prevState: any) => {
      if (state?.realtimeStatus !== prevState?.realtimeStatus) {
        listener();
        return;
      }
      if (state?.realtimeMode !== prevState?.realtimeMode) {
        listener();
      }
    });
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate,
    getSnapshot,
    subscribe,
  };
}
