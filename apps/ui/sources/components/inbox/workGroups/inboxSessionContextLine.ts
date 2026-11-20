import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { resolveSessionContextLine } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { t } from '@/text';
import { presentSessionAwarenessNowLineV1 } from '@/utils/sessions/sessionUtils';
import { sessionFollowSourceRuntimeStateLabel } from '@/components/sessions/follow/sessionFollowSourcePresentation';
import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { readSessionListPresentationRuntime } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

/**
 * What an Inbox session row says under its title: what the session needs from the person first (the
 * Session row's own words for its attention state, "ready for review", "Mentioned you"), then a
 * running Session work, then where it runs. The Home is named only when the Inbox spans
 * more than one Home; otherwise it would repeat down every row. A worker reporting to a lead says
 * that instead of where it runs (every report runs beside its lead, so the place only repeats down
 * the list): its latest update, then "Reports to <lead>" (lab `inbox-I1`). Pure, so the Voice brief
 * draws the same line without importing the row's component tree.
 */
export function buildInboxSessionContextLine(
  candidate: InboxSessionAttentionEntry['candidate'],
  options: Readonly<{
    showHome: boolean;
    showNeed?: boolean;
    /** The lead this Session reports to and its latest update, from the Inbox item (`reportsTo`, `workerUpdateHeadline`). */
    worker?: Readonly<{ leadTitle: string | null; headline?: string }>;
  }> = { showHome: true },
): string | undefined {
  if (candidate.followRuleEvaluationState) return sessionFollowSourceRuntimeStateLabel(candidate.followRuleEvaluationState);
  // The row states one status, through the work-status owner. When that status already reads
  // unknown or offline, the Home's currentness ("Offline", "Couldn't refresh") is the same fact
  // said twice, so the line drops it. Read from the candidate's own awareness, so every caller
  // (Needs you, Updates, the Voice brief) agrees without being told.
  const rowStatus = readSessionAwarenessPresentationV1(candidate.awareness);
  const statusSaysNotCurrent = rowStatus === 'unknown' || rowStatus === 'disconnected';
  const need = options.showNeed !== false ? readInboxSessionNeed(candidate) : null;
  const context = candidate.context
    ? (resolveSessionContextLine(
        {
          segments: candidate.context.segments.filter(
            (segment) => (options.showHome || segment.kind !== 'home')
              && (!statusSaysNotCurrent || segment.kind !== 'freshness'),
          ),
        },
        { showWorkspace: true },
      ) ?? candidate.subtitle.trim())
    : candidate.subtitle.trim();
  const reportsTo = options.worker?.leadTitle ? t('inbox.work.rows.reportsTo', { lead: options.worker.leadTitle }) : null;
  return (
    joinHappierFacts(
      need,
      presentSessionAwarenessNowLineV1(candidate.awareness),
      readRunningWork(candidate),
      reportsTo ? options.worker?.headline ?? null : null,
      reportsTo ?? context,
    ) || undefined
  );
}

function readRunningWork(candidate: InboxSessionAttentionEntry['candidate']): string | null {
  const working = candidate.awareness.runningWorkCount ?? 0;
  return working > 0 ? t('sessionWork.strip.stillWorking', { count: working }) : null;
}

/**
 * Why this session is in front of the person, and only that: the context line without where it runs,
 * for a surface that already says what the row is about (the Voice brief).
 */
export function buildInboxSessionReasonLine(
  candidate: InboxSessionAttentionEntry['candidate'],
  options: Readonly<{ showNeed?: boolean }> = {},
): string | undefined {
  let reason: string | null = null;
  if (options.showNeed !== false) {
    reason = presentSessionAwarenessNowLineV1(candidate.awareness) ?? null;
    if (!reason && candidate.personalAttention.reasons.includes('failed')) {
      const issue = candidate.presentationSource ? readSessionListPresentationRuntime(candidate.presentationSource).lastRuntimeIssue : candidate.session.lastRuntimeIssue;
      reason = presentSessionRuntimeIssue(issue).summary;
    }
    if (!reason && candidate.reasons.hasBlockedPendingDelivery) reason = t('session.pendingMessages.deliveryBlockedReasons.unknown');
    reason ??= readInboxSessionNeed(candidate);
  }
  return joinHappierFacts(reason, readRunningWork(candidate)) || undefined;
}

/**
 * What the session needs from the person, in the Session row's own words for its attention state
 * ("Ready for review", "Mentioned you"), or null when its attention state says nothing. It opens the
 * row's line, so it starts as a sentence does. A failure is a status, not a need: the row states its
 * one status through the work-status owner, so the line never says "error" beside it.
 */
export function readInboxSessionNeed(
  candidate: InboxSessionAttentionEntry['candidate'],
): string | null {
  const { state, word } = candidate.workStatus;
  if (state !== 'finished_unseen' && state !== 'mentioned' && state !== 'unread' && state !== 'pending_input') return null;
  const words = word;
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}
