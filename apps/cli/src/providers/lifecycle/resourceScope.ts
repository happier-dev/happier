export type ProviderLaunchCleanup = () => void | Promise<void>;
export type ProviderLaunchResource = Readonly<{
  onFailure: ProviderLaunchCleanup;
  onExit: ProviderLaunchCleanup;
}>;

export type ProviderLaunchResourceScope = Readonly<{
  register(cleanup: ProviderLaunchCleanup | ProviderLaunchResource | null | undefined): void;
  setSanitizer(sanitizer: ((value: string) => string) | null): void;
  sanitize(value: unknown): string;
  release(): Promise<void>;
  retire(): Promise<void>;
  transfer(): ProviderLaunchCleanup | null;
}>;

/**
 * Owns all pre-commit Provider launch resources until the successful child
 * commit explicitly transfers them. Cleanup is reverse-order and exact-once.
 */
export function createProviderLaunchResourceScope(input: Readonly<{
  onCleanupError?: (safeMessage: string) => void;
}> = {}): ProviderLaunchResourceScope {
  let resources: ProviderLaunchResource[] = [];
  let sanitizer: ((value: string) => string) | null = null;
  let state: 'open' | 'released' | 'transferred' = 'open';

  const sanitize = (value: unknown): string => {
    const text = value instanceof Error ? value.message : String(value);
    return sanitizer ? sanitizer(text) : text;
  };
  let releasePromise: Promise<void> | null = null;
  let transferredRetirement: ProviderLaunchCleanup | null = null;
  const run = async (owned: ProviderLaunchCleanup[]) => {
    let firstError: unknown;
    let cleanupFailed = false;
    for (let index = owned.length - 1; index >= 0; index -= 1) {
      try {
        await owned[index]?.();
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          firstError = error;
        }
        try {
          input.onCleanupError?.(sanitize(error));
        } catch {
          // Cleanup diagnostics cannot take custody away from later resources.
        }
      }
    }
    if (cleanupFailed) throw firstError;
  };

  return Object.freeze({
    register(cleanup) {
      if (!cleanup) return;
      if (state !== 'open') throw new Error('Provider launch resource scope is no longer open');
      resources.push(typeof cleanup === 'function'
        ? { onFailure: cleanup, onExit: cleanup }
        : cleanup);
    },
    setSanitizer(next) {
      sanitizer = next;
    },
    sanitize,
    async release() {
      if (releasePromise) return await releasePromise;
      if (state !== 'open') return;
      state = 'released';
      const owned = resources;
      resources = [];
      releasePromise = run(owned.map((resource) => resource.onFailure));
      await releasePromise;
    },
    async retire() {
      if (state === 'transferred') {
        await transferredRetirement?.();
        return;
      }
      if (releasePromise) {
        await releasePromise;
        return;
      }
      if (state !== 'open') return;
      state = 'released';
      const owned = resources;
      resources = [];
      releasePromise = run(owned.map((resource) => resource.onFailure));
      await releasePromise;
    },
    transfer() {
      if (state !== 'open') return null;
      state = 'transferred';
      const owned = resources;
      resources = [];
      if (owned.length === 0) return null;
      let cleanupPromise: Promise<void> | null = null;
      transferredRetirement = async () => {
        if (cleanupPromise) return await cleanupPromise;
        cleanupPromise = run(owned.map((resource) => resource.onExit));
        await cleanupPromise;
      };
      return transferredRetirement;
    },
  });
}
