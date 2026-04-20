type InferenceWarmEntry<TModel> = Readonly<{
  model: TModel;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}>;

export type InferenceWarmupCoordinator<TModel> = Readonly<{
  warm: (modelId: string, loader: () => Promise<TModel>) => Promise<TModel>;
  release: (modelId: string, options?: Readonly<{ skipOnRelease?: boolean }>) => Promise<void>;
  isWarm: (modelId: string) => boolean;
}>;

export function createInferenceWarmupCoordinator<TModel>(params?: Readonly<{
  residencyMs?: number;
  scheduleRelease?: typeof setTimeout;
  cancelRelease?: typeof clearTimeout;
  onRelease?: (modelId: string, model: TModel) => Promise<void> | void;
}>): InferenceWarmupCoordinator<TModel> {
  const residencyMs = params?.residencyMs ?? Number.POSITIVE_INFINITY;
  const scheduleRelease = params?.scheduleRelease ?? setTimeout;
  const cancelRelease = params?.cancelRelease ?? clearTimeout;
  const onRelease = params?.onRelease;
  const warmByModelId = new Map<string, Promise<TModel>>();
  const readyByModelId = new Map<string, InferenceWarmEntry<TModel>>();
  const releaseVersionByModelId = new Map<string, number>();

  function readReleaseVersion(modelId: string): number {
    return releaseVersionByModelId.get(modelId) ?? 0;
  }

  function schedule(modelId: string, model: TModel): ReturnType<typeof setTimeout> | null {
    if (!Number.isFinite(residencyMs)) {
      return null;
    }

    return scheduleRelease(() => {
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
    });
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
  };
}
