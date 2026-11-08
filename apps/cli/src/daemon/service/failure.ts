import type { GuestServiceFailureFactsV1 } from '@happier-dev/protocol/ssh/commandFailure';

import type { BackgroundServiceStartupFailure } from './readBackgroundServiceHealth';

export type ServiceOwnershipFailureReason = BackgroundServiceStartupFailure
  | 'deadline_elapsed'
  | 'owner_conflict'
  | 'owner_not_service_managed'
  | 'owner_service_label_mismatch'
  | 'launcher_action_mismatch';

export type DaemonServiceFailureFacts = Readonly<{
  error: GuestServiceFailureFactsV1['guestCliCode'];
  serviceStep: NonNullable<GuestServiceFailureFactsV1['serviceStep']>;
  serviceStepStatus: NonNullable<GuestServiceFailureFactsV1['serviceStepStatus']>;
  reason?: GuestServiceFailureFactsV1['serviceReason'];
  command?: GuestServiceFailureFactsV1['command'];
  process?: GuestServiceFailureFactsV1['process'];
}>;

/** Keep human error text separate from the closed facts carried across processes. */
export class DaemonServiceError extends Error {
  readonly code: DaemonServiceFailureFacts['error'];
  readonly serviceStep: DaemonServiceFailureFacts['serviceStep'];
  readonly serviceStepStatus: DaemonServiceFailureFacts['serviceStepStatus'];
  readonly reason: DaemonServiceFailureFacts['reason'];
  readonly command: DaemonServiceFailureFacts['command'];
  readonly process: DaemonServiceFailureFacts['process'];

  constructor(message: string, facts: DaemonServiceFailureFacts) {
    super(message);
    this.code = facts.error;
    this.serviceStep = facts.serviceStep;
    this.serviceStepStatus = facts.serviceStepStatus;
    this.reason = facts.reason;
    this.command = facts.command;
    this.process = facts.process;
  }
}

export function readDaemonServiceFailureFacts(error: unknown): DaemonServiceFailureFacts | undefined {
  if (error instanceof DaemonServiceError) {
    return {
      error: error.code,
      serviceStep: error.serviceStep,
      serviceStepStatus: error.serviceStepStatus,
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.command ? { command: error.command } : {}),
      ...(error.process ? { process: error.process } : {}),
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
