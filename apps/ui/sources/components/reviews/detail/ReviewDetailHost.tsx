import * as React from 'react';
import {
  openReviewArtifactV1,
  REVIEW_ARTIFACT_KIND_V1,
  type ReviewArtifactV1,
  type ReviewRoundStateV1,
} from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
  ReviewDetailState,
  ReviewDetailView,
  type ReviewDetailGlance,
  type ReviewDetailRound,
  type ReviewDetailTab,
  type ReviewDetailTabId,
} from './ReviewDetailView';

/** Whether an opened Artifact is a Review: its header names the Review kind. */
export function isReviewArtifact(
  artifact: Pick<DecryptedArtifact, 'header' | 'rawHeader'>,
): boolean {
  return (artifact.rawHeader ?? artifact.header)?.kind === REVIEW_ARTIFACT_KIND_V1;
}

const ROUND_STATE_KEYS = {
  running: 'reviewWalkthrough.collection.stateRunning',
  completed: 'reviewWalkthrough.collection.stateCompleted',
  partial: 'reviewWalkthrough.collection.statePartial',
  failed: 'reviewWalkthrough.collection.stateFailed',
  cancelled: 'reviewWalkthrough.collection.stateCancelled',
} as const satisfies Record<ReviewRoundStateV1, string>;

type ReviewRecordRound = ReviewArtifactV1['rounds'][number];

/** The opened record's rounds as the page draws them: who reviewed and how the round ended. */
function projectRound(round: ReviewRecordRound): ReviewDetailRound {
  const state = t(ROUND_STATE_KEYS[round.state]);
  return {
    ordinal: round.ordinal,
    state: round.state,
    groups: [
      {
        id: 'reviewers',
        title: t('reviewWalkthrough.detail.reviewersCount', {
          count: round.reviewerIds.length,
        }),
        detail: state,
        detailTone: round.state === 'failed' ? 'failed' : null,
        status:
          round.state === 'running'
            ? 'running'
            : round.state === 'failed' || round.state === 'partial'
              ? 'failed'
              : 'done',
        participants: [],
      },
    ],
  };
}

/** Running and failed rounds say so; a settled round's verdict comes from its findings counts (review.get). */
function projectGlance(
  round: ReviewRecordRound | undefined,
): ReviewDetailGlance | null {
  if (!round) return null;
  if (round.state === 'running')
    return {
      sentence: t('reviewWalkthrough.detail.glanceRunning'),
      tone: 'quiet',
      facts: [],
    };
  if (round.state === 'failed')
    return {
      sentence: t('reviewWalkthrough.detail.glanceFailed'),
      tone: 'failed',
      facts: [],
    };
  if (round.summary)
    return { sentence: round.summary, tone: 'quiet', facts: [] };
  return null;
}

/**
 * A Review opened from its Artifact (plan 04 U4): the one decrypted body read the Artifacts view already
 * made, decoded by the protocol's Review decoder, composed into the Review page. Findings, people's
 * verdicts and Changes join through their owners' seams as they land; until then the page shows what the
 * record holds: the rounds and their runs, each opening its own result.
 */
export function ReviewDetailHost(
  props: Readonly<{
    artifact: DecryptedArtifact;
    bodyState: 'ready' | 'loading' | 'missing' | 'failed';
    onRetry: () => void;
  }>,
): React.ReactElement {
  const { artifact } = props;
  const record = React.useMemo((): ReviewArtifactV1 | null => {
    if (typeof artifact.body !== 'string') return null;
    try {
      return openReviewArtifactV1({
        artifactId: artifact.id,
        header: artifact.rawHeader ?? artifact.header ?? {},
        body: artifact.body,
      });
    } catch {
      return null;
    }
  }, [artifact.body, artifact.header, artifact.id, artifact.rawHeader]);
  const lastOrdinal = record?.rounds.at(-1)?.ordinal ?? 1;
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedRound = selected ?? lastOrdinal;
  const [tab, setTab] = React.useState<ReviewDetailTabId>('runs');
  const rounds = React.useMemo(
    () => record?.rounds.map(projectRound) ?? [],
    [record],
  );
  const round =
    record?.rounds.find((item) => item.ordinal === selectedRound) ??
    record?.rounds.at(-1);
  const tabs = React.useMemo(
    (): readonly ReviewDetailTab[] => [
      { id: 'runs', count: round?.runs.length ?? 0 },
    ],
    [round?.runs.length],
  );

  if (props.bodyState === 'loading' && !record)
    return <ReviewDetailState kind="loading" />;
  if (props.bodyState === 'failed' && !record)
    return <ReviewDetailState kind="failed" onRetry={props.onRetry} />;
  if (!record)
    return (
      <ReviewDetailState
        kind="missing"
        reason={t('reviewWalkthrough.detail.unreadable')}
      />
    );

  const meta = [
    ...(record.rounds.length > 0
      ? [
          {
            key: 'round',
            text: t('reviewWalkthrough.detail.round', { round: lastOrdinal }),
          },
        ]
      : []),
    ...(record.rounds[0]
      ? [
          {
            key: 'started',
            text: t('reviewWalkthrough.detail.startedAt', {
              time: formatShortRelativeTime(record.rounds[0].startedAt),
            }),
          },
        ]
      : []),
  ];
  return (
    <ReviewDetailView
      title={record.title || t('detailsSurface.review.title')}
      meta={meta}
      menu={[]}
      glance={projectGlance(round)}
      rounds={rounds}
      selectedRound={selectedRound}
      onSelectRound={setSelected}
      tabs={tabs}
      activeTab={tab}
      onSelectTab={setTab}
    >
      {tab === 'runs' && round ? <ReviewRoundRuns round={round} /> : null}
    </ReviewDetailView>
  );
}

/** The round's runs, each opening its own result page (where its findings are decided today). */
function ReviewRoundRuns(props: Readonly<{ round: ReviewRecordRound }>) {
  const router = useRouter();
  const scope = useActiveServerAccountScope();
  if (props.round.runs.length === 0) {
    return (
      <SurfaceStateCard
        testID="review-detail:runs:empty"
        kind="empty"
        size="line"
        title={
          props.round.state === 'running'
            ? t('reviewWalkthrough.detail.glanceRunning')
            : t('reviewWalkthrough.detail.noRuns')
        }
      />
    );
  }
  return (
    <ItemGroup header="none" testID="review-detail:runs">
      {props.round.runs.map((run, index) => {
        const href =
          run.kind === 'workflow'
            ? createWorkflowRunRoute(run.runId, scope?.serverId ?? null)
            : run.sessionId
              ? buildSessionExecutionRunRouteHref({
                  sessionId: run.sessionId,
                  runId: run.runId,
                  serverId: scope?.serverId ?? null,
                })
              : null;
        return (
          <Item
            key={run.runId}
            testID={`review-detail:run:${run.runId}`}
            title={
              run.kind === 'workflow'
                ? t('reviewWalkthrough.detail.workflowRun')
                : t('reviewWalkthrough.detail.reviewerRun', {
                    count: index + 1,
                  })
            }
            subtitle={t(ROUND_STATE_KEYS[props.round.state])}
            {...(href ? { onPress: () => router.push(href as never) } : {})}
          />
        );
      })}
    </ItemGroup>
  );
}
