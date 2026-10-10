import type { RunnerTerminationEvent } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import type { RuntimeTurnDisposeReason } from '@/agent/runtime/turns/runtimeTurnOperations';

export function resolveRunnerRuntimeDisposalReason(
  event: RunnerTerminationEvent,
): RuntimeTurnDisposeReason {
  return event.kind === 'killSession' ? 'session_closed' : 'host_shutdown';
}

export async function abortAndDisposeRunnerRuntime(input: Readonly<{
  abortActiveTurn: () => Promise<void>;
  disposeRuntime: (reason: RuntimeTurnDisposeReason) => Promise<void>;
  reason: RuntimeTurnDisposeReason;
}>): Promise<void> {
  // Native cancellation can wait for a terminal provider event. Retiring the
  // runtime's process custody must start even when that event never arrives.
  await Promise.all([
    Promise.resolve().then(() => input.abortActiveTurn()),
    Promise.resolve().then(() => input.disposeRuntime(input.reason)),
  ]);
}

export async function requestExplicitRunnerStop(input: Readonly<{
  abortActiveTurn: () => Promise<void>;
  disposeRuntime: (reason: RuntimeTurnDisposeReason) => Promise<void>;
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<unknown>;
}>): Promise<void> {
  await abortAndDisposeRunnerRuntime({ ...input, reason: 'session_closed' });
  input.requestTermination({ kind: 'killSession' });
  await input.whenTerminated;
}
