import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DECISION_ACTION_IDS, SESSION_MESSAGE_SEND_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { SETTINGS_DECLARATION_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/settingsDeclarationActionIdsV1';
import { VOICE_BRIEF_REQUEST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/voiceConversationActionIdsV1';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { ActionApprovalRequestCreatedResultSchema, parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestStatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionMessageSendActionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { t } from '@/text';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import { VOICE_ACTION_EXECUTE_TOOL_NAME } from '@/voice/tools/voiceActionExecution';
import type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';

const [, , settingsSetActionId] = SETTINGS_DECLARATION_ACTION_IDS_V1;
const [approvalRequestDecideActionId] = DECISION_ACTION_IDS;

export type SpokenActionOutcome = string | Readonly<{ kind: 'delegated_reply' }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** These Actions have an owner-produced disposition, rather than a model-authored answer. */
export function readSpokenActionOutcomeOwner(toolName: string, input: unknown) {
  const requestedActionId = toolName === VOICE_ACTION_EXECUTE_TOOL_NAME ? record(input)?.actionId : null;
  const owner = ([settingsSetActionId, approvalRequestDecideActionId, SESSION_MESSAGE_SEND_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1, VOICE_BRIEF_REQUEST_ACTION_ID_V1] as const).find(actionId =>
    requestedActionId === actionId || toolName === getActionSpec(actionId).bindings?.voiceClientToolName,
  ) ?? null;
  if (owner === SESSION_MESSAGE_SEND_ACTION_ID_V1) {
    const args = record(toolName === VOICE_ACTION_EXECUTE_TOOL_NAME ? record(input)?.input : input);
    // An explicit answer belongs to the existing wait/return lifecycle.
    if (args?.reply === 'wait' || args?.reply === 'return' || args?.wait === true) return null;
  }
  return owner;
}

/** Present the saved value/decision disposition; an accepted or pending call is not completion. */
export function resolveSpokenActionOutcome(entry: LocalVoiceAgentToolResultEntry, options?: Readonly<{
  resolveSentToLabel?: (input: Readonly<Record<string, unknown>> | null) => string | null;
}>): SpokenActionOutcome | null {
  const owner = readSpokenActionOutcomeOwner(entry.t, entry.args);
  if (!owner) return null;
  const envelope = record(entry.result);
  const unknown = t('errors.scmOutcomeUnknown');
  if (envelope?.ok === false && (envelope.errorCode ?? envelope.code) === 'present_user_required') {
    return t('voiceSurface.approvalTapRequired');
  }
  if (parseActionExecuteFailure(entry.result)?.errorCode === 'cancelled') {
    return t('voiceSurface.actionCanceled');
  }
  if (envelope?.ok !== true) {
    if (owner === SESSION_SPAWN_NEW_ACTION_ID_V1
      && (envelope?.errorCode === 'provider_model_ambiguous' || envelope?.errorCode === 'provider_model_not_found')) {
      // The carrier reads the returned choices and maps the answer to the exact choice.
      return null;
    }
    if (owner === SESSION_MESSAGE_SEND_ACTION_ID_V1) {
      return parseActionExecuteFailure(entry.result)?.errorCode === 'outcome_unknown'
        ? t('session.askRecord.unsure') : t('session.askRecord.notSent');
    }
    if (owner === SESSION_SPAWN_NEW_ACTION_ID_V1 && typeof envelope?.errorMessage === 'string'
      && envelope.errorMessage.trim()) return envelope.errorMessage.trim();
    return resolveActionExecutionFailureMessage(entry.result, unknown) ?? unknown;
  }
  // Direct tools flatten the envelope; action_execute retains it. Neither
  // transport metadata nor a previous presentation belongs to owner output.
  const { ok: _ok, summary: _summary, ...body } = record(envelope.result) ?? envelope;
  if (ActionApprovalRequestCreatedResultSchema.safeParse(body).success) {
    return t('approvals.status.open');
  }
  if (owner === VOICE_BRIEF_REQUEST_ACTION_ID_V1) {
    // Home may still be mounting Inbox. Its admitted delivery owns the answer;
    // a model tool-result follow-up would race that answer and speak twice.
    return body.status === 'waiting' || body.status === 'sent'
      ? { kind: 'delegated_reply' } : t('voiceMoments.briefNotSpoken');
  }
  if (owner === SESSION_SPAWN_NEW_ACTION_ID_V1) {
    // Creation is a validated domain settlement, not an Action { ok: false }
    // envelope. The host's presentation retains its bound Agent and alternative.
    switch (body.type) {
      case 'success': return t('voiceSurface.sessionCreated');
      case 'pending': return t('session.askRecord.unsure');
      case 'error': {
        if (body.code === 'cancelled') return t('voiceSurface.actionCanceled');
        const message = typeof envelope.errorMessage === 'string' ? envelope.errorMessage.trim() : '';
        return message || resolveSessionSpawnNewResultFailureMessage(body as Extract<SessionSpawnNewResultV1, { type: 'error' }>);
      }
    }
    return null;
  }
  if (owner === SESSION_MESSAGE_SEND_ACTION_ID_V1) {
    const parsed = SessionMessageSendActionResultV1Schema.safeParse(body);
    if (!parsed.success) return unknown;
    if ('kind' in parsed.data) {
      return parsed.data.results.every(({ result }) => result.ok
        && (result.result.status === 'accepted' || result.result.status === 'alreadyAccepted'))
        ? t('session.askRecord.sent') : t('session.askRecord.unsure');
    }
    switch (parsed.data.status) {
      case 'accepted':
      case 'alreadyAccepted': {
        // Provider summaries call without presentation context and receive no
        // private target label. Local speech uses the existing disclosure owner.
        const args = record(entry.t === VOICE_ACTION_EXECUTE_TOOL_NAME ? record(entry.args)?.input : entry.args);
        const label = options?.resolveSentToLabel?.(args);
        return label ? `${t('session.askRecord.sentTo')} ${label}` : t('session.askRecord.sent');
      }
      case 'outcomeUnknown': return t('session.askRecord.unsure');
      case 'held': return t('session.askRecord.noAnswerYet');
      case 'rejected':
      case 'failed':
      case 'cancelled': return t('session.askRecord.notSent');
      case 'replied': return unknown;
    }
  }
  if (owner === settingsSetActionId) {
    return SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(body).success
      ? t('common.done') : unknown;
  }
  const status = ApprovalRequestStatusSchema.safeParse(body.status);
  if (!status.success) return unknown;
  return t(`approvals.status.${status.data}`);
}
