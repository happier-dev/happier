export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(predicate: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 50;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

