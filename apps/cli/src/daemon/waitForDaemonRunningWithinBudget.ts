export async function waitForDaemonRunningWithinBudget(params: {
  isRunning: () => Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  if (await params.isRunning()) return true;

  const sleep =
    typeof params.sleep === 'function'
      ? params.sleep
      : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  let remainingMs = params.timeoutMs;
  while (remainingMs > 0) {
    const sleepMs = Math.min(params.pollMs, remainingMs);
    await sleep(sleepMs);
    remainingMs -= sleepMs;
    if (await params.isRunning()) return true;
  }

  return false;
}
