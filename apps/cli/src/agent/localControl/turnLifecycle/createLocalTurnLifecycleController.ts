import type {
  LocalTurnLifecycleController,
  LocalTurnLifecycleEvent,
  LocalTurnLifecycleSnapshot,
  LocalTurnTerminalReason,
} from './localTurnLifecycleTypes';

type Waiter = Readonly<{
  resolve: (snapshot: LocalTurnLifecycleSnapshot) => void;
  reject: (error: Error) => void;
  abortSignal: AbortSignal | null;
  onAbort: (() => void) | null;
}>;

type MutableLifecycleState = {
  active: boolean;
  terminal: boolean;
  waitingForQuiescence: boolean;
  providerTurnId: string | null;
  lastTerminalReason: LocalTurnTerminalReason | null;
};

export function createLocalTurnLifecycleController(opts: Readonly<{
  completionQuiescenceMs: number;
}>): LocalTurnLifecycleController {
  const completionQuiescenceMs = Math.max(0, Math.floor(opts.completionQuiescenceMs));
  const state: MutableLifecycleState = {
    active: false,
    terminal: false,
    waitingForQuiescence: false,
    providerTurnId: null,
    lastTerminalReason: null,
  };
  const waiters: Waiter[] = [];
  let quiescenceTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const snapshot = (): LocalTurnLifecycleSnapshot => ({
    active: state.active,
    terminal: state.terminal,
    waitingForQuiescence: state.waitingForQuiescence,
    providerTurnId: state.providerTurnId,
    lastTerminalReason: state.lastTerminalReason,
  });

  const isSafeForRemoteHandoff = (): boolean => !state.active || state.terminal;

  const clearQuiescenceTimer = (): void => {
    if (!quiescenceTimer) return;
    clearTimeout(quiescenceTimer);
    quiescenceTimer = null;
  };

  const removeWaiter = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    if (waiter.abortSignal && waiter.onAbort) {
      waiter.abortSignal.removeEventListener('abort', waiter.onAbort);
    }
  };

  const resolveSafeWaiters = (): void => {
    if (!isSafeForRemoteHandoff()) return;
    const current = snapshot();
    for (const waiter of waiters.splice(0)) {
      if (waiter.abortSignal && waiter.onAbort) {
        waiter.abortSignal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(current);
    }
  };

  const markTerminal = (reason: LocalTurnTerminalReason, providerTurnId?: string | null): void => {
    if (state.terminal && !state.active) {
      resolveSafeWaiters();
      return;
    }
    clearQuiescenceTimer();
    state.active = false;
    state.terminal = true;
    state.waitingForQuiescence = false;
    state.providerTurnId = providerTurnId ?? state.providerTurnId;
    state.lastTerminalReason = reason;
    resolveSafeWaiters();
  };

  const settleCompletionCandidate = (): void => {
    quiescenceTimer = null;
    if (!state.waitingForQuiescence) return;
    markTerminal('completed', state.providerTurnId);
  };

  const observe = (event: LocalTurnLifecycleEvent): void => {
    if (disposed) return;

    if (event.type === 'turn_started') {
      clearQuiescenceTimer();
      state.active = true;
      state.terminal = false;
      state.waitingForQuiescence = false;
      state.providerTurnId = event.providerTurnId ?? null;
      state.lastTerminalReason = null;
      return;
    }

    if (event.type === 'completion_candidate') {
      clearQuiescenceTimer();
      state.active = true;
      state.terminal = false;
      state.waitingForQuiescence = true;
      state.providerTurnId = event.providerTurnId ?? state.providerTurnId;
      state.lastTerminalReason = null;
      if (completionQuiescenceMs === 0) {
        settleCompletionCandidate();
        return;
      }
      quiescenceTimer = setTimeout(settleCompletionCandidate, completionQuiescenceMs);
      quiescenceTimer.unref?.();
      return;
    }

    if (event.type === 'continuation_detected') {
      clearQuiescenceTimer();
      state.active = true;
      state.terminal = false;
      state.waitingForQuiescence = false;
      state.providerTurnId = event.providerTurnId ?? state.providerTurnId;
      state.lastTerminalReason = null;
      return;
    }

    if (event.type === 'turn_terminal') {
      markTerminal(event.reason, event.providerTurnId ?? null);
      return;
    }

    if (event.type === 'session_ended' && state.active) {
      markTerminal('session-ended', state.providerTurnId);
    }
  };

  const waitForSafeRemoteHandoff = (abortSignal?: AbortSignal): Promise<LocalTurnLifecycleSnapshot> => {
    if (isSafeForRemoteHandoff()) {
      return Promise.resolve(snapshot());
    }
    if (abortSignal?.aborted) {
      return Promise.reject(new Error('Local turn lifecycle wait aborted'));
    }
    return new Promise<LocalTurnLifecycleSnapshot>((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = abortSignal
        ? () => {
            removeWaiter(waiter);
            reject(new Error('Local turn lifecycle wait aborted'));
          }
        : null;
      waiter = {
        resolve,
        reject,
        abortSignal: abortSignal ?? null,
        onAbort,
      };
      waiters.push(waiter);
      if (abortSignal && onAbort) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  const dispose = (): void => {
    disposed = true;
    clearQuiescenceTimer();
    for (const waiter of waiters.splice(0)) {
      if (waiter.abortSignal && waiter.onAbort) {
        waiter.abortSignal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new Error('Local turn lifecycle disposed'));
    }
  };

  return {
    observe,
    snapshot,
    waitForSafeRemoteHandoff,
    dispose,
  };
}
