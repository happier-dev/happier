import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  openReviewArtifactV1,
  describeReviewRoundQualityV1,
  REVIEW_ARTIFACT_KIND_V1,
  type ReviewArtifactV1,
  type ReviewRoundStateV1,
} from '@happier-dev/protocol/reviews/reviewArtifactV1';

import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ReviewHumanActionStateV1, ReviewVerdictKindV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactViewRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useSharePrincipalNames } from '@/components/sharing/sharePrincipalNames';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { presentActionExecutionFailure, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { ReviewChangesHost } from '../ReviewChangesHost';
import { formatReviewCommentAnchor, resolveReviewCommentBodyPromptDefault } from '../content';
import { formatCodeCommitShortOid } from '@/components/projects/files/code/codeEntryHistoryPresentation';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { useReviewDetail } from '../useReviewDetail';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { ReviewReadFailure } from '../ReviewReadFailure';
import { useReviewHumanActions } from '../useReviewHumanActions';
import { useReviewHistory } from '../useReviewHistory';
import { useReviewComments } from '@/components/sessions/reviews/findings/useReviewRunComments';
import { ReviewFindingPageBody, ReviewFindingRow, ReviewFindingTaskProjectionDemand, REVIEW_FINDING_DECISIONS, reviewFindingDecisionLabel } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { formatReviewFindingLocation, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import { SelectionActionBar, SELECTION_ACTION_BAR_RESERVE_PX } from '@/components/ui/selection/SelectionActionBar';
import { useReviewFindingsModel, type ReviewFindingDecisionTarget } from '../finding/useReviewFindingsModel';
import { ReviewQuestions, ReviewFollowUpDock } from '../finding/ReviewQuestions';
import { useReviewQuestionRuns, type ReviewRoundRunRead } from './useReviewQuestionRuns';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { resolveExecutionRunAgentMarkId } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { projectReviewRoundReviewers, reviewCommentEngineName, reviewRoundReviewerIdentity, reviewRoundReviewerOutcomeLabel, reviewRoundReviewerStateLabel,
  reviewRosterOf, reviewRoundReviewerRowCount, reviewRoundUnfinishedReviewers, type ReviewRoundReviewer, type ReviewRoundReviewerRead } from '../reviewRoundReviewers';
import type { ReviewRetriedReviewer } from './useReviewNewRound';
import { joinList } from '@/utils/text/joinList';
import { resolveExecutionRunSelectionLabel, resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import type { ReviewSubjectKindV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { filterReviewChangesComments } from './reviewChangesComments';
import { ReviewFindingsList, ReviewFindingsLoading, type ReviewFindingsRowSelection } from './ReviewFindingsList';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Typography } from '@/constants/Typography';
import { presentSessionAddressSelection } from '@/components/sessions/transcript/messageSelection/presentSessionAddressSelection';
import { readArtifactAccessCapabilities } from '@/sync/domains/artifacts/artifactAccessCapabilities';
import { useArtifactOperations } from '@/components/artifacts/useArtifactOperations';
import { useArtifactAudience } from '@/components/artifacts/useArtifactAudience';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ReviewSubmitPanel } from './ReviewSubmitPanel';
import { ReviewPeopleEditor } from './ReviewPeopleEditor';
import { reviewFindingFacts, reviewHistoryFacts } from './reviewFindingFacts';
import { projectReviewActivity, type ReviewActivityEvent } from './reviewActivity';
import { ReviewActivityFeed, ReviewActivityLoading } from './ReviewActivityFeed';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { useReviewNewRound } from './useReviewNewRound';
import { projectReviewGlance } from './reviewGlance';
import { reviewSubjectFact } from '../list/reviewSubjectLabel';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader, type PageHeaderPrimaryAction } from '@/components/ui/layout/PageHeader';
import { useDeviceType } from '@/utils/platform/responsive';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { useActiveServerAccountScopeLifetime, useWorkflowRun } from '@/sync/store/hooks';
import { createWorkflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import { useWorkflowInlineRunControls } from '@/components/workflows/run/useWorkflowInlineRunControls';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { NavigationChromeTitle } from '@/components/ui/layout/navigationTitleChrome';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { formatMoment } from '@/utils/datetime/formatMoment';
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

/** A reviewer's Agent mark: its run's Agent once read, else the Agent its recorded name is; otherwise its name stands alone. */
function ReviewerMark(props: Readonly<{ reviewer: Pick<ReviewRoundReviewer, 'agentId' | 'run'>; size?: number }>) {
  const { theme } = useUnistyles();
  const agentId = props.reviewer.run ? resolveExecutionRunAgentMarkId(props.reviewer.run.backendTarget, theme) : props.reviewer.agentId;
  return agentId ? <AgentIcon agentId={agentId} size={props.size ?? ICON_SIZE.sm} /> : null;
}

/**
 * The opened record's rounds as the page draws them: who reviewed, each by name with how it ended (its findings once
 * it finished), from the round's one per-reviewer reading (`projectReviewRoundReviewers`). How the round as a whole
 * ended is said once, by the glance and the notice line, so the row does not repeat it.
 */
export function projectRound(round: ReviewRecordRound, reads?: ReadonlyMap<string, ReviewRoundReviewerRead>,
  roster?: ReturnType<typeof reviewRosterOf>): ReviewDetailRound {
  // A round only people review has no agent or engine row; its people row says who was asked.
  if (round.reviewerIds.length === 0) return { ordinal: round.ordinal, state: round.state, groups: [] };
  const reviewers = projectReviewRoundReviewers(round, reads, roster);
  if (reviewers.length === 0) return { ordinal: round.ordinal, state: round.state, groups: [] };
  const unfinished = new Set(reviewRoundUnfinishedReviewers(round, reviewers).map(reviewer => reviewer.reviewerId));
  // Places alone ("Reviewer 1 · Reviewer 2") repeat the count above them; the row names reviewers only when the round
  // recorded a name or a reviewer has an outcome to say.
  const saysMore = reviewers.some(reviewer => reviewer.named || reviewer.outcome !== null);
  return {
    ordinal: round.ordinal,
    state: round.state,
    groups: [
      {
        id: 'reviewers',
        title: t('reviewWalkthrough.detail.reviewersCount', {
          count: round.reviewerIds.length,
        }),
        status:
          round.state === 'running'
            ? 'running'
            : round.state === 'failed' || round.state === 'partial'
              ? 'failed'
              : 'done',
        participants: !saysMore ? [] : reviewers.map(reviewer => ({
          id: reviewer.reviewerId,
          label: reviewer.name,
          mark: reviewer.run || reviewer.agentId ? <ReviewerMark reviewer={reviewer} /> : null,
          // An older one-reviewer round that didn't finish says so on its card too, as its notice and Runs do (U8 R6 P11).
          state: reviewer.outcome === null ? unfinished.has(reviewer.reviewerId) ? reviewRoundReviewerOutcomeLabel('partial') : null
            : reviewer.outcome === 'completed' && reviewer.findingsCount !== null
              ? t('reviewWalkthrough.detail.findingsCount', { count: reviewer.findingsCount })
              : reviewRoundReviewerStateLabel(reviewer),
          tone: reviewer.outcome === 'failed' ? 'failed'
            : reviewer.outcome === 'partial' || unfinished.has(reviewer.reviewerId) ? 'attention' : null,
        })),
      },
    ],
  };
}

/** What a fixed finding says on its row and its page: the commit that fixed it once recorded (lab `detail-fixed`). */
function reviewFindingFixedWords(fixCommit: string | null): string {
  return fixCommit ? t('reviewWalkthrough.detail.fixedIn', { sha: formatCodeCommitShortOid(fixCommit) }) : t('reviewWalkthrough.detail.fixed');
}

const VERDICT_KEYS = {
  approve: 'reviewWalkthrough.detail.verdictApproved',
  request_changes: 'reviewWalkthrough.detail.verdictChangesRequested',
  comment: 'reviewWalkthrough.detail.verdictCommented',
} as const satisfies Record<ReviewVerdictKindV1, string>;

const EMPTY_PRINCIPALS: readonly PrincipalRefV1[] = Object.freeze([]);
const NO_ACTIVITY: readonly ReviewActivityEvent[] = Object.freeze([]);
const NO_SELECTED_FINDINGS: ReadonlySet<string> = new Set();

/** Every person the opened Review names, resolved in the page's existing principal batch. */
function humanPrincipals(human: ReviewHumanActionStateV1 | null, requesterAccountId: string | null): readonly PrincipalRefV1[] {
  if (!human && !requesterAccountId) return EMPTY_PRINCIPALS;
  const byKey = new Map<string, PrincipalRefV1>();
  if (requesterAccountId) {
    const principal: PrincipalRefV1 = { kind: 'account', accountId: requesterAccountId };
    byKey.set(sharePrincipalKey(principal), principal);
  }
  for (const request of human?.requests ?? []) byKey.set(sharePrincipalKey(request.principal), request.principal);
  for (const verdict of human?.verdicts ?? []) {
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
  const homeNotice = <HomeReachabilityGate variant="line" presentation="inline"
    relevantServerIds={artifactScope ? [artifactScope.serverId] : []}>
    {detail.error ? <ReviewReadFailure testID="review-detail:metadata-failure" size="line"
      failure={detail.error} onRetry={detail.refresh} /> : null}
  </HomeReachabilityGate>;
  const review = detail.data?.review ?? null;
  const human = detail.data?.human ?? null;
  const lastOrdinal = record?.rounds.at(-1)?.ordinal ?? 1;
  const [selected, setSelected] = React.useState<number | null>(null);
  const selectedRound = selected ?? lastOrdinal;
  const [tab, setTab] = React.useState<ReviewDetailTabId>('findings');
  const [openFinding, setOpenFinding] = React.useState<string | null>(props.focusThreadId ?? null);
  const [changesView, setChangesView] = React.useState<'files' | 'walkthrough'>('files');
  const [submitOpen, setSubmitOpen] = React.useState(false);
  const [peopleOpen, setPeopleOpen] = React.useState(false);
  const selectionKey = JSON.stringify([scope?.serverId, scope?.accountId, artifact.id, selectedRound]);
  const [changesReviewer, setChangesReviewer] = React.useState<Readonly<{ key: string; engineId: string | null }>>({ key: selectionKey, engineId: null });
  const selectedChangesReviewer = changesReviewer.key === selectionKey ? changesReviewer.engineId : null;
  const [selection, setSelection] = React.useState<Readonly<{ key: string; ids: ReadonlySet<string> }>>({ key: selectionKey, ids: NO_SELECTED_FINDINGS });
  const selectedFindingIds = selection.key === selectionKey ? selection.ids : NO_SELECTED_FINDINGS;
  const selectedRowIds = React.useMemo(() => [...selectedFindingIds], [selectedFindingIds]);
  // Selection is a mode behind Select (lab `detail-bulk`): rows show only their status glyph until it starts.
  const [selectingKey, setSelectingKey] = React.useState<string | null>(null);
  const selecting = selectingKey === selectionKey || selectedRowIds.length > 0;
  const requester = record?.requestedBy;
  const requesterAccountId = requester?.actorKind === 'person' ? requester.accountId
    : requester?.onBehalfOf && areServerProfileIdentifiersEquivalent(requester.onBehalfOf.serverId, scope?.serverId)
      ? requester.onBehalfOf.accountId : null;
  const principals = React.useMemo(() => humanPrincipals(human, requesterAccountId), [human, requesterAccountId]);
  const { names } = useSharePrincipalNames(principals.length > 0 ? principals : null, scope?.serverId ?? null);
  const humanActions = useReviewHumanActions(scope, human);
  const round = record?.rounds.find((item) => item.ordinal === selectedRound) ?? record?.rounds.at(-1);
  const qualityAggregation = useSetting('reviewQualityAggregation');
  const roundQuality = React.useMemo(() => describeReviewRoundQualityV1(round, qualityAggregation), [round, qualityAggregation]);
  // Show all names each scored reviewer through the round section's name owner (`reviewRoundReviewerIdentity`): its
  // recorded name, else the name the score kept, else its place ("Reviewer 2").
  const qualityReviewers = React.useMemo(() => round ? roundQuality.reviewers.map(reviewer => {
    const identity = reviewRoundReviewerIdentity(round, reviewer.reviewerId);
    return { ...reviewer, displayName: identity.named ? identity.name : reviewer.displayName ?? identity.name };
  }) : roundQuality.reviewers, [round, roundQuality.reviewers]);
  const capture = round?.comparisonCapture ?? null;
  const tabs = React.useMemo((): readonly ReviewDetailTab[] => [
    { id: 'findings' },
    { id: 'changes' },
    // A tab with nothing under it carries no count ("Runs", never "Runs 0").
    { id: 'runs', count: (round ? reviewRoundReviewerRowCount(round) : 0) || null },
    { id: 'activity' },
  ], [round]);
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
  // A running Review is stopped through the Workflow run that runs it, by the run's own Stop (U8 R6 RN1).
  const runningWorkflowRunId = round?.state === 'running'
    ? round.runs.find(run => run.kind === 'workflow')?.runId ?? detail.data?.review.workflowRunId ?? null : null;
  const [stopAction, setStopAction] = React.useState<PageHeaderPrimaryAction | null>(null);
  const decide = React.useCallback((target: ReviewFindingDecisionTarget, decision: 'accept' | 'reject' | 'defer') =>
    comments.decide(target.comment.id, decision), [comments.decide]);
  const findingRound = React.useMemo(() => round && record ? { round: { reviewId: record.reviewId,
    roundOrdinal: round.ordinal, reviewerIds: round.reviewerIds, state: round.state,
    ...(round.reviewerDisplayNames ? { reviewerDisplayNames: round.reviewerDisplayNames } : {}) }, comments: comments.comments,
    roster: reviewRosterOf(record.rounds) } : undefined,
  [comments.comments, record, round]);
  // The round's reviewer runs: questions on Findings, who ran and how it ended on Runs and Activity, and which
  // reviewer didn't finish on the page's notice line.
  const questionRuns = useReviewQuestionRuns({ runs: round?.runs, round, accountLifetime: binding,
    enabled: presented && (activeTab === 'findings' || (round?.state === 'running' && (activeTab === 'runs' || activeTab === 'activity'))) });
  // The reviewers' overview paragraphs lead the Findings tab; the findings open one section gap below them, or at the
  // panel's own gap under the tabs when there is none (one decision for both the overviews and the gap).
  const overviewMembers = questionRuns.members.filter(member => member.overviewMarkdown.trim() !== '');
  const findingsFollowOverview = overviewMembers.length > 0;
  // Every reviewer the Review named across its rounds: one name per reviewer in every round, notice and Retry title.
  const roster = React.useMemo(() => record ? reviewRosterOf(record.rounds) : undefined, [record]);
  const rounds = React.useMemo(() => record?.rounds.map(item => {
    // Only the selected round's runs are read; other rounds name their reviewers from their own record.
    const projected = projectRound(item, item.ordinal === round?.ordinal ? questionRuns.runs : undefined, roster);
    const people = human ? projectPeople({ human, round: item.ordinal, names, viewerAccountId: scope?.accountId ?? null }) : null;
    return people ? { ...projected, groups: [...projected.groups, people] } : projected;
  }) ?? [], [human, names, questionRuns.runs, record, roster, round?.ordinal, scope?.accountId]);
  const unfinishedReviewers = React.useMemo(() => round?.state !== 'partial' ? []
    : reviewRoundUnfinishedReviewers(round, projectReviewRoundReviewers(round, questionRuns.runs, roster)), [questionRuns.runs, roster, round]);
  const findings = useReviewFindingsModel({ members: questionRuns.members, record: findingRound,
    reviewerCount: round?.reviewerIds.length ?? 0, scope, accountLifetime: binding,
    serverId: scope?.serverId ?? null, sessionId: null, canAct: canEdit, pending: comments.pending,
    selectedRowIds: selectedRowIds.length > 0 ? selectedRowIds : undefined,
    onDecideComment: decide, onBulkDecideComments: comments.decideMany });
  const findingsFailurePresentation = findings.failure ? presentActionExecutionFailure(findings.failure) : null;
  const findingsErrorNotice = findings.error ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
    reason={findings.error} diagnosticCode={findings.failure?.errorCode}
    diagnosticDetail={findingsFailurePresentation?.technicalDetails.filter(detail => detail.key !== 'code')
      .map(detail => `${detail.label}: ${detail.value}`).join('\n') || undefined} /> : null;
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
    runReads: questionRuns.runs,
  }), [activeTab, comments.comments, human?.verdicts, questionRuns.runs, record]);
  const allRoundComments = React.useMemo(() => filterReviewChangesComments(comments.comments,
    { roundOrdinal: selectedRound, reviewerId: null }), [comments.comments, selectedRound]);
  const changesReviewers = React.useMemo(() => [...new Set(allRoundComments.flatMap(comment =>
    comment.engineId ? [comment.engineId] : []))], [allRoundComments]);
  const roundComments = React.useMemo(() => selectedChangesReviewer === null ? allRoundComments
    : filterReviewChangesComments(allRoundComments, { roundOrdinal: selectedRound, reviewerId: selectedChangesReviewer }),
  [allRoundComments, selectedChangesReviewer, selectedRound]);
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
    { key: 'review.detail.filter_reviewer', title: t('reviewWalkthrough.start.whoReviews'), description: 'Filter Changes comments by reviewer engine with {engineId: string}, or show all with {engineId: null}.', invoke: input => {
      if (!isJsonObject(input) || (input.engineId !== null && (typeof input.engineId !== 'string' || !changesReviewers.includes(input.engineId)))) return false;
      setChangesReviewer({ key: selectionKey, engineId: input.engineId });
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

  if (!record) {
    // The row is known, its body is not (yet): the chrome keeps the Artifact's own title through these states, never the
    // route's "Artifacts" (G3b); the page header takes over once the record opens.
    const state = props.bodyState === 'loading' ? <ReviewDetailState kind="loading" />
      : props.bodyState === 'failed' ? <ReviewDetailState kind="failed" onRetry={props.onRetry} />
      : <ReviewDetailState kind="missing" reason={t('reviewWalkthrough.detail.unreadable')} />;
    return <><NavigationChromeTitle title={artifact.title || t('detailsSurface.review.title')} />{state}</>;
  }
  // Until the Review owner's first read lands, the page stands on its record (title, scores, reviewers) and the glance
  // holds its line. People, the tabs and the findings depend on that read, so they arrive with it as one block and no
  // control moves under the reader; what waits on the reader isn't known yet, so nothing is offered (never New round).
  const personPending = Boolean(scope) && !detail.data && (detail.status === 'idle' || detail.status === 'loading');

  const canSubmit =Boolean(human?.needsYou.canSubmitVerdict && human.roundOrdinal === selectedRound && submitVerdict);
  const canEditPeople = canEdit && human?.roundOrdinal === selectedRound && setReviewers !== undefined;
  // One primary (lab `detail-findings`): Submit review when the Review asks it of you; otherwise "Implement N fixes"
  // once a finding is accepted and not yet fixed. While findings still wait for a decision and none is accepted there
  // is no primary (the glance names the next step); New round leads only once the round is settled.
  const implementAction = canEdit && findings.implement.count > 0 ? {
    title: t('runPage.review.implementFixes', { count: findings.implement.count }), testID: 'review-detail:implement-primary',
    disabled: findings.implement.destinationDisabled, loading: findings.implement.busy, onPress: implementFindings } : null;
  const awaitingDecision = findings.rows.some(row => row.decision === 'undecided' && !row.fixed);
  const newRoundAction = newRound.available ? { title: t('reviewWalkthrough.detail.newRound'), onPress: newRound.open } : null;
  // Which primary follows from the findings, so while they load there is none: never New round first and then a swap,
  // and no grey placeholder held for one either (U8 R5 B6). The Runs tab doesn't read findings; it decides from what it has.
  const findingsKnown = !scope || activeTab === 'runs' || comments.status === 'loaded' || comments.status === 'failed';
  const primaryAction = canSubmit ? { title: t('reviewWalkthrough.detail.submitReview'), onPress: () => setSubmitOpen(true) }
    : runningWorkflowRunId && stopAction ? stopAction
    : personPending || !findingsKnown ? null
    : implementAction ?? (awaitingDecision ? null : newRoundAction);
  // A finding's standing words: its round status and captured scope, then (a Hunt's) its standing across runs.
  const findingFacts = (row: (typeof findings.rows)[number]) => {
    const comment = commentById.get(row.rowId);
    return [...reviewFindingFacts({ appearance: row.appearance, roundOrdinal: selectedRound, scopeAttribution: comment?.scopeAttribution }),
      ...(comment?.findingIdentity ? historyFactsByIdentity.get(comment.findingIdentity) ?? [] : [])];
  };
  const renderFindingRow = (rowId: string, divided: boolean, selection?: ReviewFindingsRowSelection) => {
    const row = findingById.get(rowId);
    return row ? <ReviewFindingRow rowId={row.rowId} finding={row.finding} currentBodyMarkdown={row.currentBodyMarkdown}
      reviewContext={scope ? { reviewId: record.reviewId, commentId: row.rowId, serverId: scope.serverId } : undefined}
      seenBefore={openFinding === row.rowId ? { history: seenBefore, onRetry: () => void seenBefore.refresh(),
        href: match => artifactViewRoute(match.reviewId, { thread: match.commentId }) } : undefined}
      attribution={row.attribution} reviewers={row.reviewers} original={row.original} density="page" divided={divided}
      decision={row.decision} decisionEditable={row.decisionEditable} decisionDisabled={!row.decidable} decisionNote={null}
      resolution={row.fixed ? reviewFindingFixedWords(row.fixCommit) : null}
      onDecide={findings.onDecide} followUp={row.followUp} threadEntries={row.threadEntries} pendingQuestion={findings.pendingQuestionByRowId[row.rowId] ?? null}
      expanded={openFinding === row.rowId} onToggleExpanded={toggleFinding} askContext={row.askContext}
      onAsk={findings.onAsk} onCreateTask={canEdit ? findings.onCreateTask : undefined}
      facts={findingFacts(row)} selection={selection} /> : null;
  };
  if (pushedFindingId) {
    const index = findings.rows.findIndex(row => row.rowId === pushedFindingId);
    const row = findings.rows[index]!;
    const location = formatReviewFindingLocation(row.finding);
    const facts = findingFacts(row);
    const decisionBar = row.decision !== null && row.decisionEditable !== false;
    // The pushed finding is its own page (lab `detail-finding-390`): its title is the page title under its severity
    // and place in the Review, its facts line names where and who, and its decision waits in the bottom bar.
    return (
      <View style={{ flex: 1 }}>
        {canEdit && scope && decisionBar ? <ReviewFindingTaskProjectionDemand scope={scope} /> : null}
        <ItemList testID="review-detail:finding-page" pageColumn="wide">
          {homeNotice}
          <PageHeader title={row.finding.title} alwaysShowTitle navigationTitle={t('detailsSurface.review.title')}
            testID="review-detail:finding-page:header"
            kicker={joinHappierFacts(reviewSeverityLabel(row.finding.severity),
              t('reviewWalkthrough.detail.findingPosition', { index: index + 1, total: findings.rows.length }))}
            // A fixed finding says so on its own page, as its row does (it has no decision left to make).
            meta={[...(row.fixed ? [{ key: 'fixed', icon: 'check-circle' as const, text: reviewFindingFixedWords(row.fixCommit) }] : []),
              ...(location ? [{ key: 'location', text: location, mono: true }] : []),
              ...(row.attribution ? [{ key: 'attribution', text: row.attribution.label }] : []),
              ...facts.map(fact => ({ key: `fact:${fact}`, text: fact }))]} />
          {/* A section of its own, so the body starts a section gap under the facts line (U8 R5 C2). */}
          <ItemGroup surface="none">
            <ReviewFindingPageBody rowId={row.rowId} finding={row.finding} currentBodyMarkdown={row.currentBodyMarkdown}
              reviewContext={scope ? { reviewId: record.reviewId, commentId: row.rowId, serverId: scope.serverId } : undefined}
              seenBefore={{ history: seenBefore, onRetry: () => void seenBefore.refresh(),
                href: match => artifactViewRoute(match.reviewId, { thread: match.commentId }) }}
              attribution={row.attribution} reviewers={row.reviewers} original={row.original} density="page" divided={false}
              decision={row.decision} decisionEditable={row.decisionEditable} decisionDisabled={!row.decidable} decisionNote={null}
              onDecide={findings.onDecide} followUp={row.followUp} threadEntries={row.threadEntries}
              pendingQuestion={findings.pendingQuestionByRowId[row.rowId] ?? null} expanded onToggleExpanded={toggleFinding}
              askContext={row.askContext} onAsk={findings.onAsk} ask={message => findings.onAsk(row.rowId, message)} />
          </ItemGroup>
          {findingsErrorNotice}
          {decisionBar ? <View style={{ height: SELECTION_ACTION_BAR_RESERVE_PX }} /> : null}
        </ItemList>
        {decisionBar ? <SelectionActionBar placement="pinned" testID="review-detail:decision-bar" visible
          accessibilityLabel={row.finding.title}
          actions={[...REVIEW_FINDING_DECISIONS.map(decision => ({ id: decision, label: reviewFindingDecisionLabel(decision),
            emphasis: 'secondary' as const, selected: row.decision === decision, testID: `review-detail:decision:${decision}`,
            disabled: !row.decidable, onPress: () => findings.onDecide(row.rowId, decision) })),
          ...(canEdit ? [{ id: 'create-task', label: t('runPage.review.createTask'), placement: 'menu' as const,
            testID: 'review-detail:decision:create-task', onPress: () => { void findings.onCreateTask(row.rowId); } }] : [])]} /> : null}
      </View>
    );
  }
  const meta = [
    // What it read: a branch Review by its refs ("04996b5 vs main", U8 R5 L1), others by their subject word.
    ...(review ? [{ key: 'subject', ...reviewSubjectFact(review.subjectKind, record.rounds.at(-1)?.comparisonCapture?.input.source) }] : []),
    ...(record.rounds.length > 0 ? [{ key: 'round', text: t('reviewWalkthrough.detail.round', { round: lastOrdinal }) }] : []),
    ...(record.rounds[0] ? [{ key: 'started', text: t('reviewWalkthrough.detail.startedAt', {
      time: formatShortRelativeTime(record.rounds[0].startedAt) }) }] : []),
    ...(requesterAccountId ? [{ key: 'requester', text: `${t('detailPages.approval.contextTitle')} ${presentSharePrincipal({
      ref: { kind: 'account', accountId: requesterAccountId },
      name: names?.get(sharePrincipalKey({ kind: 'account', accountId: requesterAccountId })) ?? null,
      viewerAccountId: scope?.accountId ?? null,
    }).displayName}` }] : []),
    // Who it reaches, once it reaches anyone (the Artifact audience owner's words); a private Review says nothing.
    ...(audience?.shared ? [{ key: 'audience', icon: 'users' as const, text: audience.team
      ? t('artifacts.browser.facts.sharedWithTeam', { team: audience.team }) : t('artifacts.browser.facts.shared') }] : []),
  ];
  // Select mode's one bottom bar (lab `detail-bulk`): the decision verbs for the selected findings, pinned over the
  // page's bottom; applying the decided fixes stays the header's primary, and the rare actions wait under "…".
  const bulkBar = canEdit ? <SelectionActionBar placement="pinned" testID="review-detail:selection" visible={selecting}
    label={t('sessionsList.selectionSelectedCount', { count: selectedRowIds.length })}
    dismiss={{ label: t('common.cancel'), presentation: 'glyph', disabled: bulkBusy, onPress: endSelecting }}
    actions={[
      ...REVIEW_FINDING_DECISIONS.map(decision => ({ id: decision, label: reviewFindingDecisionLabel(decision),
        emphasis: decision === 'accept' ? 'primary' as const : 'secondary' as const,
        testID: `review-detail:bulk:${decision}`, disabled: bulkBusy || selectedRowIds.length === 0, onPress: () => { void bulkDecide(decision); } })),
      { id: 'needs_refinement', label: reviewFindingDecisionLabel('undecided'), emphasis: 'secondary',
        testID: 'review-detail:bulk:needs_refinement', disabled: bulkBusy || selectedRowIds.length === 0, onPress: () => { void bulkDecide('needs_refinement'); } },
      { id: 'create-task', label: t('runPage.review.createTask'), emphasis: 'secondary', placement: 'menu',
        testID: 'review-detail:bulk:create-task', disabled: bulkBusy || selectedRowIds.length === 0,
        onPress: () => { void findings.createTask(selectedRowIds); } },
    ]} /> : null;
  return (
    <ReviewPagePluginContent reviewId={artifact.id} serverId={artifact.sourceServerId ?? artifactScope?.serverId ?? null}
      selection={props.pluginPageSelection}>{menu => (
    <View style={{ flex: 1 }}>
    {canEdit && scope && activeTab === 'findings' && (openFinding != null || selecting && selectedRowIds.length > 0)
      ? <ReviewFindingTaskProjectionDemand scope={scope} /> : null}
    <ReviewDetailView
      title={record.title || t('detailsSurface.review.title')}
      meta={meta}
      primaryAction={primaryAction}
      qualityReviewerCount={round?.reviewerIds.length ?? 0}
      qualityAction={newRound.retry && unfinishedReviewers.length > 0 ? <TextLinkButton size="meta"
        testID="review-detail:partial:retry"
        label={unfinishedReviewers.length === 1 ? t('reviewWalkthrough.detail.retryReviewer', { name: unfinishedReviewers[0]!.name })
          : t('reviewWalkthrough.detail.retryUnfinished', { count: unfinishedReviewers.length })}
        onPress={() => newRound.retry?.(unfinishedReviewers)} /> : null}
      notice={<>
        {homeNotice}
        {scope && newRound.approval.approvalPending && newRound.approval.approvalId ? <ActionApprovalPendingNotice
        testID="review-detail:new-round-approval" message={t('approvals.title')}
        onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(newRound.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
        {humanActions.approval.approvalPending && humanActions.approval.approvalId && scope ? <ActionApprovalPendingNotice
          testID="review-detail:people-approval" message={t('approvals.title')}
          onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(humanActions.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}</>}
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
      detailPending={personPending}
      glance={projectReviewGlance(round, review, { countsOnChips: true, fixedCount, needsYou: human?.roundOrdinal === round?.ordinal ? human?.needsYou : undefined })}
      quality={roundQuality.quality}
      qualityUnavailableReason={roundQuality.unavailableReason}
      qualityReviewers={qualityReviewers}
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
        {overviewMembers.map(member => <ItemGroup key={member.runId}
          title={member.reviewerLabel} surface="none">
          {/* Review prose, set like the finding page body: on the title's edge, at the review body size. */}
          <MarkdownView markdown={member.overviewMarkdown} agentTexMath textStyle={styles.prose} />
        </ItemGroup>)}
        {comments.status === 'idle' || comments.status === 'loading' ? <ReviewFindingsLoading followsSection={findingsFollowOverview} />
          : findings.rows.length > 0 ? <ReviewFindingsList rows={findingListRows} followsSection={findingsFollowOverview}
              selection={canEdit ? { selectedRowIds: selectedFindingIds, onToggle: toggleSelection, disabled: bulkBusy,
                active: selecting, onStart: startSelecting } : undefined}
              renderRow={renderFindingRow} />
            // A settled round that found nothing says so in one line (the glance already says "Nothing to fix").
            // A running round that found nothing yet says so too (U8 R6 RN2).
            : findings.unavailableFindings.length === 0 && comments.status === 'loaded' && !comments.cursor
              ? <SurfaceStateCard testID="review-detail:findings-empty" kind="empty" size="line"
                  title={t(round?.state === 'running' ? 'reviewWalkthrough.detail.findingsNoneYet' : 'reviewWalkthrough.detail.findingsEmpty')} /> : null}
        {findings.unavailableFindings.map(comment => {
          // A finding this page can't draw names its place and why, and offers what can still be done: read it again when
          // its words couldn't be read, or see the code it points at when it was saved without its details.
          const testID = `review-detail:unavailable-finding:${comment.id}`;
          const redacted = Boolean(comment.flags.redacted || comment.tombstone);
          const words = redacted ? undefined : resolveReviewCommentBodyPromptDefault(comment.body);
          const location = formatReviewCommentAnchor(comment);
          const title = redacted ? t('reviewWalkthrough.detail.findingRedacted')
            : words === undefined ? t('reviewWalkthrough.detail.findingUnreadable')
              : location ? t('reviewWalkthrough.detail.findingNoDetailsAt', { location }) : t('reviewWalkthrough.detail.findingNoDetails');
          const action = redacted ? undefined
            : words === undefined ? { label: t('common.retry'), testID: `${testID}:action`, onPress: () => void comments.refresh() }
              : location && scope ? { label: t('reviewWalkthrough.detail.showInChanges'), testID: `${testID}:action`,
                onPress: () => { void viewCommands.invoke('review.detail.tab', { tab: 'changes' }); } } : undefined;
          return <SurfaceStateCard key={comment.id} testID={testID} kind="warning" size="line" title={title}
            {...(words ? { reason: words } : {})} {...(action ? { action } : {})} />;
        })}
        {comments.status === 'failed' ? <SurfaceStateCard kind="error" size="line" title={t('common.error')}
          action={{ label: t('common.retry'), onPress: () => void comments.refresh() }} /> : null}
        {comments.cursor ? <TextLinkButton testID="review-findings-load-more-comments" disabled={comments.loadingMore}
          label={t(comments.loadMoreFailed ? 'common.retry' : 'files.reviewComments.durable.showMore')} onPress={() => void comments.loadMore()} /> : null}
        {canEdit && selecting ? <View style={{ height: SELECTION_ACTION_BAR_RESERVE_PX }} /> : null}
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
        {findingsErrorNotice}
        {findings.approval.approvalPending && findings.approval.approvalId && scope ? <ActionApprovalPendingNotice
          testID="review-detail:approval" message={t('approvals.title')}
          onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(findings.approval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} /> : null}
      </> : null}
      {activeTab === 'changes' && scope ? (
        <>
        {changesReviewers.length > 1 ? <View style={{ paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() }}>
          <SegmentedTabBar role="radiogroup" presentation="pills" segmentSizing="content"
            accessibilityLabel={t('reviewWalkthrough.start.whoReviews')}
            overflow={{ label: t('reviewWalkthrough.start.whoReviews') }}
            tabs={[{ id: 'all', label: t('common.all'), testID: 'review-changes:reviewer:all' },
              ...changesReviewers.map((engineId, index) => ({ id: `reviewer:${engineId}`,
                label: reviewCommentEngineName(engineId, index), testID: `review-changes:reviewer:${engineId}` }))]}
            activeTabId={selectedChangesReviewer === null ? 'all' : `reviewer:${selectedChangesReviewer}`}
            onSelectTab={id => { void viewCommands.invoke('review.detail.filter_reviewer', { engineId: id === 'all' ? null : id.slice('reviewer:'.length) }); }} />
        </View> : null}
        <ReviewChangesHost reviewId={record.reviewId} roundOrdinal={selectedRound} scope={scope} capture={capture}
          comments={roundComments} view={changesView} onSelectView={setChangesView} onOpenComment={openComment} />
        </>
      ) : null}
      {activeTab === 'runs' && round ? <ReviewRoundRuns round={round} scope={scope} reads={questionRuns.runs} roster={roster}
        workflowRunId={detail.data?.review.workflowRunId ?? null}
        subjectKind={review?.subjectKind ?? null} onRetry={round.ordinal === lastOrdinal ? newRound.retry : null} /> : null}
      {activeTab === 'activity' ? (
        comments.status === 'idle' || comments.status === 'loading' ? <ReviewActivityLoading />
          : <ReviewActivityFeed events={activityEvents} viewerAccountId={scope?.accountId ?? null} names={names} />
      ) : null}
    </ReviewDetailView>
    {activeTab === 'findings' ? bulkBar : null}
    {runningWorkflowRunId && canEdit ? <ReviewRunStop runId={runningWorkflowRunId} onAction={setStopAction} /> : null}
    </View>
    )}</ReviewPagePluginContent>
  );
}

const REVIEWERS_READ_KEYS = {
  repository: 'reviewWalkthrough.detail.reviewersReadRepository',
  comparison: 'reviewWalkthrough.detail.reviewersReadComparison',
  pull_request: 'reviewWalkthrough.detail.reviewersReadPullRequest',
} as const satisfies Record<ReviewSubjectKindV1, string>;

/**
 * The round's reviewers (lab `detail-runs`): a "Reviewers" section, each row its mark, name and (once its run was read)
 * model, how it ended (rose when it didn't finish), its findings and duration in the meta column, and Retry on one that
 * didn't finish. A running
 * reviewer its Machine answered for is the shared Run row. The Workflow that ran them is the section's own link, so the
 * tab's count is the rows it draws.
 */
export function ReviewRoundRuns(props: Readonly<{
  round: ReviewRecordRound;
  scope: ServerAccountScope | null;
  reads?: ReadonlyMap<string, ReviewRoundRunRead>;
  /** The Review's roster, so a reviewer has the same name here as in every other round. */
  roster?: ReturnType<typeof reviewRosterOf>;
  /** The Workflow run the Review records, for a round that doesn't reference one yet. */
  workflowRunId?: string | null;
  /** What the round read, for the section's line ("Each read the whole repository."). */
  subjectKind?: ReviewSubjectKindV1 | null;
  /** Retry reviewers that did not finish, as a new round with only them (the latest round only). */
  onRetry?: ((reviewers: readonly ReviewRetriedReviewer[]) => void) | null;
}>) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { scope } = props;
  const settled = props.round.state !== 'running';
  const reviewers = projectReviewRoundReviewers(props.round, props.reads, props.roster);
  const unfinished = new Set(reviewRoundUnfinishedReviewers(props.round, reviewers).map(reviewer => reviewer.reviewerId));
  const runsById = new Map(props.round.runs.map(run => [run.runId, run]));
  // The Workflow run that runs the round: its own reference, else the run the Review records (a running round may not
  // reference it yet).
  const workflowRunId = props.round.runs.find(run => run.kind === 'workflow')?.runId ?? props.workflowRunId ?? null;
  const workflowHref = scope && workflowRunId ? createWorkflowRunRoute(workflowRunId, scope.serverId) : null;
  const rowCount = reviewRoundReviewerRowCount(props.round);
  if (rowCount === 0) {
    return (
      <SurfaceStateCard
        testID="review-detail:runs:empty"
        kind="empty"
        size="line"
        title={
          props.round.state === 'running'
            ? t('reviewWalkthrough.detail.glanceRunning')
            : t(ROUND_STATE_KEYS[props.round.state])
        }
        {...(workflowHref ? { action: { label: t('reviewWalkthrough.detail.workflowRun'), testID: 'review-detail:runs:workflow',
          onPress: () => router.push(workflowHref as never) } } : {})}
      />
    );
  }
  const executionHref = (reference: ReviewRecordRound['runs'][number] | undefined) => scope && reference?.kind === 'execution'
    && reference.sessionId ? buildSessionExecutionRunRouteHref({ sessionId: reference.sessionId, runId: reference.runId, serverId: scope.serverId }) : null;
  return (
    // The short link stays on the title row on phones too (section-header action anatomy, U8 R5 P9).
    <ItemGroup testID="review-detail:runs" title={t('reviewWalkthrough.detail.reviewers')} actionLayout="trailing"
      description={props.subjectKind ? t(REVIEWERS_READ_KEYS[props.subjectKind]) : undefined}
      // The Workflow run they ran in, as a verb so it reads as a way there wherever the header places it.
      action={workflowHref ? <TextLinkButton testID="review-detail:runs:workflow" label={t('runs.openRun')}
        onPress={() => router.push(workflowHref as never)} /> : undefined}>
      {settled ? reviewers.map(reviewer => {
        const href = executionHref(reviewer.runId ? runsById.get(reviewer.runId) : undefined);
        const duration = reviewer.startedAt !== undefined && reviewer.finishedAt !== undefined
          ? formatElapsedDuration(reviewer.finishedAt - reviewer.startedAt) : null;
        const model = reviewer.run ? resolveExecutionRunSelectionLabel(reviewer.run.resolvedSelection, () => null, null,
          resolveRunNativeModelLabel(reviewer.run.backendTarget, undefined, reviewer.run.resolvedSelection)) : null;
        const didntFinish = unfinished.has(reviewer.reviewerId);
        const failure = reviewer.failure ? presentActionExecutionFailure(reviewer.failure) : null;
        return <Item key={reviewer.reviewerId} testID={`review-detail:run:${reviewer.runId ?? reviewer.reviewerId}`}
          title={joinHappierFacts(reviewer.name, model)} icon={<ReviewerMark reviewer={reviewer} size={20} />}
          // How it ended and, when it didn't finish, why ("Didn't finish · Usage limit reached"), from the outcome owner.
          subtitle={failure ? <SurfaceStateCard kind="error" size="line" title={reviewer.reason ?? failure.reason}
            diagnosticCode={reviewer.failure?.errorCode}
            diagnosticDetail={failure.technicalDetails.filter(detail => detail.key !== 'code')
              .map(detail => `${detail.label}: ${detail.value}`).join('\n') || undefined} /> : joinHappierFacts(reviewer.outcome === null ? unfinished.has(reviewer.reviewerId)
            ? reviewRoundReviewerOutcomeLabel('partial') : null : reviewRoundReviewerStateLabel(reviewer), reviewer.outcome === 'failed' ? null : reviewer.reason) || undefined}
          // Its findings and how long it took sit in the row's right-aligned meta column (lab `detail-runs`).
          detail={joinHappierFacts(reviewer.findingsCount === null ? null
            : t('reviewWalkthrough.detail.findingsCount', { count: reviewer.findingsCount }), duration) || undefined}
          {...(didntFinish ? { subtitleStyle: { color: theme.colors.state.danger.textForeground } } : {})}
          // Lab `detail-runs`: a reviewer that didn't finish offers Retry at its row's end.
          {...(props.onRetry && didntFinish ? { rightElement: <RoundButton size="small" display="secondary"
            testID={`review-detail:run-retry:${reviewer.reviewerId}`} title={t('common.retry')}
            accessibilityLabel={t('reviewWalkthrough.detail.retryReviewer', { name: reviewer.name })}
            onPress={() => props.onRetry?.([reviewer])} /> } : {})}
          {...(href ? { onPress: () => router.push(href as never) } : {})} />;
      }) : reviewers.map(reviewer => {
        // A running reviewer: its read run as the shared Run row, else its name, how long it has run, and the way to
        // its run (its own when referenced, else the Workflow that runs it), lab `detail-running` (U8 R6 RN1).
        const reference = reviewer.runId ? runsById.get(reviewer.runId) : undefined;
        const href = executionHref(reference) ?? workflowHref;
        const onPress = href ? () => router.push(href as never) : undefined;
        const testID = `review-detail:run:${reviewer.runId ?? reviewer.reviewerId}`;
        if (reviewer.run && reference?.kind === 'execution') {
          const read = reviewer.run;
          const duration = read.finishedAtMs !== undefined ? formatElapsedDuration(read.finishedAtMs - read.startedAtMs) : null;
          return (
            <View key={reviewer.reviewerId} testID={testID}>
              <ExecutionRunRow run={read} serverId={scope?.serverId ?? null} machineId={reference.machineId} onPress={onPress}
                subtitle={joinHappierFacts(reviewer.findingsCount === null ? null
                  : t('reviewWalkthrough.detail.findingsCount', { count: reviewer.findingsCount }), duration) || undefined} />
            </View>
          );
        }
        return (
          <Item
            key={reviewer.reviewerId}
            testID={testID}
            title={reviewer.name}
            icon={<ReviewerMark reviewer={reviewer} size={20} />}
            subtitle={t('reviewWalkthrough.detail.runningSince', {
              time: formatMoment(reviewer.startedAt ?? props.round.startedAt, Date.now()) })}
            {...(onPress ? { onPress } : {})}
          />
        );
      })}
    </ItemGroup>
  );
}

/**
 * A running Review's Stop: its Workflow run's own Stop through the inline run controls owner (as "Stop reviewing" on a
 * Session's run fold), lifted to the page as its primary. It reads the run once when the store doesn't hold it yet.
 */
function ReviewRunStop(props: Readonly<{ runId: string; onAction: (action: PageHeaderPrimaryAction | null) => void }>) {
  const lifetime = useActiveServerAccountScopeLifetime();
  const run = useWorkflowRun(props.runId)?.summary ?? null;
  const known = run !== null;
  React.useEffect(() => {
    if (known || !lifetime) return;
    const controller = new AbortController();
    void createWorkflowRunDetailActions({ accountLifetime: lifetime }).getRun(props.runId, controller.signal).then(detail => {
      if (!controller.signal.aborted && lifetime.isCurrent()) publishOpenedWorkflowRunDetail(detail, lifetime.scope);
    }, () => undefined);
    return () => controller.abort();
  }, [known, lifetime, props.runId]);
  React.useEffect(() => () => props.onAction(null), [props.onAction]);
  return run && lifetime ? <ReviewRunStopControl run={run} lifetime={lifetime} onAction={props.onAction} /> : null;
}

function ReviewRunStopControl(props: Readonly<{ run: WorkflowRunSummaryV1; lifetime: ServerAccountScopeLifetime;
  onAction: (action: PageHeaderPrimaryAction | null) => void }>) {
  const controls = useWorkflowInlineRunControls({ run: props.run, definition: null, acceptedContext: null,
    accountLifetime: props.lifetime, canEdit: true, onStarted: noStart });
  const { onAction } = props;
  const stoppable = props.run.availability.cancel && !controls.cancelRequested;
  const pending = controls.pendingControl;
  const submit = controls.submitControl;
  React.useEffect(() => {
    onAction(stoppable ? { title: t('workflows.transcriptCard.stopReviewing'), icon: 'stop', presentation: 'secondary',
      testID: 'review-detail:stop', loading: pending === 'cancel', disabled: pending !== null,
      onPress: () => { void submit('cancel'); } } : null);
  }, [onAction, pending, stoppable, submit]);
  return null;
}

function noStart(): void {}

const styles = StyleSheet.create((theme) => ({
  // The review body text the finding page and review comments set their prose in.
  prose: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
