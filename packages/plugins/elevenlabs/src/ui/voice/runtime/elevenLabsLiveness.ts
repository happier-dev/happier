export function createElevenLabsLiveness(input: Readonly<{
  createInboundWatchdog: (input: Readonly<{
    onStall: () => void;
    stallTimeoutMs: number;
    awaitingResponseTimeoutMs: number;
  }>) => Readonly<{
    start: () => void;
    stop: () => void;
    noteInboundEvent: () => void;
    markAwaitingResponse: (value: boolean) => void;
    markTurnActive: (value: boolean) => void;
  }>;
  now: () => number;
  readOutboundBytes: () => Promise<number | null>;
  onInboundStall: () => void;
  onOutboundPlateau: () => void;
  pollMs: number;
  plateauMs: number;
  inboundStallMs: number;
  awaitingResponseMs: number;
}>) {
  const inbound = input.createInboundWatchdog({
    onStall: input.onInboundStall,
    stallTimeoutMs: input.inboundStallMs,
    awaitingResponseTimeoutMs: input.awaitingResponseMs,
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastBytes: number | null = null;
  let lastProgressAt: number | null = null;
  let checking = false;
  let plateauReported = false;

  const checkOutbound = async (): Promise<void> => {
    if (checking || plateauReported) return;
    checking = true;
    try {
      const bytes = await input.readOutboundBytes();
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return;
      const now = input.now();
      if (lastBytes === null || bytes > lastBytes) {
        lastBytes = bytes;
        lastProgressAt = now;
        return;
      }
      lastProgressAt ??= now;
      if (now - lastProgressAt >= input.plateauMs) {
        plateauReported = true;
        input.onOutboundPlateau();
      }
    } finally {
      checking = false;
    }
  };

  const disconnected = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    lastBytes = null;
    lastProgressAt = null;
    checking = false;
    plateauReported = false;
    inbound.stop();
  };

  return Object.freeze({
    connected() {
      disconnected();
      inbound.start();
      timer = setInterval(() => { void checkOutbound(); }, Math.max(1, input.pollMs));
    },
    disconnected,
    noteInboundEvent: inbound.noteInboundEvent,
    modeChanged(mode: string) {
      inbound.noteInboundEvent();
      if (mode === 'speaking') {
        inbound.markAwaitingResponse(false);
        inbound.markTurnActive(true);
      } else {
        inbound.markTurnActive(false);
        inbound.markAwaitingResponse(false);
      }
    },
    userTurnCommitted() {
      inbound.noteInboundEvent();
      inbound.markTurnActive(false);
      inbound.markAwaitingResponse(true);
    },
  });
}
