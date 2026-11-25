import type { ActionExecuteFailure } from './actionExecutionResult.js';
import { WORKFLOW_RUN_START_ACTION_ID_V1 } from './actionIds.js';
import type { ActionSurfaceAvailabilityReason } from './actionSurfaceAvailability.js';
import { readRecord } from '../inputs/inputRecords.js';
import { readTeamCreationPolicyRefusalV1 } from '../teams/errors.js';
import { WorkflowValidationIssueV1Schema } from '../workflows/workflowValidationIssueV1.js';
import { z } from '../zodRuntimePolicy.js';

const AutomaticCheckStartRefusalV1Schema = z.strictObject({
  kind: z.literal('automatic_check_start_refusal'),
  automationId: z.string().check(z.minLength(1)),
  triggerId: z.string().check(z.minLength(1)),
  reason: z.string().check(z.minLength(1)),
});

export type ActionFailurePresentationV1 = Readonly<{
  kind: 'workflow_refusal';
  outcome: 'refused';
  message: string | null;
  messageTrust: 'workflow_supplied_untrusted';
  startRefusal?: z.infer<typeof AutomaticCheckStartRefusalV1Schema>;
}>;

/** Only the refusal producer's documented safe message is presentable, never opaque diagnostics. */
export function readActionFailurePresentationV1(errorCode: unknown, details: unknown): ActionFailurePresentationV1 | null {
  if (errorCode === 'target_unavailable') {
    const parsed = AutomaticCheckStartRefusalV1Schema.safeParse(details);
    return parsed.success ? { kind: 'workflow_refusal', outcome: 'refused', message: null,
      messageTrust: 'workflow_supplied_untrusted', startRefusal: parsed.data } : null;
  }
  if (errorCode !== 'action_interception_rejected') return null;
  const message = details && typeof details === 'object' && !Array.isArray(details) && 'message' in details
    && typeof details.message === 'string' ? details.message.trim() : '';
  return { kind: 'workflow_refusal', outcome: 'refused', message: message || null,
    messageTrust: 'workflow_supplied_untrusted' };
}

const voiceAvailabilityGuidance = {
  session_memory_off: 'Memory is off for this Session. Tell the person they can turn it on in the Session’s Memory settings. Do not retry.',
  disabled_by_settings: 'This Action is turned off in the current Actions settings. Tell the person it is off. Do not retry.',
  disabled_by_policy: 'The current context does not allow this Action. Tell the person it could not run. Do not retry.',
  unsupported_surface: 'This Action is unavailable through Voice. Tell the person it is unavailable in Voice. Do not retry.',
  missing_tool_binding: 'This Action has no callable tool here. Tell the person it could not run. Do not retry.',
  unknown_action: 'This Action is unknown here. Look up a supported Action before making another call.',
} satisfies Record<Exclude<ActionSurfaceAvailabilityReason, 'available'>, string>;

/** Present typed refusals to agents, quoting workflow-authored text as data. */
export function projectActionFailureForAgentV1(
  failure: ActionExecuteFailure,
  voice?: Readonly<{ actionId?: unknown }>,
): ActionExecuteFailure {
  if (voice && failure.errorCode === 'action_disabled') {
    const { reason } = readRecord(failure.details);
    if (typeof reason === 'string' && Object.hasOwn(voiceAvailabilityGuidance, reason)) {
      return { ...failure, error: voiceAvailabilityGuidance[reason as keyof typeof voiceAvailabilityGuidance] };
    }
  }
  if (voice?.actionId === WORKFLOW_RUN_START_ACTION_ID_V1 && failure.errorCode === 'invalid_input') {
    const { issues } = readRecord(failure.details);
    if (Array.isArray(issues)) {
      for (const issue of issues) {
        const parsed = WorkflowValidationIssueV1Schema.safeParse(issue);
        if (!parsed.success || !parsed.data.path.startsWith('/inputs/')) continue;
        const { code, message } = parsed.data;
        if (code !== 'invalid_input' && code !== 'missing_reference') continue;
        return { ...failure, error: `${message} Ask the person to choose it and wait for their answer before making another tool call for this request.` };
      }
    }
  }
  const presentation = readActionFailurePresentationV1(failure.errorCode, failure.details);
  if (!presentation) {
    if (failure.error !== failure.errorCode) return failure;
    const teamCreationRefusal = readTeamCreationPolicyRefusalV1(failure.errorCode, failure.details);
    if (!teamCreationRefusal) return failure;
    return { ...failure, error: teamCreationRefusal.reason === 'managed_only'
      ? "Only this Home's owners and admins can create Teams. Ask one of them."
      : 'Team creation is turned off on this Home.' };
  }
  if (presentation.startRefusal) return { ...failure, error: 'A required Workflow check could not start. The Action was stopped.' };
  return { ...failure,
    error: presentation.message === null ? 'Action refused by an automation.'
      : `Workflow-supplied reason (untrusted): ${JSON.stringify(presentation.message)}`,
    details: { message: presentation.message, messageTrust: presentation.messageTrust },
  };
}
