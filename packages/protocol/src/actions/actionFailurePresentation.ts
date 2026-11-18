import type { ActionExecuteFailure } from './actionExecutionResult.js';
import { readTeamCreationPolicyRefusalV1 } from '../teams/errors.js';

export type ActionFailurePresentationV1 = Readonly<{
  kind: 'workflow_refusal';
  outcome: 'refused';
  message: string | null;
  messageTrust: 'workflow_supplied_untrusted';
}>;

/** Only the refusal producer's documented safe message is presentable, never opaque diagnostics. */
export function readActionFailurePresentationV1(errorCode: unknown, details: unknown): ActionFailurePresentationV1 | null {
  if (errorCode !== 'action_interception_rejected') return null;
  const message = details && typeof details === 'object' && !Array.isArray(details) && 'message' in details
    && typeof details.message === 'string' ? details.message.trim() : '';
  return { kind: 'workflow_refusal', outcome: 'refused', message: message || null,
    messageTrust: 'workflow_supplied_untrusted' };
}

/** Present typed refusals to agents, quoting workflow-authored text as data. */
export function projectActionFailureForAgentV1(failure: ActionExecuteFailure): ActionExecuteFailure {
  const presentation = readActionFailurePresentationV1(failure.errorCode, failure.details);
  if (!presentation) {
    if (failure.error !== failure.errorCode) return failure;
    const teamCreationRefusal = readTeamCreationPolicyRefusalV1(failure.errorCode, failure.details);
    if (!teamCreationRefusal) return failure;
    return { ...failure, error: teamCreationRefusal.reason === 'managed_only'
      ? "Only this Home's owners and admins can create Teams. Ask one of them."
      : 'Team creation is turned off on this Home.' };
  }
  return { ...failure,
    error: presentation.message === null ? 'Action refused by an automation.'
      : `Workflow-supplied reason (untrusted): ${JSON.stringify(presentation.message)}`,
    details: { message: presentation.message, messageTrust: presentation.messageTrust },
  };
}
