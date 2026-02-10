export async function withTimeoutMs<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const timeoutMs =
    typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : 30_000;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      params.promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms (${params.label})`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

