import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';
import type { TriageEntrySessionStartPhaseV1 } from '../../sessions/entrySessionStartController.js';
import type { TriageNewSessionFailureV1 } from './newSessionSeedCommand.js';

/**
 * A Session id or canonical pending creation answers for the logical start.
 * An early refusal only answers for its dispatch, not an earlier lost reply.
 * Both single and bulk controllers use this before releasing unknown custody.
 */
export function resolvesTriageUnknownSessionStartV1(result: TriageStartEntrySessionResultV1): boolean {
  return result.type === 'creationPending'
    || result.type === 'linkPending'
    || result.type === 'openPending'
    || result.type === 'linked'
    || result.type === 'opened';
}

/**
 * What a press is allowed to tell the reader, and the ONE place it is decided.
 *
 * A control whose press reports nothing is not really pressable: every arm the
 * orchestrator can settle on — a Session that exists but is not linked, one that
 * is linked but did not open, a creation whose outcome is genuinely unknown —
 * leaves the reader holding a different next move, and collapsing them into
 * silence or one shrug is what made the earlier header untestable as a product
 * surface.
 *
 * `opened` says nothing on purpose: the host has already navigated to the
 * Session, so the notice would be addressed to a screen the reader has left.
 * `choosing` says nothing for the same reason — the host's own New Session
 * surface is what they are looking at.
 *
 * It projects; it does not retry. `resumeEntrySessionStart` owns the phase
 * retries — reached by pressing the same action again, which the controller's
 * retained custody turns into a resume of the same Session rather than a second
 * one — and a notice that offered its own would be a second retry policy.
 */

export type TriageEntrySessionNoticeV1 = Readonly<{
  tone: 'muted' | 'warning' | 'danger';
  labelKey: string;
  label: string;
  failureCode?: string;
  failure?: TriageNewSessionFailureV1;
}>;

function notice(
  tone: TriageEntrySessionNoticeV1['tone'],
  labelKey: string,
  label: string,
  failure?: TriageNewSessionFailureV1,
): TriageEntrySessionNoticeV1 {
  return Object.freeze({ tone, labelKey, label, ...(failure === undefined ? {} : { failure }) });
}

const REJECTION_NOTICE_V1: Readonly<Record<
  Extract<TriageStartEntrySessionResultV1, Readonly<{ type: 'rejected' }>>['reason'],
  TriageEntrySessionNoticeV1
>> = Object.freeze({
  existingSessionRequiresReferenceOnlyMode: notice(
    'warning',
    'plugins.triage.surface.session.rejected.existingSession',
    'This action needs its own working directory, so it cannot run in a session that already exists.',
  ),
  referenceOnlyModeRequiresReferenceOnlyWorkspace: notice(
    'warning',
    'plugins.triage.surface.session.rejected.referenceOnly',
    'This action does not work in a checkout, so it was not started in one.',
  ),
  pullRequestModeRequiresPreparedWorkspace: notice(
    'warning',
    'plugins.triage.surface.session.rejected.preparedWorkspace',
    'This action needs a review workspace prepared by the source, and none was.',
  ),
  pullRequestWorkspaceEntryMismatch: notice(
    'warning',
    'plugins.triage.surface.session.rejected.preparedWorkspaceEntryMismatch',
    'The selected review workspace did not belong to this pull request, so nothing was started.',
  ),
  repositoryModeRequiresSelectedProject: notice(
    'warning',
    'plugins.triage.surface.session.rejected.selectedProject',
    'This action needs the project you selected, and no project came back with your choice.',
  ),
  orchestrationRequiresNewSessionWithEntryInput: notice(
    'warning',
    'plugins.triage.surface.session.rejected.orchestration',
    'Orchestrate this needs a new session, your prompt and the attached issue.',
  ),
});

function settledNotice(
  result: TriageStartEntrySessionResultV1,
): TriageEntrySessionNoticeV1 | null {
  switch (result.type) {
    case 'opened':
      return null;
    case 'linked':
      return notice(
        'warning',
        'plugins.triage.surface.session.linkedNotOpened',
        'The session was created and linked, but it was not opened.',
      );
    case 'linkPending':
      return notice(
        'warning',
        'plugins.triage.surface.session.linkPending',
        'The session was created, but this entry is not linked to it yet.',
      );
    case 'openPending':
      return notice(
        'warning',
        'plugins.triage.surface.session.openPending',
        'The session was created and linked, but Happier could not open it.',
      );
    case 'creationPending':
      // "Accepted but not yet settled" and "we do not know" are different things
      // to tell somebody deciding whether to press again.
      return result.outcome === 'accepted'
        ? notice(
          'muted',
          'plugins.triage.surface.session.creationAccepted',
          'This session is still being created.',
        )
        : notice(
          'warning',
          'plugins.triage.surface.session.creationUnknown',
          'Happier could not confirm whether this session was created. Pressing again resumes the same one rather than starting a second.',
        );
    case 'creationFailed': {
      const codes = [result.failureCode, result.failureCause?.errorCode, result.failureCause?.nativeErrorCode]
        .filter((code): code is string => typeof code === 'string');
      return notice(
        'danger',
        'plugins.triage.surface.session.creationFailed',
        'This session could not be created.',
        codes.length === 0 ? undefined : { codes },
      );
    }
    case 'workspacePreparationFailed':
      // `retryable` asks one question: could this same request, repeated
      // unchanged, succeed later? Saying so is the difference between offering
      // a useful retry and offering one that re-sends known-stale facts.
      return result.retryable
        ? notice(
          'warning',
          'plugins.triage.surface.session.workspaceUnavailable',
          'The review workspace could not be prepared just now. Nothing was created.',
          result.failure,
        )
        : notice(
          'warning',
          'plugins.triage.surface.session.workspaceRefused',
          'A review workspace could not be prepared for this entry, so nothing was created.',
          result.failure,
        );
    case 'rejected':
      return REJECTION_NOTICE_V1[result.reason];
  }
}

export function describeTriageEntrySessionPhaseV1(
  phase: TriageEntrySessionStartPhaseV1,
): TriageEntrySessionNoticeV1 | null {
  switch (phase.kind) {
    case 'idle':
    case 'choosing':
      return null;
    case 'resolving':
      return notice(
        'muted',
        'plugins.triage.surface.session.resolving',
        'Resolving this action\u2019s profile, prompt and working directory\u2026',
      );
    case 'starting':
      return notice(
        'muted',
        'plugins.triage.surface.session.starting',
        'Starting a session for this entry…',
      );
    case 'handoffSettled': {
      const result = phase.result.handoff;
      switch (result.kind) {
        case 'cancelled': return null;
        case 'composed':
          return notice('muted', 'plugins.triage.surface.session.handoffComposed', 'Added this entry to the Session draft.');
        case 'sendResult':
          if (typeof result.result !== 'object' || result.result === null || !('status' in result.result)) {
            return notice('warning', 'plugins.triage.surface.session.handoffReceipt', 'Check the selected Session for this action’s delivery result.');
          }
          switch (result.result.status) {
            case 'rejected':
              return Object.freeze({
                ...notice('warning', 'plugins.triage.surface.session.handoffRefused', 'The selected Session could not accept this action’s input.'),
                ...(typeof result.result.code === 'string' ? { failureCode: result.result.code } : {}),
              });
            case 'failed':
            case 'cancelled':
              return notice('warning', 'plugins.triage.surface.session.handoffRefused', 'The selected Session could not accept this action’s input.');
            case 'held':
              return notice('muted', 'plugins.triage.surface.session.handoffHeld', 'This action’s input is held in the selected Session.');
            default:
              return notice('muted', 'plugins.triage.surface.session.handoffSent', 'Sent this action’s input to the selected Session.');
          }
        case 'uncertain':
          return notice('warning', 'plugins.triage.surface.session.handoffUncertain',
            result.phase === 'link' ? 'The Session link could not be confirmed. Press again to resume the same request.'
              : 'Happier could not confirm this action’s input. Press again to resume the same request.');
        case 'unavailable': {
          const labels: Record<typeof result.reason, string> = {
            configuredActionUnavailable: 'This configured action is no longer available.',
            evidenceInvalid: 'The entry could not be read for this action.',
            repositoryMismatch: 'The selected Session belongs to a different repository.',
            scopeMismatch: 'This action does not match the selected Session’s scope.',
            sessionUnavailable: 'The selected Session is unavailable.',
            agentMismatch: 'The selected Session uses a different Agent than this action requires.',
            composerUnavailable: 'The selected Session’s draft is unavailable.',
            targetUnavailable: 'The selected Session’s workspace cannot run this action.',
          };
          return notice('warning', `plugins.triage.surface.session.handoffUnavailable.${result.reason}`, labels[result.reason]);
        }
        case 'selectionRequired':
        case 'placement_choice_required':
          return notice('warning', 'plugins.triage.surface.session.handoffSelection', 'This action needs another Session or workspace choice.');
        case 'entryExecution':
          return notice('warning', 'plugins.triage.surface.session.handoffUnavailable', 'This action did not settle in the selected Session.');
      }
    }
    case 'settled': {
      // The start's own verdict comes first: whether the Session exists is a
      // bigger fact than what happened to the prompt afterwards. A delivery
      // that failed is only reported once the start itself settled cleanly,
      // because telling a reader their prompt did not land is useless while
      // they are being told nothing was created.
      const settled = settledNotice(phase.result);
      if (phase.result.type !== 'opened') return settled;
      switch (phase.delivery?.kind) {
        case 'send':
          // The canonical send verdict, told as itself. A refusal and an
          // unknown outcome used to arrive here as success, because the send was
          // awaited and its value discarded — telling somebody their work has
          // started when it has not is the worst thing this surface can say.
          switch (phase.delivery.status) {
            case 'rejected':
            case 'failed':
            case 'cancelled':
              return notice(
                'warning',
                'plugins.triage.surface.session.deliveryFailed',
                'The session opened, but this action\u2019s prompt could not be placed in it.',
              );
            case 'outcomeUnknown':
              return notice(
                'warning',
                'plugins.triage.surface.session.deliveryUnknown',
                'The session opened, but Happier could not confirm whether this action\u2019s prompt was sent. Pressing again resends the same one rather than a second.',
              );
            case 'notRequested':
            case 'none':
            case 'accepted':
            case 'alreadyAccepted':
            case 'held':
            case 'replied':
              return settled;
          }
        default:
          return settled;
      }
    }
    case 'unavailable':
      switch (phase.reason) {
        case 'handoffOutcomeUnknown':
          return notice('warning', 'plugins.triage.surface.session.handoffOutcomeUnknown',
            'Happier could not confirm this action’s outcome. Check the selected Session before trying again.');
        case 'newSessionUnsupported':
          return notice(
            'warning',
            'plugins.triage.surface.session.newSessionUnsupported',
            'This screen cannot open the New Session surface, so nothing was started.',
          );
        case 'newSessionUnavailable':
          if (phase.failure?.codes.includes('workspaceMismatch')) {
            return notice(
              'warning',
              'plugins.triage.surface.session.workspaceMismatch',
              'This project cannot prepare the source’s checkout. Choose a project on the source’s Machine with a matching repository.',
            );
          }
          return notice(
            'warning',
            'plugins.triage.surface.session.newSessionUnavailable',
            'The New Session surface did not settle on something a session can be started from.',
          );
        case 'preparedWorkspaceUnsupported':
          return notice(
            'warning',
            'plugins.triage.surface.session.preparationUnsupported',
            'This source cannot prepare a review workspace, so actions that need one cannot start here.',
          );
        // The four reference refusals. Each says which catalog, and each says
        // whether the fix is to repair the configuration or to try again —
        // because nothing was created, and the reader is the one who decides.
        case 'profileMissing':
          return notice(
            'warning',
            'plugins.triage.surface.session.profileMissing',
            'This action\u2019s launch profile no longer exists, so nothing was started. Pick another one in Configure actions.',
          );
        case 'profileUnavailable':
          return notice(
            'warning',
            'plugins.triage.surface.session.profileUnavailable',
            'Happier could not read your launch profiles, so nothing was started. Try again in a moment.',
          );
        case 'promptMissing':
          return notice(
            'warning',
            'plugins.triage.surface.session.promptMissing',
            'This action\u2019s prompt no longer exists in your Prompt Library, so nothing was started. Pick another one in Configure actions.',
          );
        case 'promptInvalid':
          return notice(
            'warning',
            'plugins.triage.surface.session.promptInvalid',
            'This action\u2019s prompt resolved to no content, so nothing was started. Edit the prompt before trying again.',
          );
        case 'instructionMissing':
          return notice(
            'warning',
            'plugins.triage.surface.session.instructionMissing',
            'This action needs an instruction before it can start work. Choose a Prompt Library entry in Configure actions.',
          );
        case 'promptUnavailable':
          return notice(
            'warning',
            'plugins.triage.surface.session.promptUnavailable',
            'Happier could not read this action\u2019s prompt, so nothing was started. Try again in a moment.',
          );
        case 'dispatch':
          return notice(
            'danger',
            'plugins.triage.surface.session.dispatchFailed',
            'Nothing was started: this screen could not reach the session it asked for.',
          );
        // The request left and its answer did not come back, so "nothing was
        // started" is not something this screen knows. It is the same fact the
        // orchestrator's own unknown creation reports, and the same sentence,
        // because the reader's next move is identical: press again, and the
        // retained identity resumes the one request rather than making a second.
        case 'startOutcomeUnknown':
          return notice(
            'warning',
            'plugins.triage.surface.session.creationUnknown',
            'Happier could not confirm whether this session was created. Pressing again resumes the same one rather than starting a second.',
          );
      }
  }
}
