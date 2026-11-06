import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ReviewCommentsSessionSurface } from '@/components/reviews/ReviewCommentsSessionSurface';
import { ReviewCommentsHeaderButton, useReviewCommentsMenuSection } from '@/components/reviews/ReviewCommentsHeaderButton';
import { buildReviewCommentsHeaderLabels } from '@/components/reviews/sessionSurfaceLabels';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { NotSourceControlRepositoryState } from '@/components/workspaces/scm/states/NotSourceControlRepositoryState';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states/SourceControlUnavailableState';
import { SourceControlStaleSnapshotNotice } from '@/components/workspaces/scm/states/SourceControlStaleSnapshotNotice';
import { useSession, useSetting, useWorkspaceRefs, useWorkspaceReviewCommentsDrafts, useWorkspaceScmCommitSelectionPatches, useWorkspaceScmCommitSelectionPaths } from '@/sync/domains/state/storage';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { CheckoutUnreachableState, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
    selectPluginPermissionPendingRequests,
} from '@/sync/domains/plugins/permissions/store';
import {
    REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
    pluginPermissionGrantScopeKey,
    type PluginPermissionGrantListInput,
    type PluginPermissionGrantTargetScope,
} from '@/sync/domains/plugins/permissions/types';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { SessionAttributedFile } from '@/scm/scmAttribution';
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { buildCommitSelectionPathHints, isFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import { isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { WorkspaceScmCommitSelectionToggleButton } from '@/components/projects/scm/WorkspaceScmCommitSelectionToggleButton';
import { activeReviewFileKeyForWorkspace } from '@/components/workspaces/scm/review/activeReviewFile';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceScmReviewBody } from '@/components/projects/scm/WorkspaceScmReviewBody';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { useWorkspaceScmDiffSummaryBinding } from '@/components/projects/scm/useWorkspaceScmDiffSummaryBinding';
import { ScmWalkthroughView } from '@/components/sessions/files/walkthrough/ScmWalkthroughView';
import { useCapturedScmComparison } from '@/components/sessions/files/comparison/useCapturedScmComparison';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { SESSION_DETAILS_SCM_REVIEW_TAB_KEY, type SessionScmReviewComparison, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useScmReviewActiveFileSelection, useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import type { ScmComparison, ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import type { WalkthroughStop } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { captureScmComparisonForSession } from '@/sync/ops/scmDiffSummary/generate';
import { scmComparisonSourceOf } from '@/sync/domains/scm/diffSummary/selection';
import { Modal } from '@/modal';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { presentStartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { WorkspaceCommitsView } from '@/components/projects/scm/WorkspaceCommitsView';
import { ScmComparisonProposeCommits } from '@/components/sessions/files/comparison/ScmComparisonBar';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { readSessionScmReviewTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { openWorkspaceScmAuthoringDraft } from '@/components/projects/scm/workspaceScmAuthoring';
import { useScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useReviewListHunkReview } from '@/components/workspaces/scm/review/hunkReview/useReviewListHunkReview';

/** The same comparison body serves Changes and explicit review Details destinations. */
const WORKSPACE_REVIEW_DETAILS_HEADER = Object.freeze({});
const NO_WORKSPACE_SESSION_ATTRIBUTION: SessionAttributedFile[] = [];

export type WorkspaceScmReviewDetailsViewProps = Readonly<{
    scopeId: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
    comparison?: SessionScmReviewComparison;
    view?: SessionScmReviewView;
    explain?: boolean;
    /** Independently authorized Session evidence; never inferred from Machine/Project access. */
    evidenceSessionId?: string;
    evidenceSessions?: readonly Readonly<{ sessionId: string; label: string; latestTurnId?: string | null }>[];
    onShowInGit?: () => void;
    /** The host's own mode control (the Project page's Review | Git), led into the comparison bar. */
    hostSwitch?: React.ReactNode;
    onSelectTarget?: (target: WorkspaceReviewTarget) => void;
    onAsk?: (input: Readonly<{ comparison: ScmComparison; result: ScmDiffSummaryResult | null; stop: WalkthroughStop; question?: string; isCurrent: () => boolean }>) => void;
    onExplain?: (input: Readonly<{ comparison: ScmComparison; result: ScmDiffSummaryResult | null; isCurrent: () => boolean }>) => void;
}>;

type WorkspaceReviewTarget = Readonly<{ comparison: SessionScmReviewComparison; view: SessionScmReviewView; explain: boolean; evidenceSessionId?: string }>;

/** The branch a working-tree review is on; other comparisons name their own endpoints. */
function pendingComparisonBranch(comparison: Readonly<{ kind: string }>, snapshot: Readonly<{ branch: Readonly<{ head?: string | null; detached?: boolean }> }> | null | undefined): string | null {
    if (comparison.kind !== 'workingTree' || !snapshot || snapshot.branch.detached) return null;
    return snapshot.branch.head?.trim() || null;
}

export const WorkspaceScmReviewDetailsView = React.memo((props: WorkspaceScmReviewDetailsViewProps) => {
    const pane = useAppPaneScope(props.scopeId, scope => scope?.details.tabState[SESSION_DETAILS_SCM_REVIEW_TAB_KEY]);
    const hostKey = JSON.stringify([props.serverId, props.machineId, props.rootPath]);
    const { persistedReviewTabState, setPersistedReviewTabState } = useScmReviewTabState(hostKey,
        { patchDetailsTabState: pane.patchDetailsTabState }, SESSION_DETAILS_SCM_REVIEW_TAB_KEY, pane.scopeState);
    const routeKey = JSON.stringify([props.comparison, props.view, props.explain, props.evidenceSessionId]);
    const target = React.useMemo<WorkspaceReviewTarget>(() => {
        const saved = !props.onSelectTarget && persistedReviewTabState?.workspaceReviewHost === hostKey
            && persistedReviewTabState.workspaceReviewRouteKey === routeKey
            ? readSessionScmReviewTarget(persistedReviewTabState.workspaceReviewTarget) : undefined;
        return { comparison: saved?.comparison ?? props.comparison ?? { kind: 'workingTree' },
            view: saved?.view ?? props.view ?? 'files', explain: saved?.explain ?? props.explain === true,
            evidenceSessionId: saved?.evidenceSessionId ?? props.evidenceSessionId };
    }, [hostKey, routeKey, props.onSelectTarget, props.comparison, props.view, props.explain, props.evidenceSessionId,
        persistedReviewTabState?.workspaceReviewHost, persistedReviewTabState?.workspaceReviewRouteKey, persistedReviewTabState?.workspaceReviewTarget]);
    const selectTarget = React.useCallback((next: WorkspaceReviewTarget) => {
        setPersistedReviewTabState({ workspaceReviewHost: hostKey, workspaceReviewRouteKey: routeKey, workspaceReviewTarget: next });
        props.onSelectTarget?.(next);
    }, [hostKey, routeKey, props.onSelectTarget, setPersistedReviewTabState]);
    const session = useSession(target.evidenceSessionId ?? '', props.serverId);
    const sessionMachine = useSessionMachineTarget(target.evidenceSessionId ?? null, props.serverId);
    const privateEvidence = target.comparison.kind === 'session' || target.comparison.kind === 'turnCheckpoint';
    const admittedChoice = props.evidenceSessions?.some(choice => choice.sessionId === target.evidenceSessionId);
    const evidenceSessionId = (props.evidenceSessions ? admittedChoice : Boolean(session)) && sessionMachine?.machineId === props.machineId
        && normalizeWorkspaceRootPath(sessionMachine.basePath) === normalizeWorkspaceRootPath(props.rootPath) ? target.evidenceSessionId : undefined;
    const boundProps = { ...props, ...target, evidenceSessionId, onSelectTarget: selectTarget };
    return privateEvidence && evidenceSessionId ? <SessionBoundWorkspaceReview {...boundProps} evidenceSessionId={evidenceSessionId} />
        : <MachineBoundWorkspaceReview {...boundProps} />;
});

function MachineBoundWorkspaceReview(props: WorkspaceScmReviewDetailsViewProps) {
    const comparison: SessionScmReviewComparison = props.comparison ?? { kind: 'workingTree' };
    const bound = useWorkspaceScmDiffSummaryBinding({ machineId: props.machineId, rootPath: props.rootPath,
        serverId: props.serverId, comparison, output: 'walkthrough',
        restoreSelections: [{ comparison: comparison.kind === 'workingTree' ? comparison : null, output: 'commitPlan' }] });
    return <WorkspaceReviewBody {...props} bound={bound} host={{ machineId: props.machineId }} />;
}

function SessionBoundWorkspaceReview(props: WorkspaceScmReviewDetailsViewProps & Readonly<{ evidenceSessionId: string }>) {
    const bound = useSessionScmDiffSummaryBinding({ sessionId: props.evidenceSessionId, serverId: props.serverId,
        comparison: props.comparison ?? null, output: 'walkthrough' });
    return <WorkspaceReviewBody {...props} bound={bound} host={{ sessionId: props.evidenceSessionId }} />;
}

const WorkspaceReviewBody = React.memo((props: WorkspaceScmReviewDetailsViewProps & Readonly<{
    bound: ReturnType<typeof useWorkspaceScmDiffSummaryBinding>; host: ScmDiffSummaryHost;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId, scope => ({
        reviewTabState: scope?.details.tabState[SESSION_DETAILS_SCM_REVIEW_TAB_KEY],
        activeFileSelection: scope?.details.tabState[`${SESSION_DETAILS_SCM_REVIEW_TAB_KEY}:activeFile`],
    }));
    const { persistedReviewTabState, setPersistedReviewTabState, mountedInitialReviewState, onScrollTopChange, onCollapsedPathsChange } = useScmReviewTabState(
        JSON.stringify([props.serverId, props.machineId, props.rootPath]), { patchDetailsTabState: pane.patchDetailsTabState },
        SESSION_DETAILS_SCM_REVIEW_TAB_KEY, pane.scopeState.reviewTabState);
    const scmReviewMaxFilesSetting = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLinesSetting = useSetting('scmReviewMaxChangedLines');
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
        if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
        return SCM_COMMIT_STRATEGIES.includes(scmCommitStrategySetting as ScmCommitStrategy)
            ? (scmCommitStrategySetting as ScmCommitStrategy)
            : 'atomic';
    }, [scmCommitStrategySetting]);
    const scope = React.useMemo(() => ({
        serverId: props.serverId,
        machineId: props.machineId,
        rootPath: props.rootPath,
    }), [props.machineId, props.rootPath, props.serverId]);
    const presented = useLayoutPresentationActive();
    const activeReviewFileKey = activeReviewFileKeyForWorkspace(scope);
    const activeReviewFile = React.useMemo(
        () => ({ key: activeReviewFileKey, presented, externalLifecycle: true }),
        [activeReviewFileKey, presented],
    );
    const reviewCommentsEnabled = useFeatureEnabled('files.reviewComments') === true;
    // Review comments open from the Files menu (the bar's ⋯ or the phone menu); while some are unresolved,
    // or the panel is open, the bar also carries them as one action. Their panel opens under the bar.
    const [commentsOpen, setCommentsOpen] = React.useState(false);
    const [commentsCount, setCommentsCount] = React.useState<number | null>(null);
    const commentsLabels = React.useMemo(() => buildReviewCommentsHeaderLabels(), []);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations') === true;
    const toggleComments = React.useCallback(() => setCommentsOpen((open) => !open), []);
    const commentsMenuSection = useReviewCommentsMenuSection({ enabled: reviewCommentsEnabled, labels: commentsLabels,
        unresolvedCount: commentsCount, expanded: commentsOpen, onToggle: toggleComments, testID: 'workspace-review-comments-menu' });
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    // The checkout's machine isn't answering: the review waits with it, in the one shared state, rather than loading without end.
    const reachability = useCheckoutReachability(scope);
    // Keep / Discard on each file's changes in the Uncommitted list (P5); Discard needs the checkout's write capability.
    const hunkReview = useReviewListHunkReview({ scope, discard: scmWriteEnabled && snapshot?.capabilities?.writeDiscard === true,
        refresh });
    const comparison = props.comparison ?? { kind: 'workingTree' };
    const view = props.view ?? 'files';
    const explain = props.explain === true;
    const selectTarget = (patch: Partial<WorkspaceReviewTarget>) => {
        const next = { comparison, view, explain, evidenceSessionId: props.evidenceSessionId, ...patch };
        if ((next.comparison.kind === 'session' || next.comparison.kind === 'turnCheckpoint')
            && (!next.evidenceSessionId || (props.evidenceSessions
                && !props.evidenceSessions.some(choice => choice.sessionId === next.evidenceSessionId)))) return;
        if (patch.comparison && patch.comparison.kind !== 'workingTree' && next.view === 'commits') next.view = 'files';
        props.onSelectTarget?.(next);
    };
    const bound = props.bound;
    useScmReviewActiveFileSelection({ pane: { setDetailsTabState: pane.setDetailsTabState }, persistedSelection: pane.scopeState.activeFileSelection,
        hostKey: JSON.stringify([props.serverId, bound.scope?.accountId, props.machineId, props.rootPath, props.host.sessionId]),
        activeFileKey: activeReviewFileKey, comparison, view, presented: presented && Boolean(bound.scope), isCurrent: bound.isCurrent });
    const readingIdentity = JSON.stringify([bound.capturedComparison?.id, bound.viewModel?.resultId, bound.viewModel?.revision]);
    const currentReadingIdentity = React.useRef(readingIdentity);
    currentReadingIdentity.current = readingIdentity;
    const readingIsCurrent = React.useCallback(() => bound.isCurrent() && currentReadingIdentity.current === readingIdentity,
        [bound.isCurrent, readingIdentity]);
    const { executeValue } = useMountedActionExecution(bound.scope);
    const frontDoorActionExecutor = React.useMemo(() => {
        return ((...args: Parameters<typeof executeValue>) => {
            if (!bound.isCurrent()) return Promise.reject(new Error('action_account_scope_unavailable'));
            return executeValue(...args);
        });
    }, [bound.isCurrent, executeValue]);
    const pluginPermissionGrantActions = React.useMemo(
        () => createPluginPermissionGrantActions({ execute: frontDoorActionExecutor }), [frontDoorActionExecutor]);
    const capture = useCapturedScmComparison({ host: props.host, machine: bound.machine,
        identity: { machineId: props.machineId, basePath: props.rootPath }, serverId: props.serverId, comparison,
        active: comparison.kind !== 'workingTree' || Boolean(comparison.comparisonId), knownComparison: bound.capturedComparison });
    const displayedComparison = view === 'walkthrough' ? bound.capturedComparison
        : comparison.kind !== 'workingTree' || comparison.comparisonId ? capture.comparison : null;
    const displayedResult = displayedComparison?.id === bound.capturedComparison?.id ? bound.viewModel?.savedResult ?? null : null;
    const displayedIdentity = JSON.stringify([displayedComparison?.id, displayedResult?.resultId, displayedResult?.revision]);
    const currentDisplayedIdentity = React.useRef(displayedIdentity);
    currentDisplayedIdentity.current = displayedIdentity;
    const displayedIsCurrent = React.useCallback(() => bound.isCurrent() && currentDisplayedIdentity.current === displayedIdentity,
        [bound.isCurrent, displayedIdentity]);
    const router = useRouter();
    const authoringApproval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([bound.scope?.serverId, bound.scope?.accountId, props.machineId, props.rootPath, displayedIdentity]),
        serverId: props.serverId, onExecuted: () => {},
    });
    const authoringDraft = (basis: Parameters<typeof openWorkspaceScmAuthoringDraft>[0]) => {
        void openWorkspaceScmAuthoringDraft(basis).then((outcome) => {
            if (basis.isCurrent() && outcome.kind === 'approval_request_created') authoringApproval.requestApproval(outcome.artifactId);
            if (basis.isCurrent() && outcome.kind === 'unavailable') Modal.alert(t('common.error'), t('common.unavailable'));
        });
    };
    const onExplain = props.onExplain ?? ((basis: Parameters<NonNullable<WorkspaceScmReviewDetailsViewProps['onExplain']>>[0]) => authoringDraft({ ...basis, scope }));
    const onAsk = props.onAsk ?? ((basis: Parameters<NonNullable<WorkspaceScmReviewDetailsViewProps['onAsk']>>[0]) => authoringDraft({ ...basis, scope }));
    const explainFiles = async () => {
        if (!bound.scope || !bound.machine || !displayedIsCurrent()) return;
        if (displayedComparison) {
            onExplain({ comparison: displayedComparison, result: displayedResult, isCurrent: displayedIsCurrent });
            return;
        }
        // An ordinary draft from live Files needs an actual immutable reading,
        // not a saved walkthrough or a fabricated snapshot comparison.
        try {
            const result = await captureScmComparisonForSession({ ...props.host,
                scope: bound.scope, shouldContinue: displayedIsCurrent,
                input: { cwd: props.rootPath, source: scmComparisonSourceOf(comparison, props.host.sessionId ?? ''),
                    ...(comparison.comparisonId ? { comparisonId: comparison.comparisonId } : {}) } });
            if (!displayedIsCurrent()) return;
            if (result.success) onExplain({ comparison: result.comparison, result: null, isCurrent: displayedIsCurrent });
            else Modal.alert(t('common.error'), t('common.unavailable'));
        } catch {
            if (displayedIsCurrent()) Modal.alert(t('common.error'), t('common.unavailable'));
        }
    };
    const marks = useScmReviewedMarks({ comparison: bound.capturedComparison, serverId: props.serverId, host: props.host });
    const reading = React.useMemo(() => bound.capturedComparison ? buildWalkthroughReading({ comparison: bound.capturedComparison,
        walkthrough: bound.viewModel?.outputs?.walkthrough ?? null, analysis: bound.viewModel?.analysis ?? null,
        reviewed: marks.record, provenance: bound.viewModel?.savedResult?.walkthroughProvenance }) : null,
        [bound.capturedComparison, bound.viewModel?.outputs?.walkthrough, bound.viewModel?.analysis, bound.viewModel?.savedResult?.walkthroughProvenance, marks.record]);
    const chosenEvidence = props.evidenceSessions?.find(choice => choice.sessionId === props.evidenceSessionId);
    const latestTurnId = chosenEvidence?.latestTurnId ?? null;
    const scopeLabel = comparison.kind === 'session' && chosenEvidence ? chosenEvidence.label : resolveFilesComparisonLabel(comparison, latestTurnId);
    // Where these changes live, by name ("on fix-settings-modal"); the checkout path is already the page.
    const scopeBranch = pendingComparisonBranch(comparison, snapshot);
    const scopeDetail = scopeBranch ? t('scmComparison.onBranch', { branch: scopeBranch }) : null;
    const scopeOptions = listFilesComparisonScopeOptions({ showTurnViewToggle: Boolean(latestTurnId), showTurnAgentReportedViewToggle: false,
        showTurnCheckpointViewToggle: false, showSessionViewToggle: Boolean(props.evidenceSessionId) }, latestTurnId, comparison,
        { pendingFileCount: snapshot?.entries.length }).filter((option) =>
            (option.sourceKind !== 'turnCheckpoint' || Boolean(props.evidenceSessionId))
            && (option.sourceKind !== 'session' || (!props.evidenceSessions && Boolean(props.evidenceSessionId))))
        .map(option => option.sourceKind === 'turnCheckpoint' && props.evidenceSessionId ? { ...option, evidenceSessionId: props.evidenceSessionId } : option);
    for (const choice of props.evidenceSessions ?? []) scopeOptions.push({ comparison: { kind: 'session' }, evidenceSessionId: choice.sessionId,
        sourceKind: 'session', group: 'explainOnly', label: choice.label, subtitle: t('scmComparison.scopePicker.sessionDescription'), fileCount: null });
    const pendingComparison = comparison.kind === 'workingTree';
    const reviewDisabled = !bound.scope || !bound.machine || !bound.canControl
        || ((comparison.kind === 'session' || comparison.kind === 'turnCheckpoint') && !props.host.sessionId);
    const commitPlan = useScmWalkthrough(props.host.sessionId ? { sessionId: props.host.sessionId }
        : { machineId: props.machineId, cwd: props.rootPath }, pendingComparison ? comparison : null, 'commitPlan', props.serverId, bound.restoration);
    const startedReviewRunIds = Array.isArray(persistedReviewTabState?.reviewRunIds)
        ? persistedReviewTabState.reviewRunIds.filter((id): id is string => typeof id === 'string') : null;
    const startReview = () => {
        if (!bound.scope || !bound.machine || !bound.isCurrent()) return;
        presentStartReviewDialog({ ...(props.host.sessionId ? { sessionId: props.host.sessionId } : { machineId: props.machineId }),
            serverId: props.serverId, cwd: props.rootPath, comparison, scopeLabel, scopeDetail,
            defaultWalkthrough: Boolean(props.host.sessionId), onStarted: (started, walkthrough) => {
                if (!bound.isCurrent()) return;
                setPersistedReviewTabState({ reviewRunIds: [...started.reviewRunIds] });
                if (walkthrough) selectTarget({ comparison: { ...comparison, comparisonId: started.comparisonId }, view: 'walkthrough' });
                if (started.notStartedEngineIds.length || started.narrationError) Modal.alert(t('common.warning'),
                    started.narrationError ?? started.notStartedEngineIds.join(', '));
            } });
    };
    const commitSelectionPaths = useWorkspaceScmCommitSelectionPaths(scope);
    const commitSelectionPatches = useWorkspaceScmCommitSelectionPatches(scope);
    const workspaceRefs = useWorkspaceRefs();
    const checkoutRef = React.useMemo(() => findWorkspaceRefByScope(workspaceRefs, scope), [workspaceRefs, scope]);
    const directWriteGrantScope = React.useMemo<PluginPermissionGrantTargetScope | null>(() => checkoutRef ? ({
        kind: 'project', projectId: checkoutRef.id,
    }) : null, [checkoutRef?.id]);
    const pluginPermissionGrantListInput = React.useMemo<PluginPermissionGrantListInput | null>(() => directWriteGrantScope ? ({
        capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
        targetScope: directWriteGrantScope,
    }) : null, [directWriteGrantScope]);
    const pluginPermissionGrants = usePluginPermissionGrants({
        scope: bound.scope,
        actions: pluginPermissionGrantActions,
        enabled: reviewCommentsEnabled && Boolean(pluginPermissionGrantListInput) && Boolean(bound.scope),
        listInput: pluginPermissionGrantListInput,
    });
    const directWriteGrants = pluginPermissionGrants.state.grantIds
        .map((id) => pluginPermissionGrants.state.grantsById[id])
        .filter((grant): grant is NonNullable<typeof grant> => (
            Boolean(grant)
            && grant?.capability === REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY
            && pluginPermissionGrantScopeKey(grant.targetScope) === pluginPermissionGrantScopeKey(directWriteGrantScope)
        ));
    const pendingDirectWriteGrantRequests = directWriteGrantScope ? selectPluginPermissionPendingRequests(pluginPermissionGrants.state, {
        capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
        targetScope: directWriteGrantScope,
    }) : [];

    const maxFiles = React.useMemo(() => {
        const raw = typeof scmReviewMaxFilesSetting === 'number' && Number.isFinite(scmReviewMaxFilesSetting)
            ? scmReviewMaxFilesSetting
            : 25;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxFilesSetting]);
    const maxChangedLines = React.useMemo(() => {
        const raw = typeof scmReviewMaxChangedLinesSetting === 'number' && Number.isFinite(scmReviewMaxChangedLinesSetting)
            ? scmReviewMaxChangedLinesSetting
            : 2000;
        return Math.max(1, Math.floor(raw));
    }, [scmReviewMaxChangedLinesSetting]);
    const changedFiles = React.useMemo(() => buildWorkspaceChangedFilesData({ scmSnapshot: snapshot }), [snapshot]);
    const fetchUnifiedDiffForPath = React.useCallback<ScmReviewUnifiedDiffFetcher>(async (input) => {
        return await fetchWorkspaceUnifiedDiffForPath({
            scope,
            ...input,
        });
    }, [scope]);
    const atomicSelectionPathSet = React.useMemo(() => new Set(buildCommitSelectionPathHints({
        commitSelectionPaths,
        commitSelectionPatches,
    })), [commitSelectionPatches, commitSelectionPaths]);
    const renderReviewFileActions = React.useMemo(() => {
        if (!scmWriteEnabled) return undefined;
        return (file: ScmFileStatus) => {
            if (isDirectoryLikeScmFileStatus(file)) return null;
            const selectedForCommit = isFileSelectedForCommit({
                commitStrategy: scmCommitStrategy,
                file,
                atomicSelectionPaths: atomicSelectionPathSet,
            });
            const capability = selectedForCommit
                ? snapshot?.capabilities?.writeExclude
                : snapshot?.capabilities?.writeInclude;
            const actionSupported = scmCommitStrategy === 'atomic'
                ? snapshot?.capabilities?.writeCommit === true
                : capability === true;
            if (!actionSupported) return null;
            return (
                <WorkspaceScmCommitSelectionToggleButton
                    scope={scope}
                    snapshot={snapshot ?? null}
                    scmWriteEnabled={scmWriteEnabled}
                    commitStrategy={scmCommitStrategy}
                    file={file}
                    selectedForCommit={selectedForCommit}
                    onAfterToggle={refresh}
                />
            );
        };
    }, [
        atomicSelectionPathSet,
        refresh,
        scmCommitStrategy,
        scmWriteEnabled,
        scope,
        snapshot,
    ]);

    // The comments the Files bar's toggle opens: drawn by Review under that bar, above the files.
    const reviewCommentsPanel = reviewCommentsEnabled ? (
        <ReviewCommentsSessionSurface
            scope={bound.scope ?? undefined}
            workspaceId={checkoutRef?.id}
            workspace={{ machineId: props.machineId, path: props.rootPath }}
            execute={frontDoorActionExecutor}
            directWriteGrants={directWriteGrants}
            pendingDirectWriteGrantRequests={pendingDirectWriteGrantRequests}
            onGrantDirectWrite={pluginPermissionGrants.grant}
            onCancelDirectWriteGrant={pluginPermissionGrants.dismissRequest}
            onRevokeDirectWrite={pluginPermissionGrants.revoke}
            permissionGrantStatus={pluginPermissionGrants.state.status}
            permissionGrantError={pluginPermissionGrants.state.error}
            onRefreshPermissionGrants={() => { void pluginPermissionGrants.refresh(); }}
            header="external"
            open={view === 'files' && commentsOpen}
            onUnresolvedCountChange={setCommentsCount}
            testID="workspace-review-comments"
                />
    ) : null;

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}>
            {authoringApproval.approvalId ? <ActionApprovalPendingNotice message={t('approvals.status.open')} summary={authoringApproval.approvalSummary}
                testID="workspace-review-authoring-approval" onOpenApproval={() => router.push(
                    buildApprovalHref(authoringApproval.approvalId!, props.serverId),
                )} /> : null}
            {snapshot ? <SourceControlStaleSnapshotNotice error={error} onRetry={() => { void refresh(); }} testID="workspace-review-stale" /> : null}
            <InputTypePickerHostProvider enabled={presented} requiresPluginTypes={false} machineId={props.machineId} serverId={props.serverId}
                contextKey={JSON.stringify([props.serverId, props.machineId, props.rootPath])}>
            <WorkspaceScmReviewBody activeReviewFile={activeReviewFile} comparison={comparison} view={view} scopeLabel={scopeLabel} scopeDetail={scopeDetail}
                hostSwitch={props.hostSwitch}
                barMenuSection={commentsMenuSection}
                barPanel={reviewCommentsPanel}
                barActions={reviewCommentsEnabled && (commentsOpen || (commentsCount ?? 0) > 0) ? <ReviewCommentsHeaderButton compact labels={commentsLabels} unresolvedCount={commentsCount}
                    expanded={commentsOpen} onPress={toggleComments} testID="workspace-review-comments-trigger" /> : null}
                views={pendingComparison ? ['files', 'walkthrough', 'commits'] : ['files', 'walkthrough']}
                commitsCount={commitPlan?.outputs?.commitPlan?.value?.groups.length ?? null}
                onStartReview={startReview} reviewDisabled={reviewDisabled}
                reviewDisabledReason={reviewDisabled ? t('common.unavailable') : null}
                onProposeCommits={pendingComparison ? () => selectTarget({ view: 'commits' }) : undefined}
                proposeCommits={pendingComparison && view !== 'commits' && !commitPlan?.outputs?.commitPlan ? <ScmComparisonProposeCommits onPress={() => selectTarget({ view: 'commits' })} /> : undefined}
                renderCommits={({ layout, renderBar }) => <WorkspaceCommitsView scope={scope}
                    {...bound.restoration}
                    comparison={comparison} branch={snapshot?.branch.detached ? null : snapshot?.branch.head ?? null} layout={layout === 'phone' ? 'phone' : 'wide'}
                    active={presented} renderBar={() => renderBar()} onShowInGit={props.onShowInGit} />}
                filesState={comparison.kind === 'workingTree' && !comparison.comparisonId
                    ? loading && !snapshot ? (reachability.unreachable ? <CheckoutUnreachableState reachability={reachability} testID="scm-review-unreachable" /> : <PaneLoadingFallback />)
                        : error && !snapshot ? <SourceControlUnavailableState details={error.message} errorCode={error.errorCode} onRetry={() => { void refresh(); }} />
                            : snapshot?.repo.isRepo === false ? <NotSourceControlRepositoryState /> : null
                    : !capture.comparison ? capture.loading ? <PaneLoadingFallback />
                        : <SourceControlUnavailableState details={capture.error ?? t('scmComparison.unsupportedReason')} onRetry={capture.retry} /> : null}
                scopeOptions={scopeOptions} evidenceSessionId={props.evidenceSessionId}
                onSelectComparison={(next, evidenceSessionId) => selectTarget({ comparison: next,
                    ...(evidenceSessionId ? { evidenceSessionId } : {}) })}
                onSelectView={(next) => selectTarget({ view: next })} rootPath={props.rootPath}
                fileCount={capture.page?.totalFiles ?? capture.comparison?.inventory.files.length ?? (snapshot ? changedFiles.allRepositoryChangedFiles.length : null)}
                reading={reading} marksAvailable={marks.unavailableReason === null && marks.record !== null}
                modelLabel={bound.viewModel?.producer?.modelId} explain={explain} onExplainChange={(next) => selectTarget({ explain: next })}
                onExplainDraft={bound.scope && bound.machine && comparison.kind !== 'session' && comparison.kind !== 'turnCheckpoint'
                    ? () => { void explainFiles(); } : undefined}
                renderWalkthrough={({ layout, renderBar, onShowFiles }) => <View testID="workspace-walkthrough" style={{ flex: 1, minHeight: 0 }}>
                    <ScmWalkthroughView bound={bound} displayMachineId={props.machineId} serverId={props.serverId}
                        sessionId={props.host.sessionId} startedReviewRunIds={props.host.sessionId ? startedReviewRunIds : null}
                        comparison={comparison} scopeLabel={scopeLabel} scopeDetail={scopeDetail} layout={layout}
                        renderBar={renderBar} onShowFiles={onShowFiles} onOpenFile={(path) => props.onOpenFile?.(path)}
                        onAskStop={bound.capturedComparison ? (stop, question) => {
                            if (!readingIsCurrent() || !bound.capturedComparison) return;
                            onAsk({ comparison: bound.capturedComparison, result: bound.viewModel?.savedResult ?? null, stop,
                                ...(question ? { question } : {}), isCurrent: readingIsCurrent });
                        } : undefined} />
                </View>}
                renderFiles={(comparisonChrome) => comparison.kind !== 'workingTree' || comparison.comparisonId
                    ? capture.comparison ? <CapturedComparisonFilesView activeReviewFile={activeReviewFile} comparison={capture.comparison} reviewScopeKey={activeReviewFileKey}
                        workspaceScope={scope} discardEnabled={scmWriteEnabled && snapshot?.capabilities?.writeDiscard === true}
                        sessionId={props.evidenceSessionId ?? props.host.sessionId ?? undefined}
                        marks={bound.capturedComparison?.id === capture.comparison.id ? marks : undefined} onRefresh={capture.retry}
                        error={capture.error}
                        host={props.host} serverId={props.serverId} page={capture.page} onLoadMore={capture.loadMore} loadingMore={capture.loading}
                        comparisonChrome={comparisonChrome} maxFiles={maxFiles} maxChangedLines={maxChangedLines}
                        initialScrollTop={mountedInitialReviewState.scrollTop} onScrollTopChange={onScrollTopChange}
                        initialCollapsedPaths={mountedInitialReviewState.collapsedPaths} onCollapsedPathsChange={onCollapsedPathsChange} />
                        : capture.loading ? <PaneLoadingFallback /> : <SourceControlUnavailableState details={capture.error ?? t('scmComparison.unsupportedReason')}
                            onRetry={capture.retry} />
                    : <ChangedFilesReview
                activeReviewFile={activeReviewFile}
                detailsHeader={WORKSPACE_REVIEW_DETAILS_HEADER}
                theme={theme}
                reviewScopeKey={activeReviewFileKey}
                snapshot={snapshot ?? null}
                changedFilesViewMode="repository"

                allRepositoryChangedFiles={changedFiles.allRepositoryChangedFiles}
                sessionAttributedFiles={NO_WORKSPACE_SESSION_ATTRIBUTION}
                repositoryOnlyFiles={changedFiles.allRepositoryChangedFiles}

                maxFiles={maxFiles}
                maxChangedLines={maxChangedLines}
                onFilePress={(file) => props.onOpenFile?.(file.fullPath)}
                onFilePressPinned={(file) => props.onOpenFilePinned?.(file.fullPath)}
                renderFileActions={renderReviewFileActions}
                rowDensity="compact"
                reviewCommentsEnabled={reviewCommentsEnabled}
                reviewCommentDrafts={reviewCommentDrafts}
                onUpsertReviewCommentDraft={reviewDraftHandlers.onUpsertReviewCommentDraft}
                onDeleteReviewCommentDraft={reviewDraftHandlers.onDeleteReviewCommentDraft}
                onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
                workspaceScope={scope}
                hunkReview={hunkReview}
                fetchUnifiedDiffForPath={fetchUnifiedDiffForPath}
                comparisonChrome={comparisonChrome}
                initialScrollTop={mountedInitialReviewState.scrollTop} onScrollTopChange={onScrollTopChange}
                initialCollapsedPaths={mountedInitialReviewState.collapsedPaths} onCollapsedPathsChange={onCollapsedPathsChange}
            />} />
            </InputTypePickerHostProvider>
        </View>
    );
});
