export async function withMcpTimeout<T>(
  promise: Promise<T>,
  options: Readonly<{ timeoutMs: number; label: string }>,
): Promise<T> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return await promise;

  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(options.label)), Math.floor(options.timeoutMs));
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
