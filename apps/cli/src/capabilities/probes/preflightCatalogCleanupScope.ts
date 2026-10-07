export type PreflightCatalogCleanupScope = Readonly<{
  retain(cleanup: () => Promise<void>): Promise<() => void>;
  dispose(): Promise<void>;
}>;

/** Holds only host-owned process/artifact cleanup, never provider callbacks or storage reads. */
export function createPreflightCatalogCleanupScope(): PreflightCatalogCleanupScope {
  const retained = new Set<() => Promise<void>>();
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    async retain(cleanup: () => Promise<void>) {
      if (disposal) {
        await cleanup();
        throw new Error('Agent catalog cleanup scope has closed');
      }
      retained.add(cleanup);
      return () => { retained.delete(cleanup); };
    },
    dispose() {
      disposal ??= (async () => {
        const failures: unknown[] = [];
        // Native execution is retained after its prepared artifacts and must
        // close before those artifacts are removed.
        for (const cleanup of [...retained].reverse()) {
          retained.delete(cleanup);
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'Agent catalog cleanup failed');
      })();
      return disposal;
    },
  });
}
