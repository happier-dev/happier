export async function waitForDaemonRunningWithinBudget(params: {
  isRunning: () => Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  // Readiness probes can enumerate OS processes; their elapsed time belongs to this budget too.
  const deadline = performance.now() + params.timeoutMs;
  if (await params.isRunning()) return true;

  const sleep =
    typeof params.sleep === 'function'
      ? params.sleep
      : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    const sleepMs = Math.min(params.pollMs, remainingMs);
    await sleep(sleepMs);
    if (await params.isRunning()) return true;
  }

  return false;
}
