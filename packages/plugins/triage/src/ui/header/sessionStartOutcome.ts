import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';
import type { TriageEntrySessionStartPhaseV1 } from './useEntrySessionStart.js';

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
}>;

function notice(
  tone: TriageEntrySessionNoticeV1['tone'],
  labelKey: string,
  label: string,
): TriageEntrySessionNoticeV1 {
  return Object.freeze({ tone, labelKey, label });
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
  repositoryModeRequiresSelectedProject: notice(
    'warning',
    'plugins.triage.surface.session.rejected.selectedProject',
    'This action needs the project you selected, and no project came back with your choice.',
  ),
});

function settledNotice(
  result: TriageStartEntrySessionResultV1,
): TriageEntrySessionNoticeV1 | null {
  switch (result.type) {
    case 'opened':
      return null;
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
    case 'creationFailed':
      return notice(
        'danger',
        'plugins.triage.surface.session.creationFailed',
        'This session could not be created.',
      );
    case 'workspacePreparationFailed':
      // `retryable` asks one question: could this same request, repeated
      // unchanged, succeed later? Saying so is the difference between offering
      // a useful retry and offering one that re-sends known-stale facts.
      return result.retryable
        ? notice(
          'warning',
          'plugins.triage.surface.session.workspaceUnavailable',
          'The review workspace could not be prepared just now. Nothing was created.',
        )
        : notice(
          'warning',
          'plugins.triage.surface.session.workspaceRefused',
          'A review workspace could not be prepared for this entry, so nothing was created.',
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
          // The canonical admission verdict, told as itself. A refusal and an
          // unknown outcome used to arrive here as success, because the send was
          // awaited and its value discarded — telling somebody their work has
          // started when it has not is the worst thing this surface can say.
          switch (phase.delivery.status) {
            case 'rejected':
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
            default:
              return settled;
          }
        default:
          return settled;
      }
    }
    case 'unavailable':
      switch (phase.reason) {
        case 'newSessionUnsupported':
          return notice(
            'warning',
            'plugins.triage.surface.session.newSessionUnsupported',
            'This screen cannot open the New Session surface, so nothing was started.',
          );
        case 'newSessionUnavailable':
          return notice(
            'warning',
            'plugins.triage.surface.session.newSessionUnavailable',
            'The New Session surface did not settle on something a session can be started from.',
          );
        case 'preparedWorkspaceUnsupported':
          return notice(
            'warning',
            'plugins.triage.surface.session.preparationUnsupported',
            'This source cannot prepare a review workspace, so a pull request cannot be fixed here.',
          );
        case 'reviewStartUnsupported':
          return notice(
            'warning',
            'plugins.triage.surface.session.reviewStartUnsupported',
            'A formal code review needs a workspace prepared from this pull request, and no configured source can prepare one \u2014 so nothing was started.',
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
      }
  }
}
