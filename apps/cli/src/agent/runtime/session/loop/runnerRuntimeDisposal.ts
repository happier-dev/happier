import type { RunnerTerminationEvent } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import type { RuntimeTurnDisposeReason } from '@/agent/runtime/turns/runtimeTurnOperations';

export function resolveRunnerRuntimeDisposalReason(
  event: RunnerTerminationEvent,
): RuntimeTurnDisposeReason {
  return event.kind === 'killSession' ? 'session_closed' : 'host_shutdown';
}

export async function requestExplicitRunnerStop(input: Readonly<{
  abortActiveTurn: () => Promise<void>;
  disposeRuntime: (reason: RuntimeTurnDisposeReason) => Promise<void>;
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<unknown>;
}>): Promise<void> {
  await input.abortActiveTurn();
  await input.disposeRuntime('session_closed');
  input.requestTermination({ kind: 'killSession' });
  await input.whenTerminated;
}
