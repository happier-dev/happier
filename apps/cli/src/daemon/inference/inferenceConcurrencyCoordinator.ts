export type InferenceConcurrencyCoordinator = Readonly<{
  runExclusive: <T>(modelId: string, work: () => Promise<T>) => Promise<T>;
  runLifecycleExclusive: <T>(modelId: string, work: () => Promise<T>) => Promise<T>;
}>;

type ModelConcurrencyState = {
  activeShared: number;
  exclusiveActive: boolean;
  waiters: Array<Readonly<{
    mode: 'shared' | 'exclusive';
    resolve: () => void;
  }>>;
};

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
      waiter.resolve();
    }
  }

  async function runShared<T>(modelId: string, work: () => Promise<T>): Promise<T> {
    const state = getOrCreateState(modelId);
    if (!state.exclusiveActive && state.waiters.length === 0 && state.activeShared < perModelConcurrency) {
      state.activeShared += 1;
    } else {
      await new Promise<void>((resolve) => {
        state.waiters.push({
          mode: 'shared',
          resolve,
        });
      });
    }

    try {
      return await work();
    } finally {
      state.activeShared = Math.max(0, state.activeShared - 1);
      drainWaiters(modelId, state);
      maybeDeleteState(modelId, state);
    }
  }

  async function runLifecycleExclusive<T>(modelId: string, work: () => Promise<T>): Promise<T> {
    const state = getOrCreateState(modelId);
    if (!state.exclusiveActive && state.activeShared === 0 && state.waiters.length === 0) {
      state.exclusiveActive = true;
    } else {
      await new Promise<void>((resolve) => {
        state.waiters.push({
          mode: 'exclusive',
          resolve,
        });
      });
    }

    try {
      return await work();
    } finally {
      state.exclusiveActive = false;
      drainWaiters(modelId, state);
      maybeDeleteState(modelId, state);
    }
  }

  return {
    runExclusive: async <T>(modelId: string, work: () => Promise<T>): Promise<T> => await runShared(modelId, work),
    runLifecycleExclusive,
  };
}
