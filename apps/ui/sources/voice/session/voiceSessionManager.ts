import type { VoiceSessionSnapshot } from './types';
import { getVoiceSessionSnapshot, getVoiceSessionPresentedAttemptId } from './voiceSessionStore';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';

export type VoiceSessionManager = Readonly<{
  bargeIn: (sessionId: string) => Promise<void>;
  retry: (sessionId: string) => Promise<void>;
  dismissFailedAttempt: (sessionId: string | null) => Promise<void>;
  toggle: (targetSessionAddress: SessionAddress | null) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  commitInput: (sessionId: string) => Promise<void>;
  beginHoldToTalk: (sessionId: string) => VoiceHeldInput | null;
  finishHoldToTalk: (sessionId: string, outcome: 'release' | 'cancel') => Promise<boolean>;
  getAttemptTargetSessionAddress: () => SessionAddress | null;
  matchesAttempt: (attemptId: string | null) => boolean;
  setMuted: (sessionId: string, muted: boolean) => Promise<void>;
  sendContextUpdate: (sessionId: string, update: string) => void;
  getSnapshot: () => VoiceSessionSnapshot;
}>;

export function createVoiceSessionManager(deps: Readonly<{
  getLifecycleController?: () => VoiceSessionLifecycleController | null;
}>): VoiceSessionManager {
  const resolveLifecycleController = (): VoiceSessionLifecycleController | null => deps.getLifecycleController?.() ?? null;

  const toggle = async (targetSessionAddress: SessionAddress | null) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.toggle(targetSessionAddress);
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

  const commitInput = async (sessionId: string) => {
    await resolveLifecycleController()?.commitInput(sessionId);
  };

  const sendContextUpdate = (sessionId: string, update: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    lifecycleController.sendContextUpdate(sessionId, update);
  };

  return {
    bargeIn,
    retry,
    dismissFailedAttempt: async (sessionId) => {
      await resolveLifecycleController()?.dismissFailedAttempt(sessionId);
    },
    toggle,
    stop,
    interrupt,
    commitInput,
    beginHoldToTalk: (sessionId) => resolveLifecycleController()?.beginHoldToTalk(sessionId) ?? null,
    finishHoldToTalk: async (sessionId, outcome) => await resolveLifecycleController()?.finishHoldToTalk(sessionId, outcome) ?? false,
    getAttemptTargetSessionAddress: () => resolveLifecycleController()?.getAttemptTargetSessionAddress() ?? null,
    matchesAttempt: (attemptId) => getVoiceSessionPresentedAttemptId() === attemptId,
    setMuted,
    sendContextUpdate,
    getSnapshot: () => resolveLifecycleController()?.getSnapshot() ?? getVoiceSessionSnapshot(),
  };
}
