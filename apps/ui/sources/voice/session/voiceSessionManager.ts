import type { VoiceSessionSnapshot } from './types';
import { getVoiceSessionSnapshot, getVoiceSessionPresentedAttemptId } from './voiceSessionStore';
import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { VoiceConversationSelection } from '@/voice/binding/voiceConversationBindingTypes';
import type { VoiceHeldInput } from '@/voice/runtime/controller/VoiceConversationController';

export type VoiceSessionManager = Readonly<{
  bargeIn: (sessionId: string) => Promise<void>;
  retry: (sessionId: string) => Promise<void>;
  dismissFailedAttempt: (sessionId: string | null) => Promise<void>;
  toggle: (targetSessionAddress: SessionAddress | null, conversationSelection?: VoiceConversationSelection) => Promise<void>;
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
  getRuntimeRetryTarget?: () => SessionAddress | null;
  requestRuntime?: (target: SessionAddress | null, signal: AbortSignal) => Readonly<{
    ready: Promise<VoiceSessionLifecycleController | null>;
    adopt: (snapshot: VoiceSessionSnapshot) => void;
    dispose: (error?: unknown) => void;
  }> | null;
}>): VoiceSessionManager {
  const resolveLifecycleController = (): VoiceSessionLifecycleController | null => deps.getLifecycleController?.() ?? null;
  let preparing: Readonly<{ cancellation: AbortController; target: SessionAddress | null }> | null = null;

  const toggle = async (targetSessionAddress: SessionAddress | null, conversationSelection?: VoiceConversationSelection) => {
    if (preparing) {
      preparing.cancellation.abort();
      return;
    }
    if (deps.requestRuntime && !getVoiceSessionSnapshot().canStop) {
      const request = { cancellation: new AbortController(), target: targetSessionAddress };
      preparing = request;
      const runtime = deps.requestRuntime(targetSessionAddress, request.cancellation.signal);
      if (!runtime) { preparing = null; return; }
      try {
        const lifecycle = await runtime.ready.catch((error: unknown) => {
          runtime.dispose(error);
          return null;
        });
        if (!lifecycle || request.cancellation.signal.aborted) return;
        // toggle synchronously admits this Start before handing presentation to its owner.
        const starting = lifecycle.toggle(targetSessionAddress, conversationSelection);
        runtime.adopt(lifecycle.getSnapshot());
        preparing = null;
        await starting;
      } finally {
        if (preparing === request) preparing = null;
        runtime.dispose();
      }
      return;
    }
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.toggle(targetSessionAddress, conversationSelection);
  };

  const bargeIn = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) return;
    await lifecycleController.bargeIn(sessionId);
  };

  const retry = async (sessionId: string) => {
    const lifecycleController = resolveLifecycleController();
    if (!lifecycleController) {
      const snapshot = getVoiceSessionSnapshot();
      if (snapshot.sessionId === sessionId && snapshot.errorRecoveryAction === 'retry') {
        await toggle(deps.getRuntimeRetryTarget?.() ?? null);
      }
      return;
    }
    await lifecycleController.retry(sessionId);
  };

  const stop = async (sessionId: string) => {
    preparing?.cancellation.abort();
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
    getAttemptTargetSessionAddress: () => preparing?.target ?? resolveLifecycleController()?.getAttemptTargetSessionAddress() ?? null,
    matchesAttempt: (attemptId) => getVoiceSessionPresentedAttemptId() === attemptId,
    setMuted,
    sendContextUpdate,
    getSnapshot: () => preparing ? getVoiceSessionSnapshot() : resolveLifecycleController()?.getSnapshot() ?? getVoiceSessionSnapshot(),
  };
}
