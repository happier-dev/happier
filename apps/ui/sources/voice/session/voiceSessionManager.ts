import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';
import { getVoiceSessionSnapshot, setVoiceSessionSnapshot } from './voiceSessionStore';

export type VoiceSessionManager = Readonly<{
  toggle: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  sendContextUpdate: (sessionId: string, update: string) => void;
  getSnapshot: () => VoiceSessionSnapshot;
}>;

export function createVoiceSessionManager(deps: Readonly<{
  resolveActiveAdapterId: () => VoiceAdapterId | 'off';
  getAdapter: (adapterId: VoiceAdapterId) => VoiceAdapterController | null;
}>): VoiceSessionManager {
  const refreshFromAdapter = (adapter: VoiceAdapterController | null) => {
    if (!adapter) return;
    setVoiceSessionSnapshot(adapter.getSnapshot());
  };

  const resolveActiveAdapter = (): VoiceAdapterController | null => {
    const adapterId = deps.resolveActiveAdapterId();
    if (adapterId === 'off') return null;
    return deps.getAdapter(adapterId);
  };

  const ensureAdapterSnapshotFallback = (adapterId: VoiceAdapterId, sessionId: string) => {
    const current = getVoiceSessionSnapshot();
    if (current.adapterId === adapterId && current.sessionId === sessionId) return;
    setVoiceSessionSnapshot({
      adapterId,
      sessionId,
      status: 'connecting',
      mode: 'idle',
      canStop: true,
    });
  };

  const toggle = async (sessionId: string) => {
    const snap = getVoiceSessionSnapshot();
    const adapterId = deps.resolveActiveAdapterId();
    // If voice is currently active but settings flipped to off, allow toggle to hang up.
    if (adapterId === 'off') {
      if (snap.status !== 'disconnected') {
        await stop(snap.sessionId ?? sessionId);
      }
      return;
    }
    const adapter = deps.getAdapter(adapterId);
    if (!adapter) return;

    // Give UI immediate feedback even if adapter takes time to transition.
    ensureAdapterSnapshotFallback(adapterId, sessionId);

    await adapter.toggle({ sessionId });
    refreshFromAdapter(adapter);
  };

  const stop = async (sessionId: string) => {
    const snap = getVoiceSessionSnapshot();
    if (snap.status === 'disconnected') return;
    if (!snap.adapterId) {
      setVoiceSessionSnapshot({
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
      return;
    }

    const adapter = deps.getAdapter(snap.adapterId);
    if (!adapter) {
      setVoiceSessionSnapshot({
        adapterId: null,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
      });
      return;
    }

    await adapter.stop({ sessionId });
    refreshFromAdapter(adapter);
  };

  const interrupt = async (sessionId: string) => {
    const snap = getVoiceSessionSnapshot();
    if (!snap.adapterId) return;
    const adapter = deps.getAdapter(snap.adapterId);
    if (!adapter) return;
    await adapter.interrupt({ sessionId });
    refreshFromAdapter(adapter);
  };

  const sendContextUpdate = (sessionId: string, update: string) => {
    const adapter = resolveActiveAdapter();
    if (!adapter) return;
    adapter.sendContextUpdate({ sessionId, update });
  };

  return {
    toggle,
    stop,
    interrupt,
    sendContextUpdate,
    getSnapshot: () => getVoiceSessionSnapshot(),
  };
}
