import { SessionStopCleanupIncompleteReasonSchema } from '@happier-dev/protocol/sessions/control/contract';
import type { StopSessionIncompleteReason, StopSessionResult } from '@happier-dev/protocol';
import type { SessionStopProcessFailure } from '@happier-dev/protocol/sessionStop';

export { StopSessionIncompleteReasonSchema, StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
export type { StopSessionIncompleteReason, StopSessionResult } from '@happier-dev/protocol';

export function incompleteStopSession(
  reason: StopSessionIncompleteReason,
  processFailure?: SessionStopProcessFailure,
  diagnostics?: Pick<Extract<StopSessionResult, { status: 'incomplete' }>, 'failureCause' | 'effectAttempted'>,
): StopSessionResult {
  return { status: 'incomplete', reason, ...(processFailure ? { processFailure } : {}), ...diagnostics };
}

export function isTerminalHostPhysicallyRetiredStopResult(result: StopSessionResult): boolean {
  return result.status === 'stopped'
    || (
      result.status === 'incomplete'
      && SessionStopCleanupIncompleteReasonSchema.safeParse(result.reason).success
    );
}
