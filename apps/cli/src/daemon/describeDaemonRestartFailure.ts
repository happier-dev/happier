import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';

import type { RestartDaemonAndWaitFailure } from '@/daemon/restartDaemonAndWait';

/**
 * Human-readable rendering of a failed restart: what failed, what state the daemon is now in, and
 * what to run next. Its own module so that mocking the restart owner in a test does not also stub the wording.
 */
export function describeDaemonRestartFailure(failure: RestartDaemonAndWaitFailure): Readonly<{
  failedStep: string;
  daemonState: string;
  nextStep: string;
  recoveryCommand: string;
}> {
  const invoker = resolveInvokerName() ?? 'happier';
  const failedStep = failure.failedPhase === 'stop'
    ? 'stopping the previous daemon'
    : failure.failedPhase === 'start'
      ? 'starting the replacement daemon'
      : 'restarting session runners';

  if (failure.daemonStatusAfterFailure === 'running') {
    return {
      failedStep,
      daemonState: 'A daemon is running.',
      nextStep: `Confirm it is the one you expect with \`${invoker} daemon status\`.`,
      recoveryCommand: `${invoker} daemon status`,
    };
  }
  if (failure.daemonStatusAfterFailure === 'starting') {
    return {
      failedStep,
      daemonState: 'A daemon start is still in progress.',
      nextStep: `Check whether it settles with \`${invoker} daemon status\`.`,
      recoveryCommand: `${invoker} daemon status`,
    };
  }
  return {
    failedStep,
    daemonState: 'The daemon is not running: this machine has no daemon until one is started.',
    nextStep: `Start it again with \`${invoker} daemon start\`.`,
    recoveryCommand: `${invoker} daemon start`,
  };
}
