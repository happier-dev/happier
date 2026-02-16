function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function runMetadataOverridesWatcherLoop(args: Readonly<{
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal | undefined;
  waitForMetadataUpdate: (signal?: AbortSignal) => Promise<boolean>;
  onUpdate: () => void;
  abortedBackoffMs?: number;
}>): Promise<void> {
  const abortedBackoffMs =
    typeof args.abortedBackoffMs === 'number' && Number.isFinite(args.abortedBackoffMs) && args.abortedBackoffMs > 0
      ? Math.floor(args.abortedBackoffMs)
      : 25;

  while (!args.shouldExit()) {
    const signal = args.getAbortSignal();
    const didUpdate = await args.waitForMetadataUpdate(signal);
    if (!didUpdate) {
      // Avoid a hot loop when waitForMetadataUpdate resolves immediately for an already-aborted signal.
      if (signal?.aborted) {
        await sleepMs(abortedBackoffMs);
      }
      continue;
    }
    args.onUpdate();
  }
}
