import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import { APPROVAL_REQUEST_GET_ACTION_ID_V1, APPROVAL_REQUEST_LIST_ACTION_ID_V1, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';

export type VoiceApprovalGuidance = 'tap_required' | 'spoken_decision';

export function readVoiceApprovalGuidance(value: unknown): VoiceApprovalGuidance | undefined {
  return value === 'tap_required' || value === 'spoken_decision' ? value : undefined;
}

export function resolveVoiceApprovalGuidance(
  context: Pick<ActionExecutorContext, 'surface' | 'authority'>,
): VoiceApprovalGuidance | undefined {
  if (context.surface !== 'voice') return undefined;
  return context.authority === 'present_user' ? 'spoken_decision' : 'tap_required';
}

/** A live Voice Run can speak for the person only within its admitted ceiling. */
export function mayVoiceApproveBySpokenConsent(
  currentlyAllowed: boolean,
  admittedAuthority: ActionRequiredAuthority | undefined,
): boolean {
  return currentlyAllowed && admittedAuthority === 'present_user';
}

/** Presentation of already-resolved Voice authority, outside the Action's validated domain payload. */
export function projectVoiceApprovalGuidance(
  context: ActionExecutorContext,
  actionId: ActionId,
  execution: ActionExecuteResult,
): ActionExecuteResult & Readonly<{ voiceApprovalGuidance?: VoiceApprovalGuidance }> {
  const guidance = resolveVoiceApprovalGuidance(context);
  if (!guidance || !execution.ok) return execution;
  const result = readRecord(execution.result);
  const pending = result.kind === 'approval_request_created'
    || (actionId === APPROVAL_REQUEST_GET_ACTION_ID_V1 && readRecord(result.request).status === 'open')
    || (actionId === APPROVAL_REQUEST_LIST_ACTION_ID_V1 && Array.isArray(result.items)
      && result.items.some(item => readRecord(item).status === 'open'));
  return pending ? { ...execution, voiceApprovalGuidance: guidance } : execution;
}
