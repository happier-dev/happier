import type { InboxSessionAttentionEntry } from '@/activity/presentation/buildInboxSessionPresentation';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import {
  resolveSessionRowAttentionState,
  resolveSessionRowPresentation,
} from '@/components/sessions/shell/row/resolveSessionRowPresentation';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { resolveSessionContextLine } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { t } from '@/text';

/**
 * What an Inbox session row says under its title: what the session needs from the person first (the
 * Session row's own words for its attention state, "ready for review", "Mentioned you"), then a
 * lead's working reports (ORC R-10), then where it runs. The Home is named only when the Inbox spans
 * more than one Home; otherwise it would repeat down every row. Pure, so the Voice brief draws the
 * same line without importing the row's component tree.
 */
export function buildInboxSessionContextLine(
  candidate: InboxSessionAttentionEntry['candidate'],
  options: Readonly<{
    showHome: boolean;
    showNeed?: boolean;
  }> = { showHome: true },
): string | undefined {
  // The row states one status, through the work-status owner. When that status already reads
  // unknown or offline, the Home's currentness ("Offline", "Couldn't refresh") is the same fact
  // said twice, so the line drops it. Read from the candidate's own awareness, so every caller
  // (Needs you, Updates, the Voice brief) agrees without being told.
  const rowStatus = readSessionAwarenessPresentationV1(candidate.awareness);
  const statusSaysNotCurrent = rowStatus === 'unknown' || rowStatus === 'disconnected';
  const reports = candidate.session.reports;
  const outstandingReports = reports
    ? reports.working + reports.needsYou + reports.stalled
    : 0;
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
  return (
    joinHappierFacts(
      need,
      outstandingReports > 0
        ? t('sessionWork.strip.stillWorking', { count: outstandingReports })
        : null,
      context,
    ) || undefined
  );
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
  if (candidate.attentionState === 'failed') return null;
  const needKey = resolveSessionRowPresentation({
    attentionState: resolveSessionRowAttentionState(candidate.attentionState),
    density: 'default',
    requestedSecondaryLineMode: 'status',
    hasPathSubtitle: false,
  }).accessibilityStatusTextKey;
  if (!needKey) return null;
  const words = t(needKey);
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}
