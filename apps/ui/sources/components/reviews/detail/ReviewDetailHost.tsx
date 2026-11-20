import * as React from 'react';
import {
  openReviewArtifactV1,
  projectReviewRoundQualityV1,
  REVIEW_ARTIFACT_KIND_V1,
  type ReviewArtifactV1,
  type ReviewRoundStateV1,
} from '@happier-dev/protocol/reviews/reviewArtifactV1';

import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ReviewHumanActionStateV1, ReviewVerdictKindV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactViewRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { ReviewChangesHost, type ReviewViewedFilter } from '../ReviewChangesHost';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { useReviewDetail } from '../useReviewDetail';
import { useReviewHumanActions } from '../useReviewHumanActions';
import { useReviewHistory } from '../useReviewHistory';
import { useReviewComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { ReviewFindingRow } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { useReviewFindingsModel, type ReviewFindingDecisionTarget } from '../finding/useReviewFindingsModel';
import { ReviewQuestions, ReviewFollowUpDock } from '../finding/ReviewQuestions';
import { useReviewQuestionRuns } from './useReviewQuestionRuns';
import { ReviewFindingsList } from './ReviewFindingsList';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { presentSessionAddressSelection } from '@/components/sessions/transcript/messageSelection/presentSessionAddressSelection';
import { readArtifactAccessCapabilities } from '@/sync/domains/artifacts/artifactAccessCapabilities';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ReviewSubmitPanel } from './ReviewSubmitPanel';
import { reviewFindingFacts, reviewHistoryFacts } from './reviewFindingFacts';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useReviewNewRound } from './useReviewNewRound';
import { projectReviewGlance } from './reviewGlance';
import { reviewSubjectLabel } from '../list/useReviewsCollectionView';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { ReviewPagePluginContent } from '../plugins/ReviewPluginContent';
import type { PluginReviewPageSelection } from '@/components/plugins/pages/pluginPageRoute';

import {
  ReviewDetailInset,
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
export function projectRound(round: ReviewRecordRound): ReviewDetailRound {
  const state = t(ROUND_STATE_KEYS[round.state]);
  // A round only people review has no agent or engine row; its people row says who was asked.
  if (round.reviewerIds.length === 0) return { ordinal: round.ordinal, state: round.state, groups: [] };
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
function humanPrincipals(human: ReviewHumanActionStateV1 | null): readonly PrincipalRefV1[] {
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
 * this round, plus retained verdict authors whose original request is no longer present. A verdict belongs
 * to its round; a person who answered an earlier round and not this one reads
 * "asked again". Eligibility to answer is the Review owner's `needsYou`, never re-derived here.
 */
export function projectPeople(input: Readonly<{
  human: ReviewHumanActionStateV1;
  round: number;
  names: ReadonlyMap<string, string> | null;
  viewerAccountId: string | null;
}>): ReviewDetailRoundGroup | null {
  const requests = input.human.requests.filter(request => request.roundOrdinal === input.round);
  const verdicts = input.human.verdicts.filter(verdict => verdict.roundOrdinal === input.round);
  if (requests.length === 0 && verdicts.length === 0) return null;
  const waitingForViewer = input.human.roundOrdinal === input.round && input.human.needsYou.requestedVerdict;
  const presentPerson = (principal: PrincipalRefV1) => {
    const presented = presentSharePrincipal({ ref: principal, name: input.names?.get(sharePrincipalKey(principal)) ?? null,
      viewerAccountId: input.viewerAccountId });
    return {
      label: principal.kind === 'account' && principal.accountId === input.viewerAccountId
        ? t('reviewWalkthrough.detail.you') : presented.displayName,
      mark: presented.avatar ? <Avatar id={presented.avatar.id} imageUrl={presented.avatar.imageUrl ?? null} size={18} /> : null,
    };
  };
  const participants: ReviewDetailParticipant[] = requests.map(request => {
    const accountId = request.principal.kind === 'account' ? request.principal.accountId : null;
    const verdict = accountId ? verdicts.find(item => item.accountId === accountId) : undefined;
    const earlier = accountId ? input.human.verdicts.some(item => item.accountId === accountId && item.roundOrdinal < input.round) : false;
    const isViewer = accountId !== null && accountId === input.viewerAccountId;
    const state = verdict ? t(VERDICT_KEYS[verdict.verdict])
      : isViewer && waitingForViewer ? t('reviewWalkthrough.detail.requestedFromYou')
        : earlier ? t('reviewWalkthrough.detail.askedAgain') : null;
    return {
      id: request.id,
      ...presentPerson(request.principal),
      qualifier: request.required ? null : t('reviewWalkthrough.detail.optional'),
      body: verdict?.body,
      state,
      tone: (verdict?.verdict === 'request_changes' || (isViewer && waitingForViewer && !verdict)) ? 'attention' : null,
    };
  });
  for (const verdict of verdicts) {
    if (requests.some(request => request.principal.kind === 'account' && request.principal.accountId === verdict.accountId)) continue;
    participants.push({
      id: `verdict:${input.round}:${verdict.accountId}`,
      ...presentPerson({ kind: 'account', accountId: verdict.accountId }),
      state: t(VERDICT_KEYS[verdict.verdict]),
      body: verdict.body,
      tone: verdict.verdict === 'request_changes' ? 'attention' : null,
    });
  }
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
  pluginPageSelection?: PluginReviewPageSelection | null;
  focusThreadId?: string;
}>): React.ReactElement {
  const { artifact } = props;
  const router = useRouter();
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
  const [tab, setTab] = React.useState<ReviewDetailTabId>('findings');
  const [openFinding, setOpenFinding] = React.useState<string | null>(props.focusThreadId ?? null);
  const [changesView, setChangesView] = React.useState<'files' | 'walkthrough'>('files');
  const [hideViewed, setHideViewed] = React.useState(false);
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const principals = React.useMemo(() => humanPrincipals(human), [human]);
  const { names } = useSharePrincipalNames(principals.length > 0 ? principals : null, scope?.serverId ?? null);
  const humanActions = useReviewHumanActions(scope, human);
  const round = record?.rounds.find((item) => item.ordinal === selectedRound) ?? record?.rounds.at(-1);
  const qualityAggregation = useSetting('reviewQualityAggregation');
  const rounds = React.useMemo(() => record?.rounds.map(item => {
    const projected = projectRound(item);
    const people = human ? projectPeople({ human, round: item.ordinal, names, viewerAccountId: scope?.accountId ?? null }) : null;
    return people ? { ...projected, groups: [...projected.groups, people] } : projected;
  }) ?? [], [human, names, record, scope?.accountId]);
  const capture = round?.comparisonCapture ?? null;
  const canFilterViewed = capture?.input.source?.kind === 'pullRequest'
    && capture.input.source.locator.fileViewedActions !== undefined;
  // Hide viewed is one command on this page's current context: the switch and an agent change it the same way.
  const viewedCommands = useCurrentUiContextLocalCommands(canFilterViewed ? [{
    key: 'review.detail.hide_viewed',
    title: t('hunkReview.hideViewed'),
    description: 'review.detail.hide_viewed — Hide or show the viewed files in this Review\'s Changes with {value: boolean}.',
    invoke: input => {
      if (!isJsonObject(input) || typeof input.value !== 'boolean') return false;
      setHideViewed(input.value);
    },
  }] : [], { unbound: 'local' });
  const viewedFilter = React.useMemo((): ReviewViewedFilter | undefined => canFilterViewed ? { hidden: hideViewed,
    onHiddenChange: value => { void viewedCommands.invoke('review.detail.hide_viewed', { value }); } } : undefined,
  [canFilterViewed, hideViewed, viewedCommands]);
  const tabs = React.useMemo((): readonly ReviewDetailTab[] => [
    { id: 'findings' },
    { id: 'changes' },
    { id: 'runs', count: round?.runs.length ?? 0 },
    { id: 'activity' },
  ], [round?.runs.length]);
  const activeTab = tabs.some(item => item.id === tab) ? tab : tabs[0]!.id;
  const presented = useLayoutPresentationActive();
  const comments = useReviewComments({ scope, reviewId: record?.reviewId ?? null,
    enabled: presented && (activeTab === 'findings' || activeTab === 'changes') });
  const { binding } = useServerCredentialAccountScopeBinding(scope?.serverId);
  const canEdit = readArtifactAccessCapabilities(artifact.access).canEdit;
  const newRoundPeople = React.useMemo(() => {
    if (!human) return [];
    const people = projectPeople({ human, round: lastOrdinal, names, viewerAccountId: scope?.accountId ?? null });
    return people?.participants.flatMap(person => {
      const request = human.requests.find(request => request.id === person.id);
      return request ? [{ id: person.id, label: person.label, mark: person.mark,
        continuity: 'asked_again' as const, required: request.required }] : [];
    }) ?? [];
  }, [human, lastOrdinal, names, scope?.accountId]);
  const newRound = useReviewNewRound({ scope, record, canEdit, people: newRoundPeople });
  const decide = React.useCallback((target: ReviewFindingDecisionTarget, decision: 'accept' | 'reject' | 'defer') =>
    comments.decide(target.comment.id, decision), [comments.decide]);
  const findingRound = React.useMemo(() => round && record ? { round: { reviewId: record.reviewId,
    roundOrdinal: round.ordinal, reviewerIds: round.reviewerIds, state: round.state }, comments: comments.comments } : undefined,
  [comments.comments, record, round]);
  const questionRuns = useReviewQuestionRuns({ runs: round?.runs, accountLifetime: binding,
    enabled: presented && activeTab === 'findings' });
  const findings = useReviewFindingsModel({ members: questionRuns.members, record: findingRound,
    reviewerCount: round?.reviewerIds.length ?? 0, scope, accountLifetime: binding,
    serverId: scope?.serverId ?? null, sessionId: null, canAct: canEdit, pending: comments.pending,
    onDecideComment: decide });
  const findingById = React.useMemo(() => new Map(findings.rows.map(row => [row.rowId, row])), [findings.rows]);
  const commentById = React.useMemo(() => new Map(comments.comments.map(comment => [comment.id, comment])), [comments.comments]);
  const openedFindingComment = openFinding && findingById.has(openFinding) ? commentById.get(openFinding) : undefined;
  const seenBefore = useReviewHistory({ reviewId: record?.reviewId ?? artifact.id,
    findingIdentity: openedFindingComment?.findingIdentity ?? '' },
  { scope, enabled: presented && activeTab === 'findings' && openedFindingComment !== undefined });
  const findingTitles = React.useMemo(() => new Map(comments.comments.flatMap(comment =>
    comment.findingIdentity && comment.finding ? [[comment.findingIdentity, comment.finding.title] as const] : [])), [comments.comments]);
  const history = useReviewHistory({ reviewId: record?.reviewId ?? artifact.id, workflowId: review?.workflowId },
    { scope, enabled: activeTab === 'activity' });
  const roundComments = React.useMemo(() => comments.comments.filter(comment =>
    comment.appearances?.some(appearance => appearance.roundOrdinal === selectedRound)
      || comment.roundOrdinal === selectedRound), [comments.comments, selectedRound]);
  const openComment = React.useCallback((commentId: string) => { setTab('findings'); setOpenFinding(commentId); }, []);
  const implementFindings = React.useCallback(async () => {
    if (!scope) return;
    const picker = presentSessionAddressSelection(scope.serverId, undefined, {
      excludedSessionId: '', capability: 'submitAgentInput', allowNewSession: true, title: t('runPage.review.implementFixes', { count: findings.implement.count }),
    });
    const destination = await picker.result;
    if (destination?.kind === 'existingSession') findings.implement.runInSession(destination.sessionId);
    else if (destination?.kind === 'newSession') await findings.implement.runInNewSession();
  }, [findings.implement, scope]);
  const toggleFinding = React.useCallback((commentId: string) => setOpenFinding(current => current === commentId ? null : commentId), []);
  React.useEffect(() => { setOpenFinding(props.focusThreadId ?? null); }, [artifact.id, props.focusThreadId]);
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
    <ReviewPagePluginContent reviewId={artifact.id} serverId={artifact.sourceServerId ?? artifactScope?.serverId ?? null}
      selection={props.pluginPageSelection}>{menu => (
    <ReviewDetailView
      title={record.title || t('detailsSurface.review.title')}
      meta={meta}
      primaryAction={canSubmit ? { title: t('reviewWalkthrough.detail.submitReview'), onPress: () => setSubmitOpen(true) }
        : newRound.available ? { title: t('reviewWalkthrough.detail.newRound'), onPress: newRound.open } : null}
      notice={newRound.approval.approvalPending && newRound.approval.approvalId && scope ? <ActionApprovalPendingNotice
        testID="review-detail:new-round-approval" message={t('approvals.title')}
        onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(newRound.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
      menu={[...(canSubmit && newRound.available ? [{ id: 'new-round', testID: 'review-detail:new-round',
        title: t('reviewWalkthrough.detail.newRound'), onSelect: newRound.open }] : []),
        { id: 'copy-fix-prompt', testID: 'review-detail:copy-fix-prompt', title: t('reviewWalkthrough.detail.copyFixPrompt'),
        disabled: findings.implement.destinationDisabled, onSelect: async () => { await findings.implement.copyPrompt(); } }, ...menu]}
      glance={projectReviewGlance(round, review)}
      quality={projectReviewRoundQualityV1(round, qualityAggregation)}
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
      {activeTab === 'findings' ? <>
        {canEdit && findings.rows.length > 0 ? <ReviewDetailInset><RoundButton testID="review-detail:implement" size="small"
          title={t('runPage.review.implementFixes', { count: findings.implement.count })}
          disabled={findings.implement.destinationDisabled} loading={findings.implement.busy}
          onPress={implementFindings} /></ReviewDetailInset> : null}
        {comments.status === 'idle' || comments.status === 'loading' ? <SurfaceStateCard kind="loading" title={t('common.loading')} />
          : findings.rows.length > 0 || findings.unavailableFindings.length === 0 ? <ReviewFindingsList rows={findings.rows.map(row => ({ rowId: row.rowId, severity: row.finding.severity, decision: row.decision }))}
              renderRow={(rowId, divided) => {
                const row = findingById.get(rowId);
                return row ? <ReviewFindingRow rowId={row.rowId} finding={row.finding} currentBodyMarkdown={row.currentBodyMarkdown}
                  reviewContext={scope ? { reviewId: record.reviewId, commentId: row.rowId, serverId: scope.serverId } : undefined}
                  seenBefore={openFinding === row.rowId ? { history: seenBefore, onRetry: () => void seenBefore.refresh(),
                    href: match => artifactViewRoute(match.reviewId, { thread: match.commentId }) } : undefined}
                  attribution={row.attribution} reviewers={row.reviewers} original={row.original} density="page" divided={divided}
                  decision={row.decision} decisionEditable={row.decisionEditable} decisionDisabled={!row.decidable} decisionNote={null}
                  onDecide={findings.onDecide} followUp={row.followUp} threadEntries={row.threadEntries} pendingQuestion={null}
                  expanded={openFinding === row.rowId} onToggleExpanded={toggleFinding} askContext={row.askContext}
                  onAsk={findings.onAsk} onCreateTask={canEdit ? findings.onCreateTask : undefined} taskScope={scope}
                  facts={reviewFindingFacts({ appearance: row.appearance, roundOrdinal: selectedRound,
                    scopeAttribution: commentById.get(row.rowId)?.scopeAttribution })} /> : null;
              }} /> : null}
        {findings.unavailableFindings.map(comment => <SurfaceStateCard key={comment.id}
          testID={`review-detail:unavailable-finding:${comment.id}`} kind="warning" size="line"
          title={t(comment.flags.redacted || comment.tombstone ? 'files.reviewComments.durable.redacted' : 'files.reviewComments.durable.contentUnavailable')} />)}
        {comments.status === 'failed' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
          action={{ label: t('common.retry'), onPress: () => void comments.refresh() }} /> : null}
        {comments.cursor ? <TextLinkButton testID="review-findings-load-more-comments" disabled={comments.loadingMore}
          label={t(comments.loadMoreFailed ? 'common.retry' : 'files.reviewComments.durable.showMore')} onPress={() => void comments.loadMore()} /> : null}
        {questionRuns.state.kind === 'loading' && questionRuns.members.length === 0
          ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
        {questionRuns.state.kind === 'unavailable' ? <SurfaceStateCard testID="review-detail:questions-unavailable"
          kind={questionRuns.state.reason === 'read_failed' ? 'error' : 'unavailable'} size="line"
          title={questionRuns.state.reason === 'temporarily_unavailable' ? t('reviewFindings.questionsMachineUnavailable')
            : questionRuns.state.reason === 'run_missing' ? t('reviewFindings.questionsRunMissing')
              : t('surfaceState.couldNotOpen', { name: t('reviewFindings.questionsTitle') })}
          action={{ label: t(questionRuns.state.reason === 'run_missing' ? 'surfaceState.checkAgain' : 'common.retry'),
            onPress: questionRuns.retry }} /> : null}
        <ReviewQuestions questions={findings.questions} multiReviewer={(round?.reviewerIds.length ?? 0) > 1}
          canAct={canEdit} onAnswer={findings.setReplyToQuestion} />
        {canEdit && findings.questions.length > 0 && openFinding === null ? <ReviewFollowUpDock
          sessionId={findings.dockMembers[0]?.sessionId ?? null} serverId={scope?.serverId ?? null} accountLifetime={binding}
          draftRunId={findings.dockMembers[0]?.runId ?? null} members={findings.dockMembers}
          recipient={findings.dockRecipient} followUp={findings.followUp} onSend={findings.askReviewers} /> : null}
        {findings.error ? <SurfaceStateCard kind="error" size="line" title={t('common.error')} reason={findings.error} /> : null}
        {findings.approval.approvalPending && findings.approval.approvalId && scope ? <ActionApprovalPendingNotice
          testID="review-detail:approval" message={t('approvals.title')}
          onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(findings.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
      </> : null}
      {activeTab === 'changes' && scope ? (
        <ReviewChangesHost reviewId={record.reviewId} roundOrdinal={selectedRound} scope={scope} capture={capture}
          comments={roundComments} view={changesView} onSelectView={setChangesView} onOpenComment={openComment}
          viewedFilter={viewedFilter} />
      ) : null}
      {activeTab === 'runs' && round ? <ReviewRoundRuns round={round} scope={scope} /> : null}
      {activeTab === 'activity' ? <>
        {history.data ? <ItemGroup header="none">{history.data.items.map(item => <Item key={item.findingIdentity}
          testID={`review-history:finding:${item.findingIdentity}`} title={findingTitles.get(item.findingIdentity) ?? t('runPage.review.findings')}
          subtitle={joinHappierFacts(...reviewHistoryFacts(item))} />)}</ItemGroup> : null}
        {review?.workflowId && !history.data && history.status !== 'error' ? <SurfaceStateCard kind="loading" title={t('common.loading')} /> : null}
        {history.status === 'error' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
          action={{ label: t('common.retry'), onPress: () => void history.refresh() }} /> : null}
        {!review?.workflowId || history.data?.items.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('reviewWalkthrough.detail.historyEmpty')} /> : null}
      </> : null}
    </ReviewDetailView>
    )}</ReviewPagePluginContent>
  );
}

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
