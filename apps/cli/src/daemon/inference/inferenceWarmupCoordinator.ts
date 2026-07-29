type InferenceWarmEntry<TModel> = Readonly<{
  model: TModel;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  residentBytes: number;
  lastUsedTick: number;
}>;

export type InferenceWarmupCoordinator<TModel> = Readonly<{
  warm: (modelId: string, loader: () => Promise<TModel>) => Promise<TModel>;
  release: (modelId: string, options?: Readonly<{ skipOnRelease?: boolean }>) => Promise<void>;
  isWarm: (modelId: string) => boolean;
  /** Total resident bytes across currently warm models (0 when no budget is configured). */
  residentBytes: () => number;
}>;

/**
 * Coordinates warm-model residency for a single inference owner.
 *
 * Two independent eviction pressures act on the warm set:
 *  - Idle residency: a per-model timer releases a model after `residencyMs` of no use.
 *  - Memory budget: when `maxResidentBytes` is positive, loading a new model evicts the
 *    least-recently-used resident model(s) until the total resident footprint is within
 *    budget. A model reported as in-use (`isInUse`) is never evicted mid-inference.
 *
 * `maxResidentBytes <= 0` (the default) disables the memory budget entirely.
 */
export function createInferenceWarmupCoordinator<TModel>(params?: Readonly<{
  residencyMs?: number;
  maxResidentBytes?: number;
  resolveResidentBytes?: (modelId: string, model: TModel) => number;
  isInUse?: (modelId: string) => boolean;
  scheduleRelease?: typeof setTimeout;
  cancelRelease?: typeof clearTimeout;
  onRelease?: (modelId: string, model: TModel) => Promise<void> | void;
}>): InferenceWarmupCoordinator<TModel> {
  const residencyMs = params?.residencyMs ?? Number.POSITIVE_INFINITY;
  const maxResidentBytes = params?.maxResidentBytes ?? 0;
  const resolveResidentBytes = params?.resolveResidentBytes ?? (() => 0);
  const isInUse = params?.isInUse ?? (() => false);
  const scheduleRelease = params?.scheduleRelease ?? setTimeout;
  const cancelRelease = params?.cancelRelease ?? clearTimeout;
  const onRelease = params?.onRelease;
  const warmByModelId = new Map<string, Promise<TModel>>();
  const readyByModelId = new Map<string, InferenceWarmEntry<TModel>>();
  const releaseVersionByModelId = new Map<string, number>();
  let useTick = 0;

  function nextUseTick(): number {
    useTick += 1;
    return useTick;
  }

  function readReleaseVersion(modelId: string): number {
    return releaseVersionByModelId.get(modelId) ?? 0;
  }

  function currentResidentBytes(): number {
    let total = 0;
    for (const entry of readyByModelId.values()) {
      total += entry.residentBytes;
    }
    return total;
  }

  function schedule(modelId: string, model: TModel): ReturnType<typeof setTimeout> | null {
    if (!Number.isFinite(residencyMs)) {
      return null;
    }

    return scheduleRelease(() => {
      // Defense-in-depth (L2): the idle timer must never evict a model mid-inference. If a lease is
      // active when the timer fires, re-arm it for another residency window instead of releasing —
      // symmetric with the memory-budget LRU's isInUse skip. The model is freed only once genuinely
      // idle. lastUsedTick is preserved so re-arming does not falsely refresh LRU recency.
      const current = readyByModelId.get(modelId);
      if (current && isInUse(modelId)) {
        readyByModelId.set(modelId, {
          model: current.model,
          releaseTimer: schedule(modelId, current.model),
          residentBytes: current.residentBytes,
          lastUsedTick: current.lastUsedTick,
        });
        return;
      }
      readyByModelId.delete(modelId);
      void Promise.resolve(onRelease?.(modelId, model)).catch(() => undefined);
    }, residencyMs);
  }

  function reschedule(modelId: string, model: TModel): void {
    const current = readyByModelId.get(modelId);
    if (current?.releaseTimer) {
      cancelRelease(current.releaseTimer);
    }
    readyByModelId.set(modelId, {
      model,
      releaseTimer: schedule(modelId, model),
      residentBytes: Math.max(0, Math.trunc(resolveResidentBytes(modelId, model))),
      lastUsedTick: nextUseTick(),
    });
  }

  function enforceMemoryBudget(): void {
    if (maxResidentBytes <= 0) {
      return;
    }
    while (currentResidentBytes() > maxResidentBytes) {
      let lruModelId: string | null = null;
      let lruEntry: InferenceWarmEntry<TModel> | null = null;
      for (const [modelId, entry] of readyByModelId) {
        if (isInUse(modelId)) {
          continue;
        }
        if (!lruEntry || entry.lastUsedTick < lruEntry.lastUsedTick) {
          lruModelId = modelId;
          lruEntry = entry;
        }
      }
      if (!lruModelId || !lruEntry) {
        // Every over-budget model is currently in use; do not evict mid-inference.
        return;
      }
      if (lruEntry.releaseTimer) {
        cancelRelease(lruEntry.releaseTimer);
      }
      readyByModelId.delete(lruModelId);
      void Promise.resolve(onRelease?.(lruModelId, lruEntry.model)).catch(() => undefined);
    }
  }

  return {
    warm: async (modelId, loader) => {
      const ready = readyByModelId.get(modelId);
      if (ready) {
        reschedule(modelId, ready.model);
        return ready.model;
      }

      const inFlight = warmByModelId.get(modelId);
      if (inFlight) {
        return await inFlight;
      }

      const promise = (async () => {
        const releaseVersionAtStart = readReleaseVersion(modelId);
        const model = await loader();
        if (readReleaseVersion(modelId) !== releaseVersionAtStart) {
          await onRelease?.(modelId, model);
          return model;
        }
        reschedule(modelId, model);
        enforceMemoryBudget();
        return model;
      })();
      warmByModelId.set(modelId, promise);
      try {
        return await promise;
      } finally {
        warmByModelId.delete(modelId);
      }
    },
    release: async (modelId, options) => {
      const ready = readyByModelId.get(modelId);
      if (ready?.releaseTimer) {
        cancelRelease(ready.releaseTimer);
      }
      readyByModelId.delete(modelId);
      warmByModelId.delete(modelId);
      releaseVersionByModelId.set(modelId, readReleaseVersion(modelId) + 1);
      if (ready && options?.skipOnRelease !== true) {
        await onRelease?.(modelId, ready.model);
      }
    },
    isWarm: (modelId) => readyByModelId.has(modelId),
    residentBytes: () => currentResidentBytes(),
  };
}
