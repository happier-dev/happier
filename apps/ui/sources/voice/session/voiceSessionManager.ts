import type { VoiceSessionSnapshot } from './types';
import { getVoiceSessionSnapshot } from './voiceSessionStore';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

export type VoiceSessionManager = Readonly<{
  bargeIn: (sessionId: string) => Promise<void>;
  retry: (sessionId: string) => Promise<void>;
  toggle: (sessionId: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  setMuted: (sessionId: string, muted: boolean) => Promise<void>;
  sendContextUpdate: (sessionId: string, update: string) => void;
  getSnapshot: () => VoiceSessionSnapshot;
}>;

export function createVoiceSessionManager(deps: Readonly<{
  getLifecycleController?: () => VoiceSessionLifecycleController | null;
}>): VoiceSessionManager {
  const resolveLifecycleController = (): VoiceSessionLifecycleController | null => deps.getLifecycleController?.() ?? null;

  const toggle = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.toggle(sessionId);
  };

  const bargeIn = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.bargeIn(sessionId);
  };

  const retry = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.retry(sessionId);
  };

  const stop = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.stop(sessionId);
  };

  const interrupt = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.interrupt(sessionId);
  };

  const setMuted = async (sessionId: string, muted: boolean) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.setMuted(sessionId, muted);
  };

  const sendContextUpdate = (sessionId: string, update: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    lifecycleController.sendContextUpdate(sessionId, update);
  };

  return {
    bargeIn,
    retry,
    toggle,
    stop,
    interrupt,
    setMuted,
    sendContextUpdate,
    getSnapshot: () => resolveLifecycleController()?.getSnapshot() ?? getVoiceSessionSnapshot(),
  };
}
