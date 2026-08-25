export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maxConcurrent: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('Bundled Plugin projection concurrency must be a positive integer');
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(maxConcurrent, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index] as T, index);
    }
  }));
  return Object.freeze(results);
}
