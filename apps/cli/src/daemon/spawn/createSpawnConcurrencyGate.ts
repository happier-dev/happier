export type SpawnConcurrencyGate = Readonly<{
  run: <T>(work: () => Promise<T>) => Promise<T>;
}>;

export function createSpawnConcurrencyGate(maxConcurrent: number): SpawnConcurrencyGate {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`Invalid maxConcurrent: ${maxConcurrent}`);
  }

  let inFlight = 0;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.push(resolve);
    });

    // Slot is transferred directly from the releasing worker to this waiter.
    // (No inFlight change here.)
  };

  const release = (): void => {
    const next = queue.shift();
    if (next) {
      // Keep inFlight unchanged; we transfer the slot to the next waiter.
      next();
      return;
    }

    inFlight = Math.max(0, inFlight - 1);
  };

  return {
    run: async <T>(work: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

