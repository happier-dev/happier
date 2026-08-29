import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';

export async function settleExecutionRunController(args: Readonly<{
  runId: string;
  controller: ExecutionRunController;
  controllers: Map<string, ExecutionRunController>;
}>): Promise<void> {
  if (!args.controller.settlementPromise) {
    args.controller.settlementPromise = (async () => {
      try {
        // Persist terminal cleanup custody before backend disposal asks the
        // daemon to release the materialized root. This prevents a late marker
        // write from recreating an already-cleared cleanup receipt.
        await args.controller.terminalMarkerWritePromise;
      } catch {
        // Marker writes are best effort; the terminal waiter still has to settle.
      }
      if (args.controller.kind === 'backend') {
        const backend = args.controller.backend;
        // Plugin cleanup starts only after terminal-marker custody is settled,
        // but is deliberately detached. A provider may never settle dispose;
        // terminal waiters and controller retirement remain host-owned truth.
        void Promise.resolve()
          .then(async () => await backend.dispose())
          .catch(() => undefined);
      }
      args.controller.resolveTerminal();
      if (args.controllers.get(args.runId) === args.controller) {
        args.controllers.delete(args.runId);
      }
    })();
  }
  await args.controller.settlementPromise;
}
