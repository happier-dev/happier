import {
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
      && (
        result.reason === 'terminal_control_serviceability_retirement_failed'
        || result.reason === 'terminal_attachment_descriptor_retirement_failed'
      )
    );
}
