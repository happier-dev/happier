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
 * commit explicitly transfers them. Settled cleanup is exact-once; failed
 * resources remain owned for an explicit retry, always in reverse order.
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
  let releaseCleanup: ProviderLaunchCleanup | null = null;
  let transferredRetirement: ProviderLaunchCleanup | null = null;
  const run = async (owned: ProviderLaunchCleanup[]) => {
    let firstError: unknown;
    let cleanupFailed = false;
    for (let index = owned.length - 1; index >= 0; index -= 1) {
      try {
        await owned[index]?.();
        owned.splice(index, 1);
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
  const ownCleanup = (owned: ProviderLaunchCleanup[]): ProviderLaunchCleanup => {
    let pending: Promise<void> | null = null;
    return async () => {
      if (pending) return await pending;
      pending = run(owned);
      try {
        await pending;
      } finally {
        if (owned.length > 0) pending = null;
      }
    };
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
      if (releaseCleanup) return await releaseCleanup();
      if (state !== 'open') return;
      state = 'released';
      const owned = resources;
      resources = [];
      releaseCleanup = ownCleanup(owned.map((resource) => resource.onFailure));
      await releaseCleanup();
    },
    async retire() {
      if (state === 'transferred') {
        await transferredRetirement?.();
        return;
      }
      if (releaseCleanup) {
        await releaseCleanup();
        return;
      }
      if (state !== 'open') return;
      state = 'released';
      const owned = resources;
      resources = [];
      releaseCleanup = ownCleanup(owned.map((resource) => resource.onFailure));
      await releaseCleanup();
    },
    transfer() {
      if (state !== 'open') return null;
      state = 'transferred';
      const owned = resources;
      resources = [];
      if (owned.length === 0) return null;
      transferredRetirement = ownCleanup(owned.map((resource) => resource.onExit));
      return transferredRetirement;
    },
  });
}
