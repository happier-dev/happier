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
  // Native cancellation can wait for a terminal provider event forever. The
  // cancellation owner handles its diagnostics; retirement is best effort and
  // must not hold disposal or runner termination behind that acknowledgement.
  void Promise.resolve().then(() => input.abortActiveTurn()).catch(() => undefined);
  await Promise.resolve().then(() => input.disposeRuntime(input.reason));
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
