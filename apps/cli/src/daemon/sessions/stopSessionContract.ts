import {
  SessionStopCleanupIncompleteReasonSchema,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from '@happier-dev/protocol';

export {
  StopSessionIncompleteReasonSchema,
  StopSessionResultSchema,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from '@happier-dev/protocol';

export function incompleteStopSession(reason: StopSessionIncompleteReason): StopSessionResult {
  return { status: 'incomplete', reason };
}

export function isTerminalHostPhysicallyRetiredStopResult(result: StopSessionResult): boolean {
  return result.status === 'stopped'
    || (
      result.status === 'incomplete'
      && SessionStopCleanupIncompleteReasonSchema.safeParse(result.reason).success
    );
}
