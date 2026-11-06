import { z } from 'zod';
import {
  SessionStopCleanupIncompleteReasonSchema,
  StopSessionOriginSchema,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from '@happier-dev/protocol';

export {
  StopSessionIncompleteReasonSchema,
  StopSessionResultSchema,
  type StopSessionIncompleteReason,
  type StopSessionResult,
} from '@happier-dev/protocol';

// Derived from the protocol schema value so the enum cannot drift from its
// canonical owner. (A direct `type StopSessionOrigin` re-export through the
// protocol barrel does not resolve under the CLI's packed-dependency project
// typecheck, while the schema value does.)
export type StopSessionOrigin = z.infer<typeof StopSessionOriginSchema>;

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
