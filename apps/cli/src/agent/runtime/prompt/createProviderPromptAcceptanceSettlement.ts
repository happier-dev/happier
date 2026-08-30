/**
 * Holds provider-acceptance settlement between a synchronous acceptance callback and the next
 * asynchronous prompt read. Every prompt must bind its own settler (or null), so acceptance of a
 * later unseeded prompt cannot retire an earlier failed attempt.
 */
export function createProviderPromptAcceptanceSettlement(): Readonly<{
  bind: (settle: (() => Promise<unknown>) | null) => void;
  createAcceptanceCallback: (settle: () => Promise<unknown>) => () => void;
  confirmProviderAccepted: () => void;
  drain: () => Promise<void>;
}> {
  let boundAcceptanceCallback: (() => void) | null = null;
  let settlementSequence: Promise<void> = Promise.resolve();

  const createAcceptanceCallback = (settle: () => Promise<unknown>): (() => void) => {
    let pendingSettlement: (() => Promise<unknown>) | null = settle;
    return (): void => {
      const acceptedSettlement = pendingSettlement;
      if (!acceptedSettlement) return;
      pendingSettlement = null;
      settlementSequence = settlementSequence.then(async () => {
        await acceptedSettlement();
      });
    };
  };

  return Object.freeze({
    bind(settle: (() => Promise<unknown>) | null): void {
      boundAcceptanceCallback = settle ? createAcceptanceCallback(settle) : null;
    },
    createAcceptanceCallback,
    confirmProviderAccepted(): void {
      boundAcceptanceCallback?.();
    },
    async drain(): Promise<void> {
      await settlementSequence;
    },
  });
}
