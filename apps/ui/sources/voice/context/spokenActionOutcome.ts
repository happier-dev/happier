import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestStatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { t } from '@/text';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { VOICE_ACTION_EXECUTE_TOOL_NAME } from '@/voice/tools/voiceActionExecution';
import type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** These mutations have an owner-produced completion, rather than a model-authored answer. */
export function readSpokenActionOutcomeOwner(toolName: string, input: unknown) {
  const requestedActionId = toolName === VOICE_ACTION_EXECUTE_TOOL_NAME ? record(input)?.actionId : null;
  return (['settings.set', 'approval.request.decide'] as const).find(actionId =>
    requestedActionId === actionId || toolName === getActionSpec(actionId).bindings?.voiceClientToolName,
  ) ?? null;
}

/** Present the saved value/decision disposition; an accepted or pending call is not completion. */
export function resolveSpokenActionOutcome(entry: LocalVoiceAgentToolResultEntry): string | null {
  const owner = readSpokenActionOutcomeOwner(entry.t, entry.args);
  if (!owner) return null;
  const envelope = record(entry.result);
  const unknown = t('entityDragDrop.preview.unknownDetail');
  if (envelope?.ok !== true) return resolveActionExecutionFailureMessage(entry.result, unknown) ?? unknown;
  // Direct tools flatten the envelope; action_execute retains it. Neither
  // transport metadata nor a previous presentation belongs to owner output.
  const { ok: _ok, summary: _summary, ...body } = record(envelope.result) ?? envelope;
  if (ActionApprovalRequestCreatedResultSchema.safeParse(body).success || body.kind === 'read_back_and_confirm') {
    return t('approvals.status.open');
  }
  if (owner === 'settings.set') {
    return SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(body).success
      ? t('common.done') : unknown;
  }
  const status = ApprovalRequestStatusSchema.safeParse(body.status);
  if (!status.success) return unknown;
  return t(`approvals.status.${status.data}`);
}
