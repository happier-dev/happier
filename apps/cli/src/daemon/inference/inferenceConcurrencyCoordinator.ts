export type InferenceConcurrencyCoordinator = Readonly<{
  runExclusive: <T>(modelId: string, work: () => Promise<T>, options?: InferenceConcurrencyRunOptions) => Promise<T>;
  runLifecycleExclusive: <T>(modelId: string, work: () => Promise<T>, options?: InferenceConcurrencyRunOptions) => Promise<T>;
}>;

export type InferenceConcurrencyRunOptions = Readonly<{
  signal?: AbortSignal | null;
}>;

type ModelConcurrencyState = {
  activeShared: number;
  exclusiveActive: boolean;
  waiters: Array<{
    mode: 'shared' | 'exclusive';
    resolve: () => void;
    cleanup: () => void;
  }>;
};

function createInferenceCancelledError(): Error {
  return Object.assign(new Error('inference_cancelled'), { code: 'cancelled' });
}

function normalizePerModelConcurrency(input: number | null | undefined): number {
  if (!Number.isFinite(input)) {
    return 1;
  }
  return Math.max(1, Math.trunc(input as number));
}

export function createInferenceConcurrencyCoordinator(params?: Readonly<{
  perModelConcurrency?: number | null;
}>): InferenceConcurrencyCoordinator {
  const perModelConcurrency = normalizePerModelConcurrency(params?.perModelConcurrency);
  const stateByModelId = new Map<string, ModelConcurrencyState>();

  function getOrCreateState(modelId: string): ModelConcurrencyState {
    const existing = stateByModelId.get(modelId);
    if (existing) {
      return existing;
    }
    const created: ModelConcurrencyState = {
      activeShared: 0,
      exclusiveActive: false,
      waiters: [],
    };
    stateByModelId.set(modelId, created);
    return created;
  }

  function maybeDeleteState(modelId: string, state: ModelConcurrencyState): void {
    if (!state.exclusiveActive && state.activeShared === 0 && state.waiters.length === 0) {
      stateByModelId.delete(modelId);
    }
  }

  function drainWaiters(modelId: string, state: ModelConcurrencyState): void {
    if (state.exclusiveActive) {
      return;
    }
    if (state.waiters.length === 0) {
      maybeDeleteState(modelId, state);
      return;
    }

    const nextWaiter = state.waiters[0];
    if (!nextWaiter) {
      maybeDeleteState(modelId, state);
      return;
    }

    if (nextWaiter.mode === 'exclusive') {
      if (state.activeShared > 0) {
        return;
      }
      state.waiters.shift();
      state.exclusiveActive = true;
      nextWaiter.cleanup();
      nextWaiter.resolve();
      return;
    }

    if (state.activeShared >= perModelConcurrency) {
      return;
    }

    while (state.waiters[0]?.mode === 'shared' && state.activeShared < perModelConcurrency && !state.exclusiveActive) {
      const waiter = state.waiters.shift();
      if (!waiter) {
        break;
      }
      state.activeShared += 1;
      waiter.cleanup();
      waiter.resolve();
    }
  }

  function rejectIfAborted(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) {
      throw createInferenceCancelledError();
    }
  }

  async function waitForTurn(
    modelId: string,
    state: ModelConcurrencyState,
    mode: 'shared' | 'exclusive',
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    rejectIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let waiter: ModelConcurrencyState['waiters'][number] | null = null;
      let abortListener: (() => void) | null = null;
      const cleanup = () => {
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
      };
      abortListener = () => {
        if (!waiter) {
          return;
        }
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) {
          state.waiters.splice(index, 1);
          cleanup();
          reject(createInferenceCancelledError());
          drainWaiters(modelId, state);
          maybeDeleteState(modelId, state);
        }
      };
      waiter = {
        mode,
        resolve,
        cleanup,
      };
      if (signal) {
        signal.addEventListener('abort', abortListener, { once: true });
      }
      state.waiters.push(waiter);
    });
  }

  async function runShared<T>(modelId: string, work: () => Promise<T>, options?: InferenceConcurrencyRunOptions): Promise<T> {
    const signal = options?.signal ?? null;
    rejectIfAborted(signal);
    const state = getOrCreateState(modelId);
    if (!state.exclusiveActive && state.waiters.length === 0 && state.activeShared < perModelConcurrency) {
      state.activeShared += 1;
    } else {
      await waitForTurn(modelId, state, 'shared', signal);
    }

    try {
      rejectIfAborted(signal);
      return await work();
    } finally {
      state.activeShared = Math.max(0, state.activeShared - 1);
      drainWaiters(modelId, state);
      maybeDeleteState(modelId, state);
    }
  }

  async function runLifecycleExclusive<T>(modelId: string, work: () => Promise<T>, options?: InferenceConcurrencyRunOptions): Promise<T> {
    const signal = options?.signal ?? null;
    rejectIfAborted(signal);
    const state = getOrCreateState(modelId);
    if (!state.exclusiveActive && state.activeShared === 0 && state.waiters.length === 0) {
      state.exclusiveActive = true;
    } else {
      await waitForTurn(modelId, state, 'exclusive', signal);
    }

    try {
      rejectIfAborted(signal);
      return await work();
    } finally {
      state.exclusiveActive = false;
      drainWaiters(modelId, state);
      maybeDeleteState(modelId, state);
    }
  }

  return {
    runExclusive: async <T>(modelId: string, work: () => Promise<T>, options?: InferenceConcurrencyRunOptions): Promise<T> => await runShared(modelId, work, options),
    runLifecycleExclusive,
  };
}
