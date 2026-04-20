export type InferenceRuntimeModule = Record<string, unknown>;

export type InferenceRuntimeLoadOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type InferenceRuntimeLoader<THandle> = Readonly<{
  load: (runtimeId: string, options?: InferenceRuntimeLoadOptions) => Promise<THandle>;
}>;

type InferenceRuntimeLoadCandidate<THandle> = (
  options?: InferenceRuntimeLoadOptions,
) => Promise<THandle>;

export function createInferenceRuntimeLoader<THandle>(params: Readonly<{
  resolveCandidates: (
    runtimeId: string,
    options?: InferenceRuntimeLoadOptions,
  ) => readonly InferenceRuntimeLoadCandidate<THandle>[];
  isRecoverableLoadError: (error: unknown) => boolean;
  onNoCandidates?: (runtimeId: string, options?: InferenceRuntimeLoadOptions) => Promise<THandle> | THandle;
  onRecoverableExhaustion?: (params: Readonly<{
    runtimeId: string;
    options?: InferenceRuntimeLoadOptions;
    lastError: unknown;
  }>) => Promise<THandle> | THandle;
}>): InferenceRuntimeLoader<THandle> {
  return {
    load: async (runtimeId, options) => {
      const candidates = [...params.resolveCandidates(runtimeId, options)];
      if (candidates.length === 0) {
        if (params.onNoCandidates) {
          return await params.onNoCandidates(runtimeId, options);
        }
        throw new Error(`inference_runtime_loader_candidates_missing:${runtimeId}`);
      }

      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          return await candidate(options);
        } catch (error) {
          lastError = error;
          if (!params.isRecoverableLoadError(error)) {
            throw error;
          }
        }
      }

      if (params.onRecoverableExhaustion) {
        return await params.onRecoverableExhaustion({
          runtimeId,
          options,
          lastError,
        });
      }

      throw lastError;
    },
  };
}

export async function importInferenceRuntimeModuleWithFallback<TModule extends InferenceRuntimeModule>(params: Readonly<{
  packageImport: () => Promise<TModule>;
  runtimeImport: (moduleUrl: string) => Promise<TModule>;
  runtimeImportUrls: readonly string[];
  isRecoverableImportError: (error: unknown) => boolean;
}>): Promise<TModule> {
  const loader = createInferenceRuntimeLoader<TModule>({
    resolveCandidates: () => [
      async () => await params.packageImport(),
      ...params.runtimeImportUrls.map((moduleUrl) => async () => await params.runtimeImport(moduleUrl)),
    ],
    isRecoverableLoadError: params.isRecoverableImportError,
  });
  return await loader.load('runtime-module');
}

export async function readInferenceRuntimeModuleFieldWithRecoverableRetry<T>(params: Readonly<{
  mod: InferenceRuntimeModule;
  field: string;
  isRecoverableRuntimeError: (error: unknown) => boolean;
}>): Promise<Readonly<{ value: T | null; error: unknown | null }>> {
  try {
    return {
      value: (params.mod as Record<string, T | null | undefined>)[params.field] ?? null,
      error: null,
    };
  } catch (error) {
    if (!params.isRecoverableRuntimeError(error)) {
      throw error;
    }

    await Promise.resolve();

    try {
      return {
        value: (params.mod as Record<string, T | null | undefined>)[params.field] ?? null,
        error: null,
      };
    } catch (retryError) {
      if (!params.isRecoverableRuntimeError(retryError)) {
        throw retryError;
      }

      return { value: null, error: retryError };
    }
  }
}
