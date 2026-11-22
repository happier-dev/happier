import * as React from 'react';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { presentReviewRoundQualityV1 } from '@happier-dev/protocol/reviews/reviewQualityPresentationV1';
import { readReviewFindingRevisedBodyV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { readReviewFindingDecisionV1, type ReviewCommentV1, type ReviewFinding } from '@happier-dev/plugin-sdk/reviews';
import { useLivePluginResourceProjection, type PluginUiResourceProjection, type PluginUiResourceProjectionSnapshot } from '../hostApi/index.js';
import { usePluginHostApi } from '../hostApi/context.js';
import { reviewDetailProjection } from '../hostApi/reviewDetailProjection.js';
import { HappierReviewSummary, projectHappierReviewGlance } from '../presentation/work/ReviewSummary.js';
import { HappierPageSheet } from '../presentation/layout/PageSection.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { resolveHappierWorkTheme } from '../presentation/work/workTheme.js';
import { HappierReviewFinding, HappierReviewFindingBody, formatHappierReviewFindingLocation } from './ReviewFinding.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Stack } from './Layout.js';
import { Button } from './Button.js';
import { ErrorState, LoadingState } from './State.js';
import { Markdown } from './Content.js';
import { Text } from './Text.js';
import { Timeline } from './Timeline.js';

/** The admitted host projects roots using the native finding owner, retaining its finite cursor. */
export type HappierReviewFindingWindow = Readonly<{
  status: 'idle' | 'loading' | 'loaded' | 'failed';
  comments: readonly ReviewCommentV1[];
  pending: Readonly<Record<string, NonNullable<ReviewCommentV1['reviewTriageStatus']>>>;
  cursor: string | null;
  rows: readonly Readonly<{ rowId: string; finding: ReviewFinding; comment: ReviewCommentV1 }>[];
  unavailableFindings: readonly ReviewCommentV1[];
}>;
export type HappierReviewSummaryHandle = Readonly<{ refresh: () => Promise<void> }>;
export type HappierReviewSummaryHostProps = Readonly<{
  reviewId: string;
  /**
   * The Review is the page's own subject (Triage's Review entry), not a section of another page (a pull request):
   * while a finding waits for the reader's decision, Open review is the page's one primary (Reviews: implementing
   * leads only once every finding is decided).
   */
  leadsPage?: boolean;
}>;

function jsonProjection<T>(): PluginUiResourceProjection<T> {
  return { decode(content, previous) {
    // The host Resource is the admitted, typed producer; no provider-owned reader parses comments.
    const next = JSON.parse(new TextDecoder().decode(content.bytes)) as T;
    return previous && pluginJsonValuesEqual(previous, next) ? previous : next;
  } };
}
const findingsProjection = jsonProjection<HappierReviewFindingWindow>();
const select = <T,>(snapshot: PluginUiResourceProjectionSnapshot<T>) => snapshot;
const actorName = (actor: ReviewCommentV1['author']) => actor.kind === 'user' ? actor.userId
  : actor.kind === 'plugin' ? actor.pluginId : actor.kind === 'workflow' ? actor.runId : actor.agentId;

/** An admitted Review's shared summary and disclosure. Writes stay in the existing native Review. */
export const HappierReviewSummaryHost = React.forwardRef<HappierReviewSummaryHandle, HappierReviewSummaryHostProps>(
function HappierReviewSummaryHost({ reviewId, leadsPage }, ref) {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { palette } = resolveHappierWorkTheme(usePluginTheme());
  const detailResource = useLivePluginResourceProjection({ hostRead: 'review.get', input: { reviewId } }, reviewDetailProjection, select);
  const findingResource = useLivePluginResourceProjection({ hostRead: 'reviews.comments.list', input: { reviewId } }, findingsProjection, select);
  const detail = detailResource.value;
  const window = findingResource.value.value;
  const [opened, setOpened] = React.useState<string | null>(null);
  React.useImperativeHandle(ref, () => ({ refresh: async () => {
    await Promise.all([detailResource.refresh(), findingResource.refresh()]);
  } }), [detailResource.refresh, findingResource.refresh]);
  const glance = projectHappierReviewGlance(undefined, detail.value?.review ?? null, {
    running: text('happier.plugin-ui.review.glance.running', 'Reviewing…'),
    failed: text('happier.plugin-ui.review.glance.failed', 'The review couldn’t finish'),
    noFindings: text('happier.plugin-ui.review.glance.noFindings', 'Nothing to fix'),
    allDecided: text('happier.plugin-ui.review.glance.allDecided', 'Every finding is decided'),
    toDecide: count => text(`happier.plugin-ui.review.glance.toDecide.${count === 1 ? 'one' : 'other'}`,
      count === 1 ? '1 finding to decide' : '{count} findings to decide', { count }),
    findingsCount: count => text(`happier.plugin-ui.review.glance.findingsCount.${count === 1 ? 'one' : 'other'}`,
      count === 1 ? '1 finding' : '{count} findings', { count }),
  });
  const quality = presentReviewRoundQualityV1(detail.freshness === 'fresh' ? detail.value?.roundQuality ?? null : null);
  const qualityGlance = glance && quality ? { ...glance, facts: [...glance.facts,
    text('happier.plugin-ui.review.glance.quality', 'Quality {score}/5', { score: quality.displayScore }),
    text('happier.plugin-ui.review.glance.reviewerScores', 'Reviewer scores: {scores}',
      { scores: quality.reviewers.map(({ displayName, score }) => displayName ? `${displayName} ${score}` : `${score}`).join(', ') }),
  ] } : glance;
  const decisionWord = (decision: ReturnType<typeof readReviewFindingDecisionV1>) => {
    switch (decision) {
      case 'accept': return text('happier.plugin-ui.review.decision.accept', 'Implement fix');
      case 'reject': return text('happier.plugin-ui.review.decision.reject', 'Ignored');
      case 'defer': return text('happier.plugin-ui.review.decision.defer', 'Later');
      default: return text('happier.plugin-ui.review.decision.undecided', 'Undecided');
    }
  };
  const severityWord = (severity: ReviewFinding['severity']) => text(`happier.plugin-ui.review.severity.${severity}`,
    severity.charAt(0).toUpperCase() + severity.slice(1));
  const unavailable = text('happier.plugin-ui.review.unavailable', 'This review didn’t open');
  const openReview = async () => {
    try { await host.openResource({ kind: 'artifact', artifactId: reviewId }); }
    catch { await host.notify(text('happier.plugin-ui.action.error.failed', 'The action failed.'), { severity: 'error' }); }
  };
  const row = window?.rows.find(value => value.rowId === opened);
  const decision = row ? readReviewFindingDecisionV1(row.comment.reviewTriageStatus, row.comment.state, window?.pending[row.rowId]) : null;
  return <HappierPageSheet colors={palette} rowDividers={false}>
    <Stack gap="small" style={{ paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
      paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx }}>
      {qualityGlance === null ? detail.error ? <ErrorState title={unavailable} /> : <LoadingState /> : <>
        <HappierReviewSummary heading={text('happier.plugin-ui.review.heading', 'Review')} subject={null}
          glance={qualityGlance} rows={(window?.rows ?? []).map(value => {
            // Where it is, as the Review page's rows say it. The author here is only an id, never shown as a name.
            const location = formatHappierReviewFindingLocation(value.finding);
            return { rowId: value.rowId, severity: value.finding.severity, severityLabel: severityWord(value.finding.severity),
              ...(location === null ? {} : { location }), title: value.finding.title, reviewer: null, accessibilityLabel: value.finding.title };
          })}
          onOpenRow={id => setOpened(current => current === id ? null : id)} reviewers=""
          more={window?.cursor ? <Button title={text('happier.plugin-ui.review.more', 'More findings · Open review')}
            variant="plain" size="small" onPress={openReview} /> : undefined}
          actions={<Button title={text('happier.plugin-ui.review.open', 'Open review')} size="small" onPress={openReview}
            variant={leadsPage === true && detail.value?.human.needsYou.pendingDecisions === true ? 'primary' : 'secondary'} />} />
        {row && decision ? <HappierReviewFinding rowId={row.rowId} finding={row.finding}
          accessibilityLabel={row.finding.title}
          severityLabel={severityWord(row.finding.severity)} location={formatHappierReviewFindingLocation(row.finding)}
          decision={{ value: decision, label: decisionWord(decision) }} decisionEditable={false}
          expanded onToggleExpanded={() => setOpened(null)}>
          <HappierReviewFindingBody rowId={row.rowId} finding={row.finding}
            currentBodyMarkdown={readReviewFindingRevisedBodyV1(row.comment)}
            labels={{ where: text('happier.plugin-ui.review.where', 'Where'),
              verification: text('happier.plugin-ui.review.verification', 'How it was verified'),
              conversation: text('happier.plugin-ui.review.conversation', 'Conversation') }}
            conversation={<Stack gap="small">
              <Timeline inline items={row.comment.transitions} keyForItem={event => event.transitionId}
                renderItem={event => ({ glyph: null, heading: actorName(event.transitionedBy),
                  body: <Text value={event.reason ?? decisionWord(readReviewFindingDecisionV1(event.reviewTriageStatus, event.toState))} /> })} />
              <Timeline inline items={row.comment.edits} keyForItem={event => event.editId}
                renderItem={event => ({ glyph: null, heading: actorName(event.editedBy),
                  body: <Text value={text('happier.plugin-ui.review.edited', 'Edited the finding')} /> })} />
              {window?.comments.filter(comment => comment.parentCommentId && comment.threadId === row.comment.threadId).map(comment =>
                <Stack key={comment.id} gap="small"><Text value={actorName(comment.author)} tone="secondary" />
                  {typeof comment.body === 'string' ? <Markdown value={comment.body} /> : null}</Stack>)}
            </Stack>} />
        </HappierReviewFinding> : null}
        {findingResource.value.pending === 'initial' ? <LoadingState /> : null}
        {detail.error || findingResource.value.error || window?.status === 'failed' || window?.unavailableFindings.length
          ? <ErrorState title={unavailable} /> : null}
      </>}
    </Stack>
  </HappierPageSheet>;
});
