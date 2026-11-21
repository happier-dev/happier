import * as React from 'react';
import { View } from 'react-native';
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
import { ReviewFindingRow, REVIEW_FINDING_DECISIONS, reviewFindingDecisionLabel } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { useReviewFindingsModel, type ReviewFindingDecisionTarget } from '../finding/useReviewFindingsModel';
import { ReviewQuestions, ReviewFollowUpDock } from '../finding/ReviewQuestions';
import { useReviewQuestionRuns, type ReviewRoundRunRead } from './useReviewQuestionRuns';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { presentExecutionRunFailureSummary } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { formatReviewerSet } from '@/components/sessions/reviews/findings/reviewFindingsMerge';
import { ReviewFindingsList } from './ReviewFindingsList';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { presentSessionAddressSelection } from '@/components/sessions/transcript/messageSelection/presentSessionAddressSelection';
import { readArtifactAccessCapabilities } from '@/sync/domains/artifacts/artifactAccessCapabilities';
import { useArtifactOperations } from '@/components/artifacts/useArtifactOperations';
import { useArtifactAudience } from '@/components/artifacts/useArtifactAudience';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ReviewSubmitPanel } from './ReviewSubmitPanel';
import { ReviewPeopleEditor } from './ReviewPeopleEditor';
import { reviewFindingFacts, reviewHistoryFacts } from './reviewFindingFacts';
import { projectReviewActivity, type ReviewActivityEvent } from './reviewActivity';
import { ReviewActivityFeed } from './ReviewActivityFeed';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useReviewNewRound } from './useReviewNewRound';
import { projectReviewGlance } from './reviewGlance';
import { reviewSubjectLabel } from '../list/useReviewsCollectionView';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useDeviceType } from '@/utils/platform/responsive';
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
const LOADING_ROWS: ItemLoadState = Object.freeze({ kind: 'loading' });
const NO_ACTIVITY: readonly ReviewActivityEvent[] = Object.freeze([]);
const NO_SELECTED_FINDINGS: ReadonlySet<string> = new Set();

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
    // A viewer the round waits for reads it once, on the row ("Waiting for you"), not again beside "You".
    const state = verdict ? t(VERDICT_KEYS[verdict.verdict])
      : isViewer && waitingForViewer ? null
        : earlier ? t('reviewWalkthrough.detail.askedAgain') : null;
    return {
      id: request.id,
      ...presentPerson(request.principal),
      qualifier: joinHappierFacts(request.required ? null : t('reviewWalkthrough.detail.optional'),
        request.needsAccess ? t('reviewWalkthrough.detail.needsAccess') : null) || null,
      body: verdict?.body,
      state,
      tone: verdict?.verdict === 'request_changes' ? 'attention' : null,
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
  /** After Delete: the opener's own way back; otherwise the Artifact owner's. */
  onDeleted?: () => void;
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
  const [peopleOpen, setPeopleOpen] = React.useState(false);
  const selectionKey = JSON.stringify([scope?.serverId, scope?.accountId, artifact.id, selectedRound]);
  const [selection, setSelection] = React.useState<Readonly<{ key: string; ids: ReadonlySet<string> }>>({ key: selectionKey, ids: NO_SELECTED_FINDINGS });
  const selectedFindingIds = selection.key === selectionKey ? selection.ids : NO_SELECTED_FINDINGS;
  const selectedRowIds = React.useMemo(() => [...selectedFindingIds], [selectedFindingIds]);
  // Selection is a mode behind Select (lab `detail-bulk`): rows show only their status glyph until it starts.
  const [selectingKey, setSelectingKey] = React.useState<string | null>(null);
  const selecting = selectingKey === selectionKey || selectedRowIds.length > 0;
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
    // A tab with nothing under it carries no count ("Runs", never "Runs 0").
    { id: 'runs', count: round?.runs.length || null },
    { id: 'activity' },
  ], [round?.runs.length]);
  const activeTab = tabs.some(item => item.id === tab) ? tab : tabs[0]!.id;
  const presented = useLayoutPresentationActive();
  const comments = useReviewComments({ scope, reviewId: record?.reviewId ?? null,
    enabled: presented && activeTab !== 'runs' });
  const { binding } = useServerCredentialAccountScopeBinding(scope?.serverId);
  const canEdit = readArtifactAccessCapabilities(artifact.access).canEdit;
  // Share and Delete are the Artifact owner's operations, as on every other Artifact page (plan 04 D parity).
  const operations = useArtifactOperations(artifact, props.onDeleted);
  const audienceResource = React.useMemo(() => ({ artifactId: artifact.id, header: {}, ownerAccountId: artifact.ownerAccountId,
    access: artifact.access, ...(artifact.publicAudience ? { publicAudience: artifact.publicAudience } : {}) }),
  [artifact.access, artifact.id, artifact.ownerAccountId, artifact.publicAudience]);
  const audience = useArtifactAudience(audienceResource);
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
  // The round's reviewer runs: questions on Findings, who ran and how it ended on Runs and Activity, and which
  // reviewer didn't finish on the page's notice line.
  const questionRuns = useReviewQuestionRuns({ runs: round?.runs, accountLifetime: binding,
    enabled: presented && (activeTab !== 'changes' || round?.state === 'partial') });
  // Which reviewers of a partial round didn't finish, by the runs their Machines answered for: the notice names them.
  const unfinishedRuns = React.useMemo(() => round?.state !== 'partial' ? [] : round.runs.flatMap(run => {
    const read = run.kind === 'execution' ? questionRuns.runs.get(run.runId)?.run : undefined;
    return read && read.status !== 'running' && read.status !== 'succeeded' ? [read] : [];
  }), [questionRuns.runs, round]);
  const partialReason = unfinishedRuns.length === 1 ? presentExecutionRunFailureSummary(unfinishedRuns[0]!.error ?? null)?.summary ?? null : null;
  const findings = useReviewFindingsModel({ members: questionRuns.members, record: findingRound,
    reviewerCount: round?.reviewerIds.length ?? 0, scope, accountLifetime: binding,
    serverId: scope?.serverId ?? null, sessionId: null, canAct: canEdit, pending: comments.pending,
    selectedRowIds: selectedRowIds.length > 0 ? selectedRowIds : undefined,
    onDecideComment: decide, onBulkDecideComments: comments.decideMany });
  const findingById = React.useMemo(() => new Map(findings.rows.map(row => [row.rowId, row])), [findings.rows]);
  const findingListRows = React.useMemo(() => findings.rows.map(row => ({ rowId: row.rowId, title: row.finding.title,
    severity: row.finding.severity, decision: row.decision, fixed: row.fixed })), [findings.rows]);
  const fixedCount = React.useMemo(() => findings.rows.filter(row => row.fixed).length, [findings.rows]);
  const commentById = React.useMemo(() => new Map(comments.comments.map(comment => [comment.id, comment])), [comments.comments]);
  const openedFindingComment = openFinding && findingById.has(openFinding) ? commentById.get(openFinding) : undefined;
  const seenBefore = useReviewHistory({ reviewId: record?.reviewId ?? artifact.id,
    findingIdentity: openedFindingComment?.findingIdentity ?? '' },
  { scope, enabled: presented && activeTab === 'findings' && openedFindingComment !== undefined });
  // A Hunt finding's standing across runs ("also in 4 earlier runs") is a fact on its row, read with the Findings.
  const history = useReviewHistory({ reviewId: record?.reviewId ?? artifact.id, workflowId: review?.workflowId },
    { scope, enabled: presented && activeTab === 'findings' && Boolean(review?.workflowId) });
  const historyFactsByIdentity = React.useMemo(() => new Map(history.data?.items.map(item =>
    [item.findingIdentity, reviewHistoryFacts(item)] as const) ?? []), [history.data]);
  const activityEvents = React.useMemo(() => activeTab !== 'activity' || !record ? NO_ACTIVITY : projectReviewActivity({
    rounds: record.rounds, comments: comments.comments, verdicts: human?.verdicts ?? [],
    runs: (round?.runs ?? []).flatMap(run => {
      const read = run.kind === 'execution' ? questionRuns.runs.get(run.runId) : undefined;
      return read?.run ? [{ runId: run.runId, status: read.run.status, backendTarget: read.run.backendTarget,
        findingsCount: read.findingsCount, ...(read.run.finishedAtMs === undefined ? {} : { finishedAtMs: read.run.finishedAtMs }) }] : [];
    }),
  }), [activeTab, comments.comments, human?.verdicts, questionRuns.runs, record, round?.runs]);
  const roundComments = React.useMemo(() => comments.comments.filter(comment =>
    comment.appearances?.some(appearance => appearance.roundOrdinal === selectedRound)
      || comment.roundOrdinal === selectedRound), [comments.comments, selectedRound]);
  const viewCommands = useCurrentUiContextLocalCommands([
    { key: 'review.detail.tab', title: t('runPage.review.findings'), description: 'Open a Review tab with {tab: findings | changes | runs | activity}.', invoke: input => {
      if (!isJsonObject(input)) return false;
      const next = tabs.find(item => item.id === input.tab);
      if (!next) return false;
      setTab(next.id);
    } },
    { key: 'review.detail.round', title: t('reviewWalkthrough.detail.rounds'), description: 'Open a saved Review round with {ordinal: number}.', invoke: input => {
      if (!isJsonObject(input) || typeof input.ordinal !== 'number' || !record?.rounds.some(round => round.ordinal === input.ordinal)) return false;
      setSelected(input.ordinal); setOpenFinding(null); setPeopleOpen(false);
    } },
    { key: 'review.detail.open_finding', title: t('runPage.review.findings'), description: 'Open a finding with {commentId: string}, or close it with {commentId: null}.', invoke: input => {
      if (!isJsonObject(input) || (input.commentId !== null && (typeof input.commentId !== 'string' || !findingById.has(input.commentId)))) return false;
      setTab('findings'); setOpenFinding(input.commentId);
    } },
    { key: 'review.detail.selection', title: t('runPage.review.findings'), description: 'Select canonical finding roots with {rowIds: string[]}. An empty array clears selection.', invoke: input => {
      if (!isJsonObject(input) || !Array.isArray(input.rowIds)) return false;
      const ids: string[] = [];
      for (const id of input.rowIds) { if (typeof id !== 'string' || !findingById.has(id)) return false; ids.push(id); }
      setSelection({ key: selectionKey, ids: new Set(ids) });
    } },
  ], { unbound: 'local' });
  const openComment = React.useCallback((commentId: string) => { void viewCommands.invoke('review.detail.open_finding', { commentId }); }, [viewCommands]);
  const implementFindings = React.useCallback(async () => {
    if (!scope) return;
    const picker = presentSessionAddressSelection(scope.serverId, undefined, {
      excludedSessionId: '', capability: 'submitAgentInput', allowNewSession: true, title: t('runPage.review.implementFixes', { count: findings.implement.count }),
    });
    const destination = await picker.result;
    if (destination?.kind === 'existingSession') findings.implement.runInSession(destination.sessionId);
    else if (destination?.kind === 'newSession') await findings.implement.runInNewSession();
  }, [findings.implement, scope]);
  // A phone pushes an opened finding as its own page (lab `detail-finding-390`: back to the Review, "High · 3 of 6");
  // wider layouts open it in place. On the pushed page the row stays open, and Back is the way out.
  const phone = useDeviceType() === 'phone';
  const pushedFindingId = phone && props.focusThreadId && findingById.has(props.focusThreadId) ? props.focusThreadId : null;
  const toggleFinding = React.useCallback((commentId: string) => {
    if (pushedFindingId === commentId) return;
    if (phone && openFinding !== commentId) { router.push(artifactViewRoute(artifact.id, { thread: commentId }) as never); return; }
    void viewCommands.invoke('review.detail.open_finding', { commentId: openFinding === commentId ? null : commentId });
  }, [artifact.id, openFinding, phone, pushedFindingId, router, viewCommands]);
  const changeSelection = React.useCallback((rowIds: readonly string[]) => { void viewCommands.invoke('review.detail.selection', { rowIds: [...rowIds] }); }, [viewCommands]);
  const toggleSelection = React.useCallback((id: string) => {
    const next = new Set(selectedFindingIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    changeSelection([...next]);
  }, [changeSelection, selectedFindingIds]);
  const startSelecting = React.useCallback(() => setSelectingKey(selectionKey), [selectionKey]);
  const endSelecting = React.useCallback(() => { setSelectingKey(null); changeSelection([]); }, [changeSelection]);
  const bulkDecide = React.useCallback(async (decision: ReviewTriageStatus) => {
    await findings.onDecideMany(selectedRowIds, decision);
  }, [findings.onDecideMany, selectedRowIds]);
  const bulkBusy = selectedRowIds.some(id => comments.pending[id] !== undefined);
  React.useEffect(() => { setOpenFinding(props.focusThreadId ?? null); }, [artifact.id, props.focusThreadId]);
  const submitVerdict = humanActions.submitVerdict;
  const submit = React.useCallback(async (input: Readonly<{ verdict: ReviewVerdictKindV1; body: string | undefined }>) => {
    if (!submitVerdict) return { ok: false as const, message: t('common.error') };
    const result = await submitVerdict(input.verdict, input.body);
    if (result.ok) { setSubmitOpen(false); void detail.refresh(); return { ok: true as const }; }
    return { ok: false as const, message: resolveActionExecutionErrorMessage(result, t('common.error')) };
  }, [detail, submitVerdict]);
  const setReviewers = humanActions.setReviewers;
  const savePeople = React.useCallback(async (reviewers: Parameters<NonNullable<typeof setReviewers>>[0]) => {
    if (!setReviewers) return { ok: false as const, message: t('common.error') };
    const result = await setReviewers(reviewers);
    if (result.ok) { setPeopleOpen(false); void detail.refresh(); return { ok: true as const }; }
    return { ok: false as const, message: resolveActionExecutionErrorMessage(result, t('common.error')) };
  }, [detail, setReviewers]);

  if (props.bodyState === 'loading' && !record) return <ReviewDetailState kind="loading" />;
  if (props.bodyState === 'failed' && !record) return <ReviewDetailState kind="failed" onRetry={props.onRetry} />;
  if (!record) return <ReviewDetailState kind="missing" reason={t('reviewWalkthrough.detail.unreadable')} />;

  const canSubmit = Boolean(human?.needsYou.canSubmitVerdict && human.roundOrdinal === selectedRound && submitVerdict);
  const canEditPeople = canEdit && human?.roundOrdinal === selectedRound && setReviewers !== undefined;
  // One primary (lab `detail-findings`): Submit review when the Review asks it of you; otherwise "Implement N fixes"
  // once a finding is accepted and not yet fixed. While findings still wait for a decision and none is accepted there
  // is no primary (the glance names the next step); New round leads only once the round is settled.
  const implementAction = canEdit && findings.implement.count > 0 ? {
    title: t('runPage.review.implementFixes', { count: findings.implement.count }), testID: 'review-detail:implement-primary',
    disabled: findings.implement.destinationDisabled, loading: findings.implement.busy, onPress: implementFindings } : null;
  const awaitingDecision = findings.rows.some(row => row.decision === 'undecided' && !row.fixed);
  const newRoundAction = newRound.available ? { title: t('reviewWalkthrough.detail.newRound'), onPress: newRound.open } : null;
  const primaryAction = canSubmit ? { title: t('reviewWalkthrough.detail.submitReview'), onPress: () => setSubmitOpen(true) }
    : implementAction ?? (awaitingDecision ? null : newRoundAction);
  // A finding's standing words: its round status and captured scope, then (a Hunt's) its standing across runs.
  const findingFacts = (row: (typeof findings.rows)[number]) => {
    const comment = commentById.get(row.rowId);
    return [...reviewFindingFacts({ appearance: row.appearance, roundOrdinal: selectedRound, scopeAttribution: comment?.scopeAttribution }),
      ...(comment?.findingIdentity ? historyFactsByIdentity.get(comment.findingIdentity) ?? [] : [])];
  };
  const renderFindingRow = (rowId: string, divided: boolean) => {
    const row = findingById.get(rowId);
    return row ? <ReviewFindingRow rowId={row.rowId} finding={row.finding} currentBodyMarkdown={row.currentBodyMarkdown}
      reviewContext={scope ? { reviewId: record.reviewId, commentId: row.rowId, serverId: scope.serverId } : undefined}
      seenBefore={openFinding === row.rowId ? { history: seenBefore, onRetry: () => void seenBefore.refresh(),
        href: match => artifactViewRoute(match.reviewId, { thread: match.commentId }) } : undefined}
      attribution={row.attribution} reviewers={row.reviewers} original={row.original} density="page" divided={divided}
      decision={row.decision} decisionEditable={row.decisionEditable} decisionDisabled={!row.decidable} decisionNote={null}
      resolution={row.fixed ? t('reviewWalkthrough.detail.fixed') : null}
      onDecide={findings.onDecide} followUp={row.followUp} threadEntries={row.threadEntries} pendingQuestion={findings.pendingQuestionByRowId[row.rowId] ?? null}
      expanded={openFinding === row.rowId} onToggleExpanded={toggleFinding} askContext={row.askContext}
      onAsk={findings.onAsk} onCreateTask={canEdit ? findings.onCreateTask : undefined} taskScope={scope}
      facts={findingFacts(row)} /> : null;
  };
  if (pushedFindingId) {
    const index = findings.rows.findIndex(row => row.rowId === pushedFindingId);
    return (
      <ItemList testID="review-detail:finding-page" pageColumn="wide">
        <PageHeader title={record.title || t('detailsSurface.review.title')} testID="review-detail:finding-page:header"
          meta={[{ key: 'position', text: t('reviewWalkthrough.detail.findingPosition', { index: index + 1, total: findings.rows.length }) }]} />
        {/* The finding stands on the page's edge, without a sheet; its own row already names the severity. */}
        <ItemGroup header="none" surface="none">{renderFindingRow(pushedFindingId, false)}</ItemGroup>
      </ItemList>
    );
  }
  const meta = [
    ...(review ? [{ key: 'subject', text: reviewSubjectLabel(review.subjectKind) }] : []),
    ...(record.rounds.length > 0 ? [{ key: 'round', text: t('reviewWalkthrough.detail.round', { round: lastOrdinal }) }] : []),
    ...(record.rounds[0] ? [{ key: 'started', text: t('reviewWalkthrough.detail.startedAt', {
      time: formatShortRelativeTime(record.rounds[0].startedAt) }) }] : []),
    // Who it reaches, once it reaches anyone (the Artifact audience owner's words); a private Review says nothing.
    ...(audience?.shared ? [{ key: 'audience', icon: 'users' as const, text: audience.team
      ? t('artifacts.browser.facts.sharedWithTeam', { team: audience.team }) : t('artifacts.browser.facts.shared') }] : []),
  ];
  return (
    <ReviewPagePluginContent reviewId={artifact.id} serverId={artifact.sourceServerId ?? artifactScope?.serverId ?? null}
      selection={props.pluginPageSelection}>{menu => (
    <ReviewDetailView
      title={record.title || t('detailsSurface.review.title')}
      meta={meta}
      primaryAction={primaryAction}
      notice={round?.state === 'partial' || (scope && ((newRound.approval.approvalPending && newRound.approval.approvalId)
        || (humanActions.approval.approvalPending && humanActions.approval.approvalId))) ? <>
        {/* A partial round says once, here, who didn't finish and why (lab notice line); the score line says no more. */}
        {round?.state === 'partial' ? <SurfaceStateCard testID="review-detail:partial" kind="warning" size="line"
          title={unfinishedRuns.length > 0 ? t('reviewWalkthrough.detail.reviewersDidntFinish', {
            names: formatReviewerSet(unfinishedRuns.map(run => resolveExecutionRunBackendLabel(run.backendTarget)
              ?? t('reviewWalkthrough.detail.reviewerRun', { count: 1 }))) }) : t('reviewWalkthrough.detail.qualityPartial')}
          {...(partialReason ? { reason: partialReason } : {})} /> : null}
        {scope && newRound.approval.approvalPending && newRound.approval.approvalId ? <ActionApprovalPendingNotice
        testID="review-detail:new-round-approval" message={t('approvals.title')}
        onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(newRound.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
        {humanActions.approval.approvalPending && humanActions.approval.approvalId && scope ? <ActionApprovalPendingNotice
          testID="review-detail:people-approval" message={t('approvals.title')}
          onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(humanActions.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}</> : null}
      menu={[...(canSubmit && implementAction ? [{ id: 'implement', testID: 'review-detail:implement-menu', title: implementAction.title,
        disabled: implementAction.disabled, onSelect: implementFindings }] : []),
        ...(newRoundAction && primaryAction !== newRoundAction ? [{ id: 'new-round', testID: 'review-detail:new-round',
        title: newRoundAction.title, onSelect: newRound.open }] : []),
        ...(canEditPeople ? [{ id: 'edit-reviewers', testID: 'review-detail:edit-reviewers', title: t('reviewWalkthrough.detail.people'),
          disabled: !humanActions.ready, onSelect: () => setPeopleOpen(true) }] : []),
        { id: 'copy-fix-prompt', testID: 'review-detail:copy-fix-prompt', title: t('reviewWalkthrough.detail.copyFixPrompt'),
        disabled: findings.implement.destinationDisabled, onSelect: async () => { await findings.implement.copyPrompt(); } },
        ...(operations.canShare ? [{ id: 'share', testID: 'review-detail:share', title: t('artifacts.browser.actions.share'),
          onSelect: () => operations.share() }] : []),
        ...menu,
        ...(operations.canManage ? [{ id: 'delete', testID: 'review-detail:delete', title: t('artifacts.delete'), destructive: true,
          loading: operations.deleting, onSelect: operations.remove }] : [])]}
      glance={projectReviewGlance(round, review, { countsOnChips: true, fixedCount })}
      quality={projectReviewRoundQualityV1(round, qualityAggregation)}
      rounds={rounds}
      selectedRound={selectedRound}
      onSelectRound={ordinal => { void viewCommands.invoke('review.detail.round', { ordinal }); }}
      submit={canSubmit && submitOpen ? (
        <ReviewSubmitPanel roundOrdinal={selectedRound} onCancel={() => setSubmitOpen(false)} onSubmit={submit} />
      ) : null}
      tabs={tabs}
      activeTab={activeTab}
      onSelectTab={tab => { void viewCommands.invoke('review.detail.tab', { tab }); }}
    >
      {canEditPeople && peopleOpen && scope && human ? <ReviewPeopleEditor key={selectionKey} scope={scope} roundOrdinal={selectedRound}
        names={names} initialReviewers={human.requests.filter(request => request.roundOrdinal === selectedRound)
          .map(request => ({ principal: request.principal, required: request.required }))}
        onCancel={() => setPeopleOpen(false)} onSubmit={savePeople} /> : null}
      {activeTab === 'findings' ? <>
        {comments.status === 'idle' || comments.status === 'loading' ? <ItemGroup header="none"><ItemLoadStateRows state={LOADING_ROWS} rows={3} /></ItemGroup>
          : findings.rows.length > 0 || findings.unavailableFindings.length === 0 ? <ReviewFindingsList rows={findingListRows}
              selection={canEdit ? { selectedRowIds: selectedFindingIds, onToggle: toggleSelection, disabled: bulkBusy,
                active: selecting, onStart: startSelecting } : undefined}
              renderRow={renderFindingRow} /> : null}
        {findings.unavailableFindings.map(comment => <SurfaceStateCard key={comment.id}
          testID={`review-detail:unavailable-finding:${comment.id}`} kind="warning" size="line"
          title={t(comment.flags.redacted || comment.tombstone ? 'files.reviewComments.durable.redacted' : 'files.reviewComments.durable.contentUnavailable')} />)}
        {comments.status === 'failed' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
          action={{ label: t('common.retry'), onPress: () => void comments.refresh() }} /> : null}
        {comments.cursor ? <TextLinkButton testID="review-findings-load-more-comments" disabled={comments.loadingMore}
          label={t(comments.loadMoreFailed ? 'common.retry' : 'files.reviewComments.durable.showMore')} onPress={() => void comments.loadMore()} /> : null}
        {canEdit ? <SelectionActionBar testID="review-detail:selection" visible={selecting}
          label={t('sessionsList.selectionSelectedCount', { count: selectedRowIds.length })}
          dismiss={{ label: t('common.cancel'), presentation: 'glyph', disabled: bulkBusy, onPress: endSelecting }}
          actions={[
            { id: 'implement', label: t('runPage.review.implementFixes', { count: findings.implement.count }), emphasis: 'primary',
              testID: 'review-detail:bulk:implement', disabled: bulkBusy || findings.implement.destinationDisabled,
              busy: findings.implement.busy, onPress: () => { void implementFindings(); } },
            ...REVIEW_FINDING_DECISIONS.map(decision => ({ id: decision, label: reviewFindingDecisionLabel(decision), emphasis: 'secondary' as const,
              testID: `review-detail:bulk:${decision}`, disabled: bulkBusy || selectedRowIds.length === 0, onPress: () => { void bulkDecide(decision); } })),
            { id: 'needs_refinement', label: reviewFindingDecisionLabel('undecided'), emphasis: 'secondary',
              testID: 'review-detail:bulk:needs_refinement', disabled: bulkBusy || selectedRowIds.length === 0, onPress: () => { void bulkDecide('needs_refinement'); } },
            { id: 'create-task', label: t('runPage.review.createTask'), emphasis: 'secondary', placement: 'menu',
              testID: 'review-detail:bulk:create-task', disabled: bulkBusy || selectedRowIds.length === 0,
              onPress: () => { void findings.createTask(selectedRowIds); } },
          ]} /> : null}
        {questionRuns.state.kind === 'loading' && questionRuns.members.length === 0
          ? <SurfaceStateCard kind="loading" size="line" title={t('common.loading')} /> : null}
        {questionRuns.state.kind === 'unavailable' ? <SurfaceStateCard testID="review-detail:questions-unavailable"
          kind={questionRuns.state.reason === 'read_failed' ? 'error' : 'unavailable'} size="line"
          title={questionRuns.state.reason === 'temporarily_unavailable' ? t('session.reviewFindings.questionsMachineUnavailable')
            : questionRuns.state.reason === 'run_missing' ? t('session.reviewFindings.questionsRunMissing')
              : t('surfaceState.couldNotOpen', { name: t('session.reviewFindings.questionsTitle') })}
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
      {activeTab === 'runs' && round ? <ReviewRoundRuns round={round} scope={scope} reads={questionRuns.runs} /> : null}
      {activeTab === 'activity' ? (
        comments.status === 'idle' || comments.status === 'loading' ? <ItemGroup header="none"><ItemLoadStateRows state={LOADING_ROWS} rows={3} /></ItemGroup>
          : <ReviewActivityFeed events={activityEvents} viewerAccountId={scope?.accountId ?? null} names={names} />
      ) : null}
    </ReviewDetailView>
    )}</ReviewPagePluginContent>
  );
}

/**
 * The round's runs (lab `detail-runs`), each opening its own result page. A reviewer run its Machine answered for is
 * the shared Run row: its Agent's mark and name, model, state, then how many findings it reported and how long it
 * took. A run not read (yet, or its Machine is away) keeps its place by its kind.
 */
export function ReviewRoundRuns(props: Readonly<{
  round: ReviewRecordRound;
  scope: ServerAccountScope | null;
  reads?: ReadonlyMap<string, ReviewRoundRunRead>;
}>) {
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
        const onPress = href ? () => router.push(href as never) : undefined;
        const read = run.kind === 'execution' ? props.reads?.get(run.runId)?.run ?? null : null;
        if (run.kind === 'execution' && read) {
          const findingsCount = props.reads?.get(run.runId)?.findingsCount ?? null;
          const duration = read.finishedAtMs !== undefined ? formatElapsedDuration(read.finishedAtMs - read.startedAtMs) : null;
          return (
            <View key={run.runId} testID={`review-detail:run:${run.runId}`}>
              <ExecutionRunRow run={read} serverId={scope?.serverId ?? null} machineId={run.machineId} onPress={onPress}
                subtitle={joinHappierFacts(findingsCount === null ? null : t('reviewWalkthrough.detail.findingsCount', { count: findingsCount }),
                  duration) || undefined} />
            </View>
          );
        }
        return (
          <Item
            key={run.runId}
            testID={`review-detail:run:${run.runId}`}
            title={
              run.kind === 'workflow'
                ? t('reviewWalkthrough.detail.workflowRun')
                : props.round.reviewerDisplayNames?.[props.round.reviewerIds[index] ?? '']
                  ?? t('reviewWalkthrough.detail.reviewerRun', { count: index + 1 })
            }
            subtitle={t(ROUND_STATE_KEYS[props.round.state])}
            {...(onPress ? { onPress } : {})}
          />
        );
      })}
    </ItemGroup>
  );
}
