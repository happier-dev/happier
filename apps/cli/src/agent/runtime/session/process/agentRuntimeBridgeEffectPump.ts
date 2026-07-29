export type AgentRuntimeBridgeEffectAdmission =
  | 'started'
  | 'duplicate'
  | 'overflow';

export function createAgentRuntimeBridgeEffectPump(params: Readonly<{
  maxActive: number;
}>) {
  const active = new Map<string, Readonly<{
    controller: AbortController;
    operation: Promise<void>;
  }>>();

  return Object.freeze({
    admit(
      effectId: string,
      run: (signal: AbortSignal) => Promise<void>,
    ): AgentRuntimeBridgeEffectAdmission {
      if (active.has(effectId)) return 'duplicate';
      if (active.size >= params.maxActive) return 'overflow';
      const controller = new AbortController();
      const operation = Promise.resolve()
        .then(() => run(controller.signal))
        .finally(() => {
          if (active.get(effectId)?.operation === operation) active.delete(effectId);
        });
      active.set(effectId, { controller, operation });
      return 'started';
    },
    cancel(effectId: string, reason: unknown = 'cancelled'): boolean {
      const entry = active.get(effectId);
      if (!entry) return false;
      entry.controller.abort(reason);
      return true;
    },
    dispose(reason: unknown = 'runtime_recovery'): void {
      for (const entry of active.values()) entry.controller.abort(reason);
    },
    async whenIdle(): Promise<void> {
      while (active.size > 0) {
        await Promise.allSettled(
          [...active.values()].map((entry) => entry.operation),
        );
      }
    },
  });
}
