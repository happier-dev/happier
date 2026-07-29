type ChunkRoute = Readonly<{
  continue: () => Promise<unknown>;
}>;

export function createDirectTransferCancellationChunkGate(): Readonly<{
  handleRoute: (route: ChunkRoute) => Promise<void>;
  waitForLaterChunkHeld: () => Promise<void>;
  releaseAfterCancellation: () => void;
  readonly requestCount: number;
}> {
  let requestCount = 0;
  let resolveLaterChunkHeld: () => void = () => {};
  const laterChunkHeld = new Promise<void>((resolve) => {
    resolveLaterChunkHeld = resolve;
  });
  let releaseHeldChunks: () => void = () => {};
  const cancellationReached = new Promise<void>((resolve) => {
    releaseHeldChunks = resolve;
  });

  return {
    handleRoute: async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        await route.continue();
        return;
      }

      resolveLaterChunkHeld();
      await cancellationReached;
      await route.continue().catch(() => {});
    },
    waitForLaterChunkHeld: async () => await laterChunkHeld,
    releaseAfterCancellation: releaseHeldChunks,
    get requestCount() {
      return requestCount;
    },
  };
}
