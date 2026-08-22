import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';

export async function settleExecutionRunController(args: Readonly<{
  runId: string;
  controller: ExecutionRunController;
  controllers: Map<string, ExecutionRunController>;
}>): Promise<void> {
  if (!args.controller.settlementPromise) {
    args.controller.settlementPromise = (async () => {
      if (args.controller.kind === 'backend') {
        try {
          await args.controller.backend.dispose();
        } catch {
          // Best effort: terminal settlement must not depend on backend disposal succeeding.
        }
      }
      try {
        await args.controller.terminalMarkerWritePromise;
      } catch {
        // Marker writes are best effort; the terminal waiter still has to settle.
      }
      args.controller.resolveTerminal();
      if (args.controllers.get(args.runId) === args.controller) {
        args.controllers.delete(args.runId);
      }
    })();
  }
  await args.controller.settlementPromise;
}
