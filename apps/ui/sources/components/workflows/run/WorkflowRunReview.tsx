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
import { useReviewDetail } from '@/components/reviews/useReviewDetail';
import { projectReviewRoundReviewers, type ReviewRoundReviewer } from '@/components/reviews/reviewRoundReviewers';
import { readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { formatReviewFindingLocation } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { useReviewComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { REVIEW_CARD_VISIBLE_FINDINGS } from '@/components/sessions/reviews/messages/reviewFindingsMessageDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { artifactResourceRoute } from '@/utils/url/resourceRoute';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { workflowRunReviewIsResult } from './workflowRunReviewResult';

/** A finding's engine by name: the Review engine option's target through the backend label owner. */
function reviewEngineLabel(engineId: string): string {
  return resolveExecutionRunBackendLabel(resolveReviewEngineTarget(engineId)) ?? engineId;
}

/**
 * The Review a Workflow run produced, through the Review owner's `workflowRunId` link; `null` for a run that produced
 * none of its own (another round of an existing one). The run page and its embedded summary read the same list key.
 */
export function useWorkflowRunProducedReview(runId: string, scope: ServerAccountScope | null, enabled: boolean) {
  const list = useReviewList({ workflowRunId: runId, limit: 1 }, { scope, enabled });
  return list.items?.[0] ?? null;
}

/** The Review a Run produced, and whether its final output is that Review. */
export type WorkflowRunResultReview = Readonly<{
    reviewId: string;
    isResult: boolean;
    /** Settled outcomes for this Run's own round, even after another Run retries the Review. */
    reviewers?: readonly ReviewRoundReviewer[];
}>;

/**
 * The Run page's one reading of the Review its Run produced (the Review owner's `workflowRunId` link) and whether the
 * final output is that Review. The page and its embedded summary share the one list key.
 */
export function useWorkflowRunResultReview(params: Readonly<{
    runId: string | null;
    scope: ServerAccountScope | null;
    result: JsonValue | undefined;
    /** The final output's producing step; none when the Run declares no output of its own. */
    finalOutputInvocationId: string | null | undefined;
    enabled: boolean;
}>): WorkflowRunResultReview | null {
    const review = useWorkflowRunProducedReview(params.runId ?? '', params.scope,
        params.enabled && params.runId !== null);
    const reviewId = params.runId !== null ? review?.reviewId ?? null : null;
    const detail = useReviewDetail(reviewId ?? '', { scope: params.scope,
        enabled: params.enabled && reviewId !== null, includeRecord: true });
    const record = detail.data?.record;
    return React.useMemo(() => {
        if (reviewId === null) return null;
        const round = record?.rounds.filter(round => round.runs.some(run => run.kind === 'workflow' && run.runId === params.runId)).at(-1);
        return { reviewId,
            reviewers: round && round.state !== 'running' ? projectReviewRoundReviewers(round, undefined) : undefined,
            isResult: workflowRunReviewIsResult({ reviewId, finalOutputInvocationId: params.finalOutputInvocationId,
                result: params.result }) };
    }, [reviewId, record, params.runId, params.finalOutputInvocationId, params.result]);
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
    /** The run page's own header opens this Review (its result), so the summary offers no second way in. */
    openedFromHeader?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** A transcript fold retains its ordinary Run entry when this Run produced no Review. */
    fallback?: React.ReactNode;
    footerAction?: React.ReactNode;
    /** The producing Run's retained cause, used only if the linked Review failed. */
    workflowFailureCode?: string | null;
  }>,
): React.ReactElement | null {
  const router = useRouter();
  const review = useWorkflowRunProducedReview(props.runId, props.scope, props.enabled);
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
          // One standing per row, in the history owner's order (lab `hunts-running`); the rest is on the Review page.
          meta: facts[0] ?? null,
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
  if (!reviewId) return <>{props.fallback}</>;
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
        workflowFailureCode={props.workflowFailureCode}
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
        {...(props.openedFromHeader ? {} : { onOpenReview: open })}
        footerAction={props.footerAction}
      />
    </View>
  );
}
