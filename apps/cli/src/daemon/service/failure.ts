import type { SshCommandFailureReason } from '@happier-dev/protocol/ssh/commandFailure';

import type { BackgroundServiceStartupFailure } from './readBackgroundServiceHealth';

export type ServiceOwnershipFailureReason = BackgroundServiceStartupFailure
  | 'deadline_elapsed'
  | 'owner_conflict'
  | 'owner_not_service_managed'
  | 'owner_service_label_mismatch'
  | 'launcher_action_mismatch';

export type DaemonServiceFailureFacts = Readonly<{
  error: 'service_manager_unavailable' | 'service_command_failed' | 'service_start_timeout'
    | 'service_ownership_failed' | 'service_preflight_failed' | 'service_invalid_arguments';
  serviceStep: 'preflight' | 'cleanup_bootout' | 'bootstrap' | 'kickstart' | 'wait' | 'command';
  serviceStepStatus: 'failed' | 'deadline_elapsed' | 'unavailable';
  reason?: SshCommandFailureReason | ServiceOwnershipFailureReason;
}>;

/** Keep human error text separate from the closed facts carried across processes. */
export class DaemonServiceError extends Error {
  readonly code: DaemonServiceFailureFacts['error'];
  readonly serviceStep: DaemonServiceFailureFacts['serviceStep'];
  readonly serviceStepStatus: DaemonServiceFailureFacts['serviceStepStatus'];
  readonly reason: DaemonServiceFailureFacts['reason'];

  constructor(message: string, facts: DaemonServiceFailureFacts) {
    super(message);
    this.code = facts.error;
    this.serviceStep = facts.serviceStep;
    this.serviceStepStatus = facts.serviceStepStatus;
    this.reason = facts.reason;
  }
}

export function readDaemonServiceFailureFacts(error: unknown): DaemonServiceFailureFacts | undefined {
  if (error instanceof DaemonServiceError) {
    return {
      error: error.code,
      serviceStep: error.serviceStep,
      serviceStepStatus: error.serviceStepStatus,
      ...(error.reason ? { reason: error.reason } : {}),
    };
  }
  // Restoration commands may also fail; retain the original plan failure.
  if (error instanceof AggregateError) {
    for (const failure of error.errors) {
      const facts = readDaemonServiceFailureFacts(failure);
      if (facts) return facts;
    }
  }
  if (error instanceof Error && error.cause) return readDaemonServiceFailureFacts(error.cause);
  return undefined;
}
