import { isPluginError } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type { TriageSessionHandoffInputV1, TriageSessionHandoffSelectionV1 } from '@happier-dev/triage-protocol/v1';
import {
  readTriageSessionHandoffChoicesV1, requestTriageSessionHandoffV1, type TriageSessionHandoffHostV1,
} from '../sessionHandoff.js';

const uncertain = 'Automatic investigation may have started. Check the Session before trying again.';
const approval = "Automatic investigation needs approval before it can start.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only closed codes become notice text; exception messages and recovery are private. */
function failure(code: unknown, attempted: boolean): string {
  if (attempted) return code === 'permission_denied' ? `${uncertain} Access was denied.`
    : code === 'machine_unavailable' ? `${uncertain} Its Machine is unavailable.` : uncertain;
  switch (code) {
    case 'machine_unavailable': return "Automatic investigation couldn't start: its Machine is unavailable.";
    case 'permission_denied': return "Automatic investigation couldn't start: access was denied.";
    case 'approval_required': return approval;
    default: return "Automatic investigation couldn't start: the configured Action is unavailable.";
  }
}

/** The client already validated the handoff. Present its result without retaining recovery custody. */
function noticeOutcome(response: unknown, attempted = true): string | null {
  if (!record(response)) return failure(undefined, attempted);
  if (response.ok === false) return failure(response.errorCode, attempted && response.effectAttempted !== false);
  const result = response.ok === true ? response.result : response;
  if (isPluginActionApprovalRequestCreated(result)) return approval;
  if (!record(result) || !record(result.handoff)) return failure(undefined, attempted);
  const handoff = result.handoff;
  switch (handoff.kind) {
    case 'uncertain': return uncertain;
    case 'selectionRequired': case 'placement_choice_required': return "Automatic investigation couldn't start. Choose the required Machine, workspace, Session or Agent in Investigate.";
    case 'cancelled': return "Automatic investigation couldn't start: it was cancelled.";
    case 'composed': return "Automatic investigation couldn't start: its input is waiting in a draft.";
    case 'unavailable':
      switch (handoff.reason) {
        case 'configuredActionUnavailable': return "Automatic investigation couldn't start: the configured Action is unavailable.";
        case 'evidenceInvalid': return "Automatic investigation couldn't start: its alert evidence is unavailable.";
        case 'repositoryMismatch': case 'scopeMismatch': return "Automatic investigation couldn't start: its workspace no longer matches this alert.";
        case 'sessionUnavailable': return "Automatic investigation couldn't start: its Session is unavailable.";
        case 'agentMismatch': return "Automatic investigation couldn't start: choose a matching Agent.";
        case 'composerUnavailable': return "Automatic investigation couldn't start: its composer is unavailable.";
        default: return "Automatic investigation couldn't start: its target is unavailable.";
      }
    case 'sendResult':
      if (!record(handoff.result)) return uncertain;
      switch (handoff.result.status) {
        case 'accepted': case 'alreadyAccepted': case 'replied': return null;
        case 'rejected': case 'held': return "Automatic investigation couldn't start: its input was not admitted.";
        case 'failed': return 'Automatic investigation stopped after its input failed.';
        case 'cancelled': return 'Automatic investigation stopped after its input was cancelled.';
        default: return uncertain;
      }
    default: return uncertain;
  }
}

/** The finite save phase shares this configured choice across its newly opened issues. */
export async function readTriageIssueAutomaticInvestigationChoiceV1(
  host: TriageSessionHandoffHostV1,
  configuredActionId: string,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<TriageSessionHandoffSelectionV1 | string> {
  try {
    options.signal.throwIfAborted();
    const choices = await readTriageSessionHandoffChoicesV1(host, { task: 'investigate', signal: options.signal });
    options.signal.throwIfAborted();
    if (choices.kind === 'actionOutcome') return noticeOutcome(choices.outcome, false) ?? failure(undefined, false);
    const selection = choices.kind === 'choices'
      ? choices.actions.find(action => action.selection.configuredActionId === configuredActionId)?.selection : undefined;
    return selection ?? failure(undefined, false);
  } catch (error) {
    options.signal.throwIfAborted();
    return failure(isPluginError(error) ? error.code : undefined, false);
  }
}

/** One admitted automatic attempt. Its notice projection never becomes a retry or recovery carrier. */
export async function requestTriageIssueAutomaticInvestigationV1(
  host: TriageSessionHandoffHostV1,
  input: Readonly<{ selection: TriageSessionHandoffSelectionV1; entry: Extract<TriageSessionHandoffInputV1['context'], { kind: 'entry' }>['entry'] }>,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<string | null> {
  return requestTriageAutomaticInvestigationV1(host, { selection: input.selection,
    context: { kind: 'entry', entry: input.entry }, evidence: [{ kind: 'alertEntry', entry: input.entry }],
  }, options);
}

/** Issues and host health alerts share Triage's one admission and safe outcome projection. */
export async function requestTriageAutomaticInvestigationV1(
  host: TriageSessionHandoffHostV1,
  input: Readonly<{ selection: TriageSessionHandoffSelectionV1 }
    & Pick<TriageSessionHandoffInputV1, 'context' | 'evidence'>>,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<string | null> {
  try {
    options.signal.throwIfAborted();
    const response = await requestTriageSessionHandoffV1(host, {
      task: 'investigate', ...input.selection, delivery: 'send', context: input.context, evidence: input.evidence,
    }, options);
    options.signal.throwIfAborted();
    return noticeOutcome(response);
  } catch (error) {
    options.signal.throwIfAborted();
    return failure(isPluginError(error) ? error.code : undefined, true);
  }
}
