/**
 * Holds replay-seed retirement between Claude's synchronous provider-acceptance callback and the
 * next asynchronous prompt read. Both Claude runtimes use this lifecycle so an accepted prompt
 * cannot race a second read of the still-live seed.
 */
export function createClaudeReplaySeedRetirement(): Readonly<{
  bind: (settle: (() => Promise<unknown>) | null) => void;
  confirmProviderAccepted: () => void;
  drain: () => Promise<void>;
}> {
  let pendingSettlement: (() => Promise<unknown>) | null = null;
  let settlement: Promise<unknown> | null = null;

  return Object.freeze({
    bind(settle: (() => Promise<unknown>) | null): void {
      // Bind every dispatched prompt, including prompts that intentionally carry no seed. That
      // prevents acceptance of a later unseeded command from settling an older failed attempt.
      pendingSettlement = settle;
    },
    confirmProviderAccepted(): void {
      const settle = pendingSettlement;
      if (!settle) return;
      pendingSettlement = null;
      settlement = settle();
    },
    async drain(): Promise<void> {
      const inFlight = settlement;
      if (!inFlight) return;
      settlement = null;
      await inFlight;
    },
  });
}
