import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';

export function disposeExecutionRunBackendController(controller: ExecutionRunBackendController): Promise<void> {
  controller.disposalPromise ??= Promise.resolve().then(() => controller.backend.dispose());
  return controller.disposalPromise;
}

export function settleExecutionRunControllerOccurrence<T extends Readonly<{ resolveTerminal(): void }>>(
  controllers: Map<string, T>,
  runId: string,
  controller: T,
): void {
  controller.resolveTerminal();
  if (controllers.get(runId) === controller) {
    controllers.delete(runId);
  }
}
