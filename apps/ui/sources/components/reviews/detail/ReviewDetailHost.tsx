import * as React from 'react';
import {
  openReviewArtifactV1,
  REVIEW_ARTIFACT_KIND_V1,
  type ReviewArtifactV1,
  type ReviewRoundStateV1,
} from '@happier-dev/protocol/reviews/reviewArtifactV1';

import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ReviewHumanStateV1, ReviewVerdictKindV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { ReviewChangesHost } from '../ReviewChangesHost';
import { useReviewDetail } from '../useReviewDetail';
import { useReviewHumanActions } from '../useReviewHumanActions';
import { ReviewSubmitPanel } from './ReviewSubmitPanel';
import { projectReviewGlance } from './reviewGlance';
import { reviewSubjectLabel } from '../list/useReviewsCollectionView';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
  ReviewDetailState,
  ReviewDetailView,
  type ReviewDetailParticipant,
  type ReviewDetailRound,
  type ReviewDetailRoundGroup,
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

const VERDICT_KEYS = {
  approve: 'reviewWalkthrough.detail.verdictApproved',
  request_changes: 'reviewWalkthrough.detail.verdictChangesRequested',
  comment: 'reviewWalkthrough.detail.verdictCommented',
} as const satisfies Record<ReviewVerdictKindV1, string>;

const EMPTY_PRINCIPALS: readonly PrincipalRefV1[] = Object.freeze([]);

/** Every person the opened Review names: requested reviewers of every round and every verdict's author. */
function humanPrincipals(human: ReviewHumanStateV1 | null): readonly PrincipalRefV1[] {
  if (!human) return EMPTY_PRINCIPALS;
  const byKey = new Map<string, PrincipalRefV1>();
  for (const request of human.requests) byKey.set(sharePrincipalKey(request.principal), request.principal);
  for (const verdict of human.verdicts) {
    const principal: PrincipalRefV1 = { kind: 'account', accountId: verdict.accountId };
    byKey.set(sharePrincipalKey(principal), principal);
  }
  return [...byKey.values()];
}

/**
 * The round's people: each requested reviewer with its own mark, Required or Optional, and what they did in
 * this round. A verdict belongs to its round; a person who answered an earlier round and not this one reads
 * "asked again". Eligibility to answer is the Review owner's `needsYou`, never re-derived here.
 */
export function projectPeople(input: Readonly<{
  human: ReviewHumanStateV1;
  round: number;
  names: ReadonlyMap<string, string> | null;
  viewerAccountId: string | null;
}>): ReviewDetailRoundGroup | null {
  const requests = input.human.requests.filter(request => request.roundOrdinal === input.round);
  if (requests.length === 0) return null;
  const waitingForViewer = input.human.roundOrdinal === input.round && input.human.needsYou.requestedVerdict;
  const participants: ReviewDetailParticipant[] = requests.map(request => {
    const presented = presentSharePrincipal({ ref: request.principal, name: input.names?.get(sharePrincipalKey(request.principal)) ?? null,
      viewerAccountId: input.viewerAccountId });
    const accountId = request.principal.kind === 'account' ? request.principal.accountId : null;
    const verdict = accountId ? input.human.verdicts.find(item => item.accountId === accountId && item.roundOrdinal === input.round) : undefined;
    const earlier = accountId ? input.human.verdicts.some(item => item.accountId === accountId && item.roundOrdinal < input.round) : false;
    const isViewer = accountId !== null && accountId === input.viewerAccountId;
    const state = verdict ? t(VERDICT_KEYS[verdict.verdict])
      : isViewer && waitingForViewer ? t('reviewWalkthrough.detail.requestedFromYou')
        : earlier ? t('reviewWalkthrough.detail.askedAgain') : null;
    return {
      id: request.id,
      label: isViewer ? t('reviewWalkthrough.detail.you') : presented.displayName,
      mark: presented.avatar ? <Avatar id={presented.avatar.id} imageUrl={presented.avatar.imageUrl ?? null} size={18} /> : null,
      qualifier: request.required ? null : t('reviewWalkthrough.detail.optional'),
      state,
      tone: (verdict?.verdict === 'request_changes' || (isViewer && waitingForViewer && !verdict)) ? 'attention' : null,
    };
  });
  return {
    id: 'people',
    title: t('reviewWalkthrough.detail.people'),
    detail: waitingForViewer ? t('reviewWalkthrough.detail.waitingForYou') : null,
    detailTone: waitingForViewer ? 'attention' : null,
    status: waitingForViewer ? 'waiting' : 'done',
    participants,
  };
}


/**
 * A Review opened from its Artifact (plan 04 U4): the one decrypted body read the Artifacts view already
 * made, decoded by the protocol's Review decoder, joined with the Review owner's metadata and people
 * (`useReviewDetail`), composed into the Review page. The round's Changes come from its sealed capture
 * through the shared SCM review body; its runs open their own results.
 */
export function ReviewDetailHost(props: Readonly<{
  artifact: DecryptedArtifact;
  bodyState: 'ready' | 'loading' | 'missing' | 'failed';
  onRetry: () => void;
}>): React.ReactElement {
  const { artifact } = props;
  const record = React.useMemo((): ReviewArtifactV1 | null => {
    if (typeof artifact.body !== 'string') return null;
    try {
      return openReviewArtifactV1({ artifactId: artifact.id, header: artifact.rawHeader ?? artifact.header ?? {}, body: artifact.body });
    } catch {
      return null;
    }
  }, [artifact.body, artifact.header, artifact.id, artifact.rawHeader]);
  const artifactScope = useActiveServerAccountScope(artifact.sourceServerId ?? null);
  const detail = useReviewDetail(artifact.id, { scope: artifactScope });
  const scope = detail.scope;
  const review = detail.data?.review ?? null;
  const human = detail.data?.human ?? null;
  const lastOrdinal = record?.rounds.at(-1)?.ordinal ?? 1;
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedRound = selected ?? lastOrdinal;
  const [tab, setTab] = React.useState<ReviewDetailTabId>('runs');
  const [changesView, setChangesView] = React.useState<'files' | 'walkthrough'>('files');
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const principals = React.useMemo(() => humanPrincipals(human), [human]);
  const { names } = useSharePrincipalNames(principals.length > 0 ? principals : null, scope?.serverId ?? null);
  const humanActions = useReviewHumanActions(scope, human);
  const round = record?.rounds.find((item) => item.ordinal === selectedRound) ?? record?.rounds.at(-1);
  const rounds = React.useMemo(() => record?.rounds.map(item => {
    const projected = projectRound(item);
    const people = human ? projectPeople({ human, round: item.ordinal, names, viewerAccountId: scope?.accountId ?? null }) : null;
    return people ? { ...projected, groups: [...projected.groups, people] } : projected;
  }) ?? [], [human, names, record, scope?.accountId]);
  const capture = round?.comparisonCapture ?? null;
  const tabs = React.useMemo((): readonly ReviewDetailTab[] => [
    ...(capture ? [{ id: 'changes' as const }] : []),
    { id: 'runs', count: round?.runs.length ?? 0 },
  ], [capture, round?.runs.length]);
  const activeTab = tabs.some(item => item.id === tab) ? tab : tabs[0]!.id;
  const submitVerdict = humanActions.submitVerdict;
  const submit = React.useCallback(async (input: Readonly<{ verdict: ReviewVerdictKindV1; body: string | undefined }>) => {
    if (!submitVerdict) return { ok: false as const, message: t('common.error') };
    const result = await submitVerdict(input.verdict, input.body);
    if (result.ok) { setSubmitOpen(false); void detail.refresh(); return { ok: true as const }; }
    return { ok: false as const, message: resolveActionExecutionErrorMessage(result, t('common.error')) };
  }, [detail, submitVerdict]);

  if (props.bodyState === 'loading' && !record) return <ReviewDetailState kind="loading" />;
  if (props.bodyState === 'failed' && !record) return <ReviewDetailState kind="failed" onRetry={props.onRetry} />;
  if (!record) return <ReviewDetailState kind="missing" reason={t('reviewWalkthrough.detail.unreadable')} />;

  const canSubmit = Boolean(human?.needsYou.canSubmitVerdict && human.roundOrdinal === selectedRound && submitVerdict);
  const meta = [
    ...(review ? [{ key: 'subject', text: reviewSubjectLabel(review.subjectKind) }] : []),
    ...(record.rounds.length > 0 ? [{ key: 'round', text: t('reviewWalkthrough.detail.round', { round: lastOrdinal }) }] : []),
    ...(record.rounds[0] ? [{ key: 'started', text: t('reviewWalkthrough.detail.startedAt', {
      time: formatShortRelativeTime(record.rounds[0].startedAt) }) }] : []),
  ];
  return (
    <ReviewDetailView
      title={record.title || t('detailsSurface.review.title')}
      meta={meta}
      primaryAction={canSubmit ? { title: t('reviewWalkthrough.detail.submitReview'), onPress: () => setSubmitOpen(true) } : null}
      menu={[]}
      glance={projectReviewGlance(round, review)}
      rounds={rounds}
      selectedRound={selectedRound}
      onSelectRound={setSelected}
      submit={canSubmit && submitOpen ? (
        <ReviewSubmitPanel roundOrdinal={selectedRound} onCancel={() => setSubmitOpen(false)} onSubmit={submit} />
      ) : null}
      tabs={tabs}
      activeTab={activeTab}
      onSelectTab={setTab}
    >
      {activeTab === 'changes' && capture && scope ? (
        <ReviewChangesHost reviewId={record.reviewId} roundOrdinal={selectedRound} scope={scope} capture={capture}
          comments={EMPTY_COMMENTS} view={changesView} onSelectView={setChangesView} onOpenComment={ignoreComment} />
      ) : null}
      {activeTab === 'runs' && round ? <ReviewRoundRuns round={round} scope={scope} /> : null}
    </ReviewDetailView>
  );
}

const EMPTY_COMMENTS: readonly never[] = Object.freeze([]);
const ignoreComment = () => undefined;

/** The round's runs, each opening its own result page (where its findings are decided today). */
function ReviewRoundRuns(props: Readonly<{ round: ReviewRecordRound; scope: ServerAccountScope | null }>) {
  const router = useRouter();
  const { scope } = props;
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
          !scope ? null : run.kind === 'workflow'
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
