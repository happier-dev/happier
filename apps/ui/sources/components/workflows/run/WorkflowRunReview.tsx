import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { projectReviewFindingRoots } from '@/components/reviews/finding/reviewFindingRoots';
import { reviewHistoryFacts } from '@/components/reviews/detail/reviewFindingFacts';
import { ReviewSummaryHost } from '@/components/reviews/summary/ReviewSummaryHost';
import type { ReviewSummaryRow } from '@/components/reviews/summary/ReviewSummary';
import { useReviewHistory } from '@/components/reviews/useReviewHistory';
import { useReviewList } from '@/components/reviews/useReviewList';
import { readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { formatReviewFindingLocation } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { useReviewComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { REVIEW_CARD_VISIBLE_FINDINGS } from '@/components/sessions/reviews/messages/reviewFindingsMessageDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { artifactResourceRoute } from '@/utils/url/resourceRoute';

/** A finding's engine by name: the Review engine option's target through the backend label owner. */
function reviewEngineLabel(engineId: string): string {
  return resolveExecutionRunBackendLabel(resolveReviewEngineTarget(engineId)) ?? engineId;
}

/**
 * The Review a Workflow run produced (a Hunt's findings so far, lab `hunts-running`), drawn with the shared Review
 * summary. The run → Review link is the Review owner's `workflowRunId`; a run that produced no Review of its own
 * (another round of an existing one) shows nothing rather than a guessed match.
 */
export function WorkflowRunReview(
  props: Readonly<{
    runId: string;
    scope: ServerAccountScope | null;
    enabled: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
  }>,
): React.ReactElement | null {
  const router = useRouter();
  const list = useReviewList(
    { workflowRunId: props.runId, limit: 1 },
    { scope: props.scope, enabled: props.enabled },
  );
  const review = list.items?.[0] ?? null;
  const reviewId = review?.reviewId ?? null;
  const comments = useReviewComments({
    scope: props.scope,
    reviewId,
    enabled: props.enabled && reviewId !== null,
  });
  const history = useReviewHistory(
    { reviewId: reviewId ?? '', workflowId: review?.workflowId ?? undefined },
    {
      scope: props.scope,
      enabled:
        props.enabled && reviewId !== null && Boolean(review?.workflowId),
    },
  );
  const roots = React.useMemo(
    () => projectReviewFindingRoots(reviewId ?? '', comments.comments).rows,
    [comments.comments, reviewId],
  );
  const historyByIdentity = React.useMemo(
    () =>
      new Map(
        history.data?.items.map(
          (item) => [item.findingIdentity, reviewHistoryFacts(item)] as const,
        ) ?? [],
      ),
    [history.data],
  );
  const rows = React.useMemo(
    (): readonly ReviewSummaryRow[] =>
      roots.slice(0, REVIEW_CARD_VISIBLE_FINDINGS).map((row) => {
        const facts = row.comment.findingIdentity
          ? (historyByIdentity.get(row.comment.findingIdentity) ?? [])
          : [];
        return {
          rowId: row.rowId,
          severity: row.finding.severity,
          title: row.finding.title,
          location: formatReviewFindingLocation(row.finding),
          reviewer:
            (row.comment.engineId
              ? reviewEngineLabel(row.comment.engineId)
              : null) ?? '',
          decision: readReviewFindingDecision(
            row.comment.reviewTriageStatus,
            row.comment.state,
            comments.pending[row.rowId],
          ),
          meta: facts.length > 0 ? joinHappierFacts(...facts) : null,
        };
      }),
    [comments.pending, historyByIdentity, roots],
  );
  const reviewers = React.useMemo(
    () =>
      [
        ...new Set(
          roots.flatMap((row) =>
            row.comment.engineId ? [row.comment.engineId] : [],
          ),
        ),
      ].map((backendId) => ({
        backendId,
        label: reviewEngineLabel(backendId),
      })),
    [roots],
  );
  if (!reviewId) return null;
  const open = () =>
    router.push(
      artifactResourceRoute(
        { kind: 'artifact', artifactId: reviewId },
        props.scope?.serverId,
      ) as never,
    );
  const hidden = roots.length - rows.length;
  return (
    <View testID={props.testID} style={props.style}>
      <ReviewSummaryHost
        reviewId={reviewId}
        scope={props.scope}
        subject={null}
        rows={rows}
        reviewers={reviewers}
        more={
          hidden > 0
            ? {
                label: t('reviewWalkthrough.finished.andMore', {
                  count: hidden,
                }),
                onPress: open,
              }
            : null
        }
        onOpenReview={open}
      />
    </View>
  );
}
