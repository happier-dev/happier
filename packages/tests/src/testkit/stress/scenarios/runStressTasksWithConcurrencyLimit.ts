export async function runStressTasksWithConcurrencyLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index] as T, index);
      }
    }),
  );

  return results;
}

export async function runStressTaskCountWithConcurrencyLimit<R>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<R>,
): Promise<R[]> {
  const itemCount = Math.max(0, Math.trunc(count));
  return await runStressTasksWithConcurrencyLimit(
    Array.from({ length: itemCount }, (_, index) => index),
    concurrency,
    async (index) => await worker(index),
  );
}
