export type ConnectedServiceContinuationApplicationKey = Readonly<{
  sessionId: string;
  serviceId: string;
  groupId: string;
  profileId: string;
  generation: number;
}>;

function readCorrelationKeys(
  input: ConnectedServiceContinuationApplicationKey,
): Readonly<{ target: string; scope: string }> | null {
  const dimensions = [
    input.sessionId,
    input.serviceId,
    input.groupId,
    input.profileId,
  ];
  if (dimensions.some((value) => value.length === 0 || value.trim() !== value)) {
    return null;
  }
  if (!Number.isInteger(input.generation) || input.generation < 0) {
    return null;
  }
  return {
    target: JSON.stringify([...dimensions, input.generation]),
    scope: JSON.stringify(dimensions.slice(0, 3)),
  };
}

export function createConnectedServiceContinuationApplicationCorrelation<T>() {
  // This only carries the recovery owner's context into an asynchronous recipient
  // acknowledgement. Currentness/admission and Pending receipts own its lifetime;
  // a settled generation must never veto a later interrupted recovery.
  const pendingByScope = new Map<string, Readonly<{
    target: string;
    continuation: T;
  }>>();

  return {
    register(
      key: ConnectedServiceContinuationApplicationKey,
      continuation: T,
    ): boolean {
      const correlationKeys = readCorrelationKeys(key);
      if (correlationKeys === null) return false;
      pendingByScope.set(correlationKeys.scope, {
        target: correlationKeys.target,
        continuation,
      });
      return true;
    },

    async settle(
      key: ConnectedServiceContinuationApplicationKey,
      settleContinuation: (continuation: T) => Promise<void>,
    ): Promise<boolean> {
      const correlationKeys = readCorrelationKeys(key);
      if (correlationKeys === null) return false;
      const pending = pendingByScope.get(correlationKeys.scope);
      if (!pending || pending.target !== correlationKeys.target) return false;
      await settleContinuation(pending.continuation);
      if (pendingByScope.get(correlationKeys.scope) === pending) {
        pendingByScope.delete(correlationKeys.scope);
      }
      return true;
    },
  };
}
