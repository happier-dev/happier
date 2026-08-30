/**
 * Correlates provider-acceptance settlement by the same Pending localId used by the canonical
 * provider-input outcome. Providers may accept an older prompt after a newer one has entered
 * terminal custody, so a mutable "current prompt" callback is never sufficient.
 */
export function createProviderPromptAcceptanceSettlement(): Readonly<{
  register: (localId: string | null, settle: (() => Promise<unknown>) | null) => void;
  confirmProviderAccepted: (localIds: readonly string[]) => void;
  createPromptLocalAcceptanceCallback: (settle: () => Promise<unknown>) => () => void;
  drain: () => Promise<void>;
}> {
  const pendingSettlementByLocalId = new Map<string, () => Promise<unknown>>();
  let settlementSequence: Promise<void> = Promise.resolve();
  const enqueueSettlement = (settle: () => Promise<unknown>): void => {
    settlementSequence = settlementSequence.then(async () => {
      await settle();
    });
  };

  return Object.freeze({
    register(localId: string | null, settle: (() => Promise<unknown>) | null): void {
      if (typeof localId !== 'string' || localId.trim().length === 0) return;
      if (!settle) {
        pendingSettlementByLocalId.delete(localId);
        return;
      }
      pendingSettlementByLocalId.set(localId, settle);
    },
    confirmProviderAccepted(localIds: readonly string[]): void {
      if (localIds.length !== 1) return;
      const localId = localIds[0];
      if (typeof localId !== 'string' || localId.trim().length === 0) return;
      const acceptedSettlement = pendingSettlementByLocalId.get(localId);
      if (!acceptedSettlement) return;
      pendingSettlementByLocalId.delete(localId);
      enqueueSettlement(acceptedSettlement);
    },
    createPromptLocalAcceptanceCallback(settle: () => Promise<unknown>): () => void {
      let pendingSettlement: (() => Promise<unknown>) | null = settle;
      return (): void => {
        const acceptedSettlement = pendingSettlement;
        if (!acceptedSettlement) return;
        pendingSettlement = null;
        enqueueSettlement(acceptedSettlement);
      };
    },
    async drain(): Promise<void> {
      await settlementSequence;
    },
  });
}
