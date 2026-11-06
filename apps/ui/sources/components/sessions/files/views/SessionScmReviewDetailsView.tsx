import * as React from 'react';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
  REVIEW_TRAY_RESERVED_PX,
  ReviewDraftSummary,
} from '@/components/sessions/reviews/comments/ReviewDraftSummary';
import { activeReviewFileKeyForSession } from '@/components/workspaces/scm/review/activeReviewFile';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { useReviewAskComposer } from '@/components/sessions/reviews/comments/useReviewAskComposer';
import { ReviewCommentsSessionSurface } from '@/components/reviews/ReviewCommentsSessionSurface';
import { ReviewCommentsHeaderButton, useReviewCommentsMenuSection } from '@/components/reviews/ReviewCommentsHeaderButton';
import { buildReviewCommentsHeaderLabels } from '@/components/reviews/sessionSurfaceLabels';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import {
  WorkspaceScmReviewBody,
  type ScmReviewComparisonChrome,
} from '@/components/projects/scm/WorkspaceScmReviewBody';
import { SessionWalkthroughView } from '@/components/sessions/files/walkthrough/SessionWalkthroughView';
import { SessionCommitsView } from '@/components/sessions/files/commits/SessionCommitsView';
import { scmReviewViewUnavailableReason } from '@/sync/domains/scm/diffSummary/selection';
import { useScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useScmWalkthroughStates } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import {
  describeChangedFilesModeAsComparison,
  listFilesComparisonScopeOptions,
  resolveFilesComparisonLabel,
  resolveFilesComparisonPresentation,
  scmComparisonKey,
} from '@/components/sessions/files/comparison/filesComparison';
import {
  createSessionScmReviewDetailsTab,
  type SessionScmReviewComparison,
  type SessionScmReviewTarget,
  type SessionScmReviewView,
  SESSION_SCM_REVIEW_VIEWS,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createExecutionRunLauncherDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { presentStartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { ScmComparisonProposeCommits } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import {
  useWorkspaceRefs,
  useProjectForSession,
  useSession,
  useSessionMessages,
  useSessionProjectScmCommitSelectionPatches,
  useSessionProjectScmCommitSelectionPaths,
  useSessionProjectScmSnapshot,
  useSessionProjectScmSnapshotError,
  useWorkspaceScmTouchedPathsForSession,
  useSessionRealtimeScmTranscriptConsumer,
  useSessionWorkspacePath,
  useSetting,
  useWorkspaceReviewCommentsDrafts,
} from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ScmChangeDiscardButton } from '@/components/sessions/sourceControl/changes/ScmChangeDiscardButton';
import {
  SCM_COMMIT_STRATEGIES,
  type ScmCommitStrategy,
} from '@/scm/settings/commitStrategy';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { useScmDiffCacheLimits } from '@/scm/diffCache/useScmDiffCacheLimits';
import { useScmSessionAutoRefresh } from '@/scm/refresh/useScmSessionAutoRefresh';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import {
  NotSourceControlRepositoryState,
  SourceControlStaleSnapshotNotice,
  SourceControlUnavailableState,
} from '@/components/workspaces/scm/states';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveExecutionRunAgentMarkId } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { resolveRunNativeModelLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useLastNonNullValue } from '@/hooks/ui/useLastNonNullValue';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import {
  normalizeSessionAddress,
  sessionAddressKey,
} from '@/sync/domains/session/sessionAddress';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { selectPluginPermissionPendingRequests } from '@/sync/domains/plugins/permissions/store';
import {
  REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
  pluginPermissionGrantScopeKey,
  type PluginPermissionGrantListInput,
  type PluginPermissionGrantTargetScope,
} from '@/sync/domains/plugins/permissions/types';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { ScmCommitSelectionToggleButton } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import {
  buildCommitSelectionPathHints,
  isFileSelectedForCommit,
} from '@/scm/operations/commitSelectionHints';
import { isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { SessionCapturedScmReviewDetailsView } from './SessionCapturedScmReviewDetailsView';
import { useScmReviewActiveFileSelection, useSessionScmReviewTabState, useSessionScmReviewComparison } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';

export type SessionScmReviewDetailsViewProps = Readonly<{
  sessionId: string;
  serverId?: string | null;
  scopeId: string;
  active?: boolean;
  /** The containing Details surface owns fullscreen Back and pane closing. */
  onRequestClose?: () => void;
  /** The containing Details destination owns navigation for hosted and pane presentations. */
  onOpenDetailsTab?: ReturnType<typeof useAppPaneScope>['openDetailsTab'];
  /** The comparison and view this destination shows (from its tab or link); absent keeps the default. */
  target?: SessionScmReviewTarget;
}>;

/** Files and Walkthrough over any comparison; Commits only over pending changes (lab WT4: explain-and-commit). */
const COMPARISON_VIEWS = SESSION_SCM_REVIEW_VIEWS.filter(
  (view) => scmReviewViewUnavailableReason(view, null) === null,
);
const PENDING_COMPARISON_VIEWS = SESSION_SCM_REVIEW_VIEWS;
const PENDING_COMPARISON = { kind: 'workingTree' } as const;

export const SessionScmReviewDetailsView = React.memo(
  (props: SessionScmReviewDetailsViewProps) => {
    const comparison = useSessionScmReviewComparison(props.sessionId, props.serverId, props.target?.comparison, props.active !== false);
    const target = React.useMemo(() => comparison && !props.target?.comparison
      ? { ...props.target, comparison } : props.target, [comparison, props.target]);
    if (
      comparison &&
      resolveFilesComparisonPresentation(comparison, {
        showTurnViewToggle: false,
        showTurnAgentReportedViewToggle: false,
        showTurnCheckpointViewToggle: false,
        showSessionViewToggle: false,
      }).kind === 'captured'
    )
      return (
        <SessionCapturedScmReviewDetailsView
          {...props}
          target={target}
          comparison={comparison}
        />
      );
    return <SessionWorkingScmReviewDetailsView {...props} target={target} />;
  },
);

const SessionWorkingScmReviewDetailsView = React.memo(
  (props: SessionScmReviewDetailsViewProps) => {
    const { machineReachable } = useSessionMachineReachability(
      props.sessionId,
      props.serverId,
    );
    const reviewDisabledReason = machineReachable
      ? null
      : t('walkthrough.notice.offlineA11y');
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const openDetailsTab = props.onOpenDetailsTab ?? pane.openDetailsTab;
    const goToComposer = useReviewComposerHandoff(props.scopeId);
    const {
      persistedReviewTabState,
      startedReviewRunIds,
      mountedInitialReviewState,
      setPersistedReviewTabState,
      onCollapsedPathsChange,
      onScrollTopChange,
      explain,
      setExplain,
    } = useSessionScmReviewTabState(props.sessionId, pane, props.target, openDetailsTab);
    const sessionAddress = React.useMemo(
      () => normalizeSessionAddress(props.serverId, props.sessionId),
      [props.serverId, props.sessionId],
    );
    // Every working-tree read and commit target below is qualified by the Home this screen was
    // opened for. Reading by bare id resolves through same-id discovery, which cannot separate two
    // Homes hosting one Session id and would review — and commit — the wrong working tree.
    const project = useProjectForSession(props.sessionId, props.serverId);
    const sessionPath = useSessionWorkspacePath(
      props.sessionId,
      props.serverId,
    );
    const snapshot = useSessionProjectScmSnapshot(
      props.sessionId,
      props.serverId,
    );
    const lastGoodSnapshot = useLastNonNullValue(snapshot, {
      resetKey: sessionAddress
        ? sessionAddressKey(sessionAddress)
        : props.sessionId,
    });
    const effectiveSnapshot = snapshot ?? lastGoodSnapshot;
    useSessionRealtimeScmTranscriptConsumer(
      { serverId: props.serverId ?? null, sessionId: props.sessionId },
      effectiveSnapshot,
    );
    const snapshotError = useSessionProjectScmSnapshotError(
      props.sessionId,
      props.serverId,
    );
    const touchedPaths = useWorkspaceScmTouchedPathsForSession(
      props.sessionId,
      props.serverId,
    );
    const commitSelectionPaths = useSessionProjectScmCommitSelectionPaths(
      props.sessionId,
      props.serverId,
    );
    const commitSelectionPatches = useSessionProjectScmCommitSelectionPatches(
      props.sessionId,
      props.serverId,
    );
    const scmReviewMaxFiles = useSetting('scmReviewMaxFiles');
    const scmReviewMaxChangedLines = useSetting('scmReviewMaxChangedLines');
    const scmCommitStrategySetting = useSetting('scmCommitStrategy');
    const scmCommitStrategy: ScmCommitStrategy = React.useMemo(() => {
      if (typeof scmCommitStrategySetting !== 'string') return 'atomic';
      return SCM_COMMIT_STRATEGIES.includes(
        scmCommitStrategySetting as ScmCommitStrategy,
      )
        ? (scmCommitStrategySetting as ScmCommitStrategy)
        : 'atomic';
    }, [scmCommitStrategySetting]);
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const reviewScope = useWorkspaceScopeForSession(
      props.sessionId,
      props.serverId,
    );
    const workspaceRefs = useWorkspaceRefs();
    const reviewWorkspaceRef = React.useMemo(
      () =>
        reviewScope
          ? findWorkspaceRefByScope(workspaceRefs, reviewScope)
          : null,
      [workspaceRefs, reviewScope],
    );
    const reviewCommentsEnabled =
      useFeatureEnabled('files.reviewComments') === true &&
      Boolean(reviewScope);
    // Review comments open from the Files menu (the bar's ⋯ or the phone menu); while some are unresolved,
    // or the panel is open, the bar also carries them as one action. Their panel opens under the bar.
    const [commentsOpen, setCommentsOpen] = React.useState(false);
    const [commentsCount, setCommentsCount] = React.useState<number | null>(null);
    const commentsLabels = React.useMemo(() => buildReviewCommentsHeaderLabels(), []);
    const toggleComments = React.useCallback(() => setCommentsOpen((open) => !open), []);
    const commentsMenuSection = useReviewCommentsMenuSection({ enabled: reviewCommentsEnabled, labels: commentsLabels,
        unresolvedCount: commentsCount, expanded: commentsOpen, onToggle: toggleComments, testID: 'review-comments-session-menu' });
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(reviewScope);
    const reviewDraftHandlers =
      useWorkspaceReviewCommentDraftHandlers(reviewScope);
    const reviewServerId = usePreferredServerIdForSession({
      serverId: props.serverId ?? null,
      sessionId: props.sessionId,
    });
    const accountBindings = useServerCredentialAccountScopeBindings([
      reviewServerId,
    ]);
    const accountScope = [...accountBindings.values()][0]?.scope;
    const { executeValue: frontDoorActionExecutor } = useMountedActionExecution(accountScope);
    const pluginPermissionGrantActions = React.useMemo(
      () =>
        createPluginPermissionGrantActions({
          execute: frontDoorActionExecutor,
        }),
      [frontDoorActionExecutor],
    );
    const directWriteGrantScope =
      React.useMemo<PluginPermissionGrantTargetScope | null>(() => {
        if (!reviewWorkspaceRef) return null;
        return {
          kind: 'project',
          projectId: reviewWorkspaceRef.id,
        };
      }, [reviewWorkspaceRef?.id]);
    const pluginPermissionGrantListInput =
      React.useMemo<PluginPermissionGrantListInput | null>(
        () =>
          directWriteGrantScope
            ? {
                capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
                targetScope: directWriteGrantScope,
              }
            : null,
        [directWriteGrantScope],
      );
    const pluginPermissionGrants = usePluginPermissionGrants({
      scope: accountScope ?? null,
      actions: pluginPermissionGrantActions,
      enabled: reviewCommentsEnabled && Boolean(pluginPermissionGrantListInput),
      listInput: pluginPermissionGrantListInput,
    });
    const directWriteGrants = pluginPermissionGrants.state.grantIds
      .map((id) => pluginPermissionGrants.state.grantsById[id])
      .filter(
        (grant): grant is NonNullable<typeof grant> =>
          Boolean(grant) &&
          grant?.capability ===
            REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY &&
          pluginPermissionGrantScopeKey(grant.targetScope) ===
            pluginPermissionGrantScopeKey(directWriteGrantScope),
      );
    const pendingDirectWriteGrantRequests = directWriteGrantScope
      ? selectPluginPermissionPendingRequests(pluginPermissionGrants.state, {
          capability: REVIEW_COMMENTS_DIRECT_WRITE_PERMISSION_CAPABILITY,
          targetScope: directWriteGrantScope,
        })
      : [];
    const [diffRefreshToken, setDiffRefreshToken] = React.useState(0);

    useScmDiffCacheLimits(scmDiffCache);

    const autoRefreshIntervalSetting = useSetting(
      'scmFilesAutoRefreshIntervalMs',
    );
    const maxIntervalMs = React.useMemo(() => {
      const raw =
        typeof autoRefreshIntervalSetting === 'number' &&
        Number.isFinite(autoRefreshIntervalSetting)
          ? autoRefreshIntervalSetting
          : 60_000;
      return Math.max(0, raw);
    }, [autoRefreshIntervalSetting]);
    const baseIntervalMs = React.useMemo(
      () => Math.max(0, Math.min(10_000, maxIntervalMs)),
      [maxIntervalMs],
    );

    const {
      latestTurnId,
      latestTurnChangeSet,
      latestTurnScopedChangeSet,
      latestTurnDiffByPath,
      latestTurnAgentReportedDiffByPath,
      latestTurnCheckpointDiffByPath,
      sessionChangeSet,
      providerDiffByPath,
      sessionLatestTurnId,
      turnChangeSets,
    } = useDerivedSessionChangeSet(
      sessionAddress,
      effectiveSnapshot?.repo.rootPath,
      {
        presentedTurnId:
          props.target?.comparison?.kind === 'turnCheckpoint'
            ? (props.target.comparison.turnId ?? null)
            : null,
      },
    );

    useScmSessionAutoRefresh({
      sessionId: props.sessionId,
      serverId: props.serverId,
      enabled:
        props.active !== false &&
        Boolean(props.sessionId),
      intervalMs: baseIntervalMs,
      stepIntervalMs: baseIntervalMs,
      maxIntervalMs,
    });

    const scrollFades = useScrollEdgeFades({
      enabledEdges: { top: true, bottom: true },
      overflowThreshold: 1,
      edgeThreshold: 1,
    });

    const changed = useChangedFilesData({
      sessionId: props.sessionId,
      scmSnapshot: effectiveSnapshot ?? null,
      workspaceTouchedPaths: touchedPaths,
      searchQuery: '',
      showAllRepositoryFiles: true,
      latestTurnId,
      latestTurnChangeSet: latestTurnScopedChangeSet,
      latestTurnEvidence: latestTurnChangeSet,
      sessionChangeSet,
    });

    const changedFilesAvailability = React.useMemo(
      () => ({
        showTurnViewToggle: changed.showTurnViewToggle,
        showTurnAgentReportedViewToggle:
          changed.showTurnAgentReportedViewToggle,
        showTurnCheckpointViewToggle: changed.showTurnCheckpointViewToggle,
        showSessionViewToggle: changed.showSessionViewToggle,
      }),
      [
        changed.showSessionViewToggle,
        changed.showTurnAgentReportedViewToggle,
        changed.showTurnCheckpointViewToggle,
        changed.showTurnViewToggle,
      ],
    );

    // The comparison is the one decision (the tab's link or the scope picker); the data mode follows it.
    // The tab resource is re-read each render; its comparison is reused while its identity is unchanged.
    const requestedComparisonKey = props.target?.comparison
      ? scmComparisonKey(props.target.comparison)
      : null;
    const requestedComparisonRef =
      React.useRef<SessionScmReviewComparison | null>(null);
    if (
      (requestedComparisonRef.current
        ? scmComparisonKey(requestedComparisonRef.current)
        : null) !== requestedComparisonKey
    ) {
      requestedComparisonRef.current = props.target?.comparison ?? null;
    }
    const requestedComparison = requestedComparisonRef.current;
    const comparisonPresentation = React.useMemo(
      () =>
        resolveFilesComparisonPresentation(
          requestedComparison,
          changedFilesAvailability,
        ),
      [changedFilesAvailability, requestedComparison],
    );
    const changedFilesViewMode =
      comparisonPresentation.kind === 'changedFiles'
        ? comparisonPresentation.mode
        : 'repository';
    const pickerLatestTurnId =
      requestedComparison?.kind === 'turnCheckpoint'
        ? sessionLatestTurnId
        : (latestTurnChangeSet?.turnId ?? latestTurnId ?? null);
    const shownComparison = React.useMemo(
      () =>
        requestedComparison ??
        describeChangedFilesModeAsComparison(
          changedFilesViewMode,
          latestTurnId ?? null,
        ),
      [changedFilesViewMode, latestTurnId, requestedComparison],
    );

    const reviewProviderDiffByPath = React.useMemo(() => {
      if (changedFilesViewMode === 'turn') return latestTurnDiffByPath;
      if (changedFilesViewMode === 'turn_agent_reported')
        return latestTurnAgentReportedDiffByPath;
      if (changedFilesViewMode === 'turn_checkpoint')
        return latestTurnCheckpointDiffByPath;
      if (changedFilesViewMode === 'session') return providerDiffByPath;
      return null;
    }, [
      changedFilesViewMode,
      latestTurnAgentReportedDiffByPath,
      latestTurnCheckpointDiffByPath,
      latestTurnDiffByPath,
      providerDiffByPath,
    ]);

    const maxFiles =
      typeof scmReviewMaxFiles === 'number' &&
      Number.isFinite(scmReviewMaxFiles)
        ? scmReviewMaxFiles
        : 25;
    const maxChangedLines =
      typeof scmReviewMaxChangedLines === 'number' &&
      Number.isFinite(scmReviewMaxChangedLines)
        ? scmReviewMaxChangedLines
        : 2000;

    const openFile = React.useCallback(
      (fullPath: string, intent: 'default' | 'pinned' = 'default') => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
          openDetailsTab(
            {
              key: `file:${fullPath}`,
              kind: 'file',
              title: fileName,
              resource: { kind: 'file', path: fullPath },
            },
            { intent },
          );
        });
      },
      [openDetailsTab],
    );

    const openFileDefault = React.useCallback(
      (file: { fullPath: string }) => {
        openFile(file.fullPath, 'default');
      },
      [openFile],
    );

    const openFilePinned = React.useCallback(
      (file: { fullPath: string }) => {
        openFile(file.fullPath, 'pinned');
      },
      [openFile],
    );

    const refreshAfterMutation = React.useCallback(async () => {
      await scmStatusSync.invalidateFromMutationAndAwait(
        props.sessionId,
        props.serverId,
      );
      setDiffRefreshToken((t) => t + 1);
    }, [props.serverId, props.sessionId]);

    const atomicSelectionPathSet = React.useMemo(
      () =>
        new Set(
          buildCommitSelectionPathHints({
            commitSelectionPaths,
            commitSelectionPatches,
          }),
        ),
      [commitSelectionPatches, commitSelectionPaths],
    );

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
          ? effectiveSnapshot?.capabilities?.writeExclude
          : effectiveSnapshot?.capabilities?.writeInclude;
        const actionSupported =
          scmCommitStrategy === 'atomic'
            ? effectiveSnapshot?.capabilities?.writeCommit === true
            : capability === true;
        if (!actionSupported) return null;
        return (
          <ScmCommitSelectionToggleButton
            sessionId={props.sessionId}
            serverId={props.serverId ?? undefined}
            sessionPath={sessionPath}
            snapshot={effectiveSnapshot ?? null}
            scmWriteEnabled={scmWriteEnabled}
            commitStrategy={scmCommitStrategy}
            file={file}
            selectedForCommit={selectedForCommit}
            surface="files"
          />
        );
      };
    }, [
      atomicSelectionPathSet,
      effectiveSnapshot,
      props.serverId,
      props.sessionId,
      scmCommitStrategy,
      scmWriteEnabled,
      sessionPath,
    ]);

    const renderReviewFileTrailingActions = React.useMemo(() => {
      if (!scmWriteEnabled) return undefined;
      return (file: ScmFileStatus) => (
        <ScmChangeDiscardButton
          sessionId={props.sessionId}
          serverId={props.serverId ?? undefined}
          sessionPath={sessionPath}
          snapshot={effectiveSnapshot ?? null}
          scmWriteEnabled={scmWriteEnabled}
          commitStrategy={scmCommitStrategy}
          file={file}
          surface="files"
          onAfterDiscard={refreshAfterMutation}
        />
      );
    }, [
      effectiveSnapshot,
      props.serverId,
      props.sessionId,
      refreshAfterMutation,
      scmCommitStrategy,
      scmWriteEnabled,
      sessionPath,
    ]);

    const isFileSelectedForNextCommit = React.useCallback(
      (file: ScmFileStatus) =>
        isFileSelectedForCommit({
          commitStrategy: scmCommitStrategy,
          file,
          atomicSelectionPaths: atomicSelectionPathSet,
        }),
      [atomicSelectionPathSet, scmCommitStrategy],
    );
    const reviewDetailsHeader = React.useMemo(
      () => ({
        isSelectedForCommit: scmWriteEnabled
          ? isFileSelectedForNextCommit
          : null,
      }),
      [isFileSelectedForNextCommit, scmWriteEnabled],
    );
    const reviewTrayVisible =
      reviewCommentsEnabled && reviewCommentDrafts.length > 0;
    const askComposer = useReviewAskComposer({
      sessionId: props.sessionId,
      serverId: props.serverId,
      drafts: reviewCommentDrafts,
      reviewScope,
      deleteDraft: reviewDraftHandlers.onDeleteReviewCommentDraft,
      handOffToComposer: goToComposer,
    });
    // Review and the Git changed-files list share one active file for this Session.
    const activeReviewFileKey = activeReviewFileKeyForSession(
      props.sessionId,
      props.serverId,
    );
    const activeReviewFile = React.useMemo(
      () => ({
        key: activeReviewFileKey,
        presented: props.active !== false,
        externalLifecycle: true,
      }),
      [activeReviewFileKey, props.active],
    );
    const onUpsertReviewCommentDraft =
      reviewDraftHandlers.onUpsertReviewCommentDraft;
    const detachDraftFromNextMessage = React.useCallback(
      (draft: (typeof reviewCommentDrafts)[number]) => {
        onUpsertReviewCommentDraft({ ...draft, includeInPrompt: false });
      },
      [onUpsertReviewCommentDraft],
    );

    // Choosing another scope updates this destination in place (same tab key), so it keeps its place.
    const requestedView = props.target?.view ?? 'files';
    const selectComparison = React.useCallback(
      (comparison: SessionScmReviewComparison) => {
        // Commits exists only over pending changes; another scope keeps the reading view instead.
        const view =
          scmReviewViewUnavailableReason(requestedView, comparison)
            ? 'files'
            : requestedView;
        openDetailsTab(
          createSessionScmReviewDetailsTab({
            ...props.target,
            comparison,
            view,
          }),
          { intent: 'pinned' },
        );
      },
      [openDetailsTab, props.target, requestedView],
    );
    const pending = shownComparison?.kind === 'workingTree';
    // Both views project the same captured inventory, including before checkout status hydrates.
    const { viewModels: [walkthroughAnalysis, commitPlan], restoration } = useScmWalkthroughStates(
      { sessionId: props.sessionId },
      [
        { comparison: shownComparison, output: 'walkthrough' },
        { comparison: pending && props.active !== false ? PENDING_COMPARISON : null, output: 'commitPlan' },
      ], props.serverId,
    );
    const capturedFileCount = requestedView === 'walkthrough' || shownComparison?.comparisonId
      ? walkthroughAnalysis?.comparison?.inventory.files.length
      : undefined;
    const scopeOptions = React.useMemo(
      () =>
        listFilesComparisonScopeOptions(
          changedFilesAvailability,
          pickerLatestTurnId,
          shownComparison,
          {
            pendingFileCount: changed.allRepositoryChangedFiles.length,
            latestTurnFileCount: latestTurnChangeSet?.files.length,
            currentFileCount: capturedFileCount,
          },
        ),
      [
        changedFilesAvailability,
        pickerLatestTurnId,
        shownComparison,
        changed.allRepositoryChangedFiles.length,
        latestTurnChangeSet?.files.length,
        capturedFileCount,
      ],
    );
    const scopeLabel = shownComparison
      ? resolveFilesComparisonLabel(shownComparison, pickerLatestTurnId)
      : t('scmComparison.scope.workingTree');
    const reviewView: SessionScmReviewView =
      scmReviewViewUnavailableReason(requestedView, shownComparison) ? 'files' : requestedView;
    // What "This session" spans: since the Session began, over the turns that changed files.
    const sessionCreatedAt = useSession(props.sessionId)?.createdAt ?? null;
    const scopeDetail =
      shownComparison?.kind === 'session'
        ? [
            typeof sessionCreatedAt === 'number' && sessionCreatedAt > 0
              ? t('scmComparison.since', {
                  time: formatAsOfTime(sessionCreatedAt),
                })
              : null,
            (turnChangeSets?.length ?? 0) > 0
              ? t('scmComparison.turnsWithChanges', {
                  count: turnChangeSets.length,
                })
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ') || null
        : null;
    // A review of the comparison on screen (lab WT5-R4): the comparison replaces Change type and Base, and
    // the walkthrough output starts on. Without a working copy to capture from, the general launcher stays.
    const reviewCwd = effectiveSnapshot?.repo.rootPath ?? sessionPath ?? null;
    // The dialog's Changes row says how much the review reads (lab WT5-R4: "start → now · 9 files").
    const shownScopeFileCount = shownComparison
      ? scopeOptions.find((option) => option.comparison !== null
          && scmComparisonKey(option.comparison) === scmComparisonKey(shownComparison))?.fileCount ?? null
      : null;
    const reviewScopeDetail = [
      scopeDetail,
      shownScopeFileCount ? t('scmComparison.fileCount', { count: shownScopeFileCount }) : null,
    ].filter((part): part is string => Boolean(part)).join(' · ') || null;
    useScmReviewActiveFileSelection({ pane, hostKey: JSON.stringify([reviewServerId, accountScope?.accountId, props.sessionId, reviewCwd]),
      activeFileKey: activeReviewFileKey, comparison: shownComparison, view: reviewView, presented: props.active !== false && Boolean(accountScope) });
    const openReviewDialog = React.useCallback(
      (preselectedEngineIds?: readonly string[]) => {
        if (!machineReachable) return;
        if (!shownComparison || !reviewCwd) {
          openDetailsTab(createExecutionRunLauncherDetailsTab('review'), {
            intent: 'preview',
          });
          return;
        }
        presentStartReviewDialog({
          sessionId: props.sessionId,
          serverId: props.serverId ?? null,
          cwd: reviewCwd,
          comparison: shownComparison,
          scopeLabel,
          scopeDetail: reviewScopeDetail,
          defaultWalkthrough: true,
          ...(preselectedEngineIds ? { preselectedEngineIds } : {}),
          onStarted: (started, walkthrough) => {
            setPersistedReviewTabState({
              reviewRunIds: [...started.reviewRunIds],
            });
            if (walkthrough) {
              openDetailsTab(
                createSessionScmReviewDetailsTab({
                  ...props.target,
                  comparison: {
                    ...shownComparison,
                    comparisonId: started.comparisonId,
                  },
                  view: 'walkthrough',
                }),
                { intent: 'pinned' },
              );
            }
            const said = [
              started.notStartedEngineIds.length > 0
                ? t('reviewWalkthrough.started.notStarted', {
                    engines: started.notStartedEngineIds.join(', '),
                  })
                : null,
              started.narrationError
                ? t('reviewWalkthrough.started.narrationFailed')
                : null,
            ].filter((line): line is string => line !== null);
            if (said.length > 0)
              Modal.alert(t('scmComparison.startReview'), said.join('\n'));
          },
        });
      },
      [
        machineReachable,
        openDetailsTab,
        props.serverId,
        props.sessionId,
        props.target,
        reviewCwd,
        reviewScopeDetail,
        scopeLabel,
        setPersistedReviewTabState,
        shownComparison,
      ],
    );
    const openReviewLauncher = React.useCallback(
      () => openReviewDialog(),
      [openReviewDialog],
    );
    // Files and Walkthrough are two views of one comparison: switching keeps the tab, scope and place.
    const selectView = React.useCallback(
      (view: SessionScmReviewView) => {
        openDetailsTab(
          createSessionScmReviewDetailsTab({
            ...props.target,
            ...(shownComparison ? { comparison: shownComparison } : null),
            view,
          }),
          { intent: 'pinned' },
        );
      },
      [openDetailsTab, props.target, shownComparison],
    );
    // The proposal's size labels the Commits view ("Commits 3"); proposing opens that view.
    const commitsCount =
      commitPlan?.outputs?.commitPlan?.value?.groups.length ?? null;
    const proposeCommits =
      pending &&
      reviewView !== 'commits' &&
      !commitPlan?.outputs?.commitPlan ? (
        <ScmComparisonProposeCommits onPress={() => selectView('commits')} />
      ) : null;
    // Files' Explain projects the same walkthrough beside its hunks; it never asks for a second output.
    const marks = useScmReviewedMarks({
      comparison:
        reviewView === 'files'
          ? (walkthroughAnalysis?.comparison ?? null)
          : null,
      serverId: props.serverId ?? null,
      host: { sessionId: props.sessionId },
    });
    const analysisMarkAgentId = resolveExecutionRunAgentMarkId(walkthroughAnalysis?.latestRun?.backendTarget, theme);
    const marksAvailable =
      walkthroughAnalysis?.comparison != null &&
      marks.record !== null &&
      marks.unavailableReason === null;
    const filesReading = React.useMemo(
      () =>
        walkthroughAnalysis?.comparison &&
        walkthroughAnalysis.outputs?.walkthrough?.value
          ? buildWalkthroughReading({
              comparison: walkthroughAnalysis.comparison,
              walkthrough: walkthroughAnalysis.outputs.walkthrough,
              analysis: walkthroughAnalysis.analysis,
              reviewed: marksAvailable ? marks.record : null,
            })
          : null,
      [
        walkthroughAnalysis?.analysis,
        walkthroughAnalysis?.comparison,
        walkthroughAnalysis?.outputs?.walkthrough,
        marksAvailable,
        marks.record,
      ],
    );
    // The comments the Files bar's toggle opens: drawn by Review under that bar, above the files.
    const reviewCommentsPanel = reviewCommentsEnabled && reviewScope ? (
      <ReviewCommentsSessionSurface
        scope={accountScope}
        workspace={{
          machineId: reviewScope.machineId,
          path: reviewScope.rootPath,
        }}
        sessionId={props.sessionId}
        execute={frontDoorActionExecutor}
        directWriteGrants={directWriteGrants}
        pendingDirectWriteGrantRequests={pendingDirectWriteGrantRequests}
        onGrantDirectWrite={pluginPermissionGrants.grant}
        onCancelDirectWriteGrant={pluginPermissionGrants.dismissRequest}
        onRevokeDirectWrite={pluginPermissionGrants.revoke}
        permissionGrantStatus={pluginPermissionGrants.state.status}
        permissionGrantError={pluginPermissionGrants.state.error}
        onRefreshPermissionGrants={() => {
          void pluginPermissionGrants.refresh();
        }}
        header="external"
        open={commentsOpen}
        onUnresolvedCountChange={setCommentsCount}
        testID="review-comments-session"
      />
    ) : null;

    const renderFiles = (comparisonChrome: ScmReviewComparisonChrome) => {
      if (!effectiveSnapshot && !snapshotError) {
        return (
          <SurfaceStateCard
            testID="session-scm-review-loading"
            kind="loading"
            title={t('common.loading')}
          />
        );
      }

      // `F-SCM-3`: the terminal `SourceControlUnavailableState` below was the only place this view
      // reported a snapshot error, and `scmStatusSync` stores an error WITHOUT clearing the snapshot —
      // so once a review had been cached, every later refresh failure was invisible and stale content
      // read as current. Worse here than on the git panes: the `isRepo === false` branch returns
      // BEFORE that guard, so a cached "not under source control" suppressed it twice over. From here
      // on the content is real but possibly stale, so the failure travels WITH it — including into
      // that branch. Mounted unconditionally: the notice owns the "is this stale?" decision and
      // renders nothing when there is no error.
      const staleSnapshotNotice = (
        <SourceControlStaleSnapshotNotice
          testID="session-scm-review-stale"
          error={snapshotError}
          onRetry={() =>
            void scmStatusSync.invalidateFromUser(
              props.sessionId,
              props.serverId,
            )
          }
        />
      );

      if (effectiveSnapshot && effectiveSnapshot.repo.isRepo === false) {
        return (
          <View style={{ flex: 1 }}>
            {staleSnapshotNotice}
            <NotSourceControlRepositoryState />
          </View>
        );
      }

      if (!effectiveSnapshot && snapshotError) {
        return (
          <SourceControlUnavailableState
            details={snapshotError.message}
            errorCode={snapshotError.errorCode}
            onRetry={() =>
              void scmStatusSync.invalidateFromUser(
                props.sessionId,
                props.serverId,
              )
            }
          />
        );
      }

      if (comparisonPresentation.kind === 'unsupported') {
        return (
          <View style={{ flex: 1 }}>
            <SurfaceStateCard
              testID="scm-comparison-unsupported"
              kind="empty"
              iconName="git-diff"
              title={scopeLabel}
              reason={t('scmComparison.unsupportedReason')}
              action={{
                label: t('scmComparison.showPendingChanges'),
                onPress: () => selectComparison({ kind: 'workingTree' }),
              }}
            />
          </View>
        );
      }

      return (
        <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {staleSnapshotNotice}
          <ChangedFilesReview
            comparisonChrome={comparisonChrome}
            detailsHeader={reviewDetailsHeader}
            activeReviewFile={activeReviewFile}
            bottomInsetPx={reviewTrayVisible ? REVIEW_TRAY_RESERVED_PX : 0}
            renderBottomTray={({ yielded }) => (
              <ReviewDraftSummary
                enabled={reviewCommentsEnabled}
                drafts={reviewCommentDrafts}
                yielded={yielded}
                onGoToComposer={goToComposer}
                onDetachDraft={detachDraftFromNextMessage}
                composer={askComposer}
              />
            )}
            theme={theme}
            sessionId={props.sessionId}
            snapshot={effectiveSnapshot ?? null}
            changedFilesViewMode={changedFilesViewMode}
            allRepositoryChangedFiles={changed.allRepositoryChangedFiles}
            turnAttributedFiles={changed.turnAttributedFiles}
            turnAgentReportedFiles={changed.turnAgentReportedFiles}
            turnCheckpointFiles={changed.turnCheckpointFiles}
            turnCheckpointMetadata={changed.turnCheckpointMetadata}
            turnRepositoryOnlyFiles={changed.turnRepositoryOnlyFiles}
            sessionAttributedFiles={changed.sessionAttributedFiles}
            repositoryOnlyFiles={changed.repositoryOnlyFiles}
            maxFiles={maxFiles}
            maxChangedLines={maxChangedLines}
            onFilePress={openFileDefault}
            onFilePressPinned={openFilePinned}
            initialCollapsedPaths={mountedInitialReviewState.collapsedPaths}
            onCollapsedPathsChange={onCollapsedPathsChange}
            initialScrollTop={mountedInitialReviewState.scrollTop}
            onScrollTopChange={onScrollTopChange}
            renderFileActions={renderReviewFileActions}
            renderFileTrailingActions={renderReviewFileTrailingActions}
            rowDensity="compact"
            diffRefreshToken={diffRefreshToken}
            providerDiffByPath={reviewProviderDiffByPath}
            reviewCommentsEnabled={reviewCommentsEnabled}
            reviewCommentDrafts={reviewCommentDrafts}
            onUpsertReviewCommentDraft={
              reviewDraftHandlers.onUpsertReviewCommentDraft
            }
            onDeleteReviewCommentDraft={
              reviewDraftHandlers.onDeleteReviewCommentDraft
            }
            onReviewCommentError={reviewDraftHandlers.onReviewCommentError}
            onLayout={scrollFades.onViewportLayout}
            onContentSizeChange={scrollFades.onContentSizeChange}
            onScroll={scrollFades.onScroll}
          />
          <ScrollEdgeFades
            color={theme.colors.surface.base}
            size={18}
            edges={scrollFades.visibility}
          />
          <ScrollEdgeIndicators
            edges={scrollFades.visibility}
            color={theme.colors.text.secondary}
            size={14}
            opacity={0.35}
          />
        </View>
      );
    };

    return (
      <InputTypePickerHostProvider enabled={props.active !== false} requiresPluginTypes={false} sessionId={props.sessionId} serverId={props.serverId}
        contextKey={JSON.stringify([props.serverId, props.sessionId, reviewScope?.machineId, reviewScope?.rootPath])}>
      <WorkspaceScmReviewBody
        activeReviewFile={activeReviewFile}
        comparison={shownComparison}
        view={reviewView}
        views={pending ? PENDING_COMPARISON_VIEWS : COMPARISON_VIEWS}
        scopeLabel={scopeLabel}
        scopeDetail={scopeDetail}
        scopeOptions={scopeOptions}
        onSelectComparison={selectComparison}
        onSelectView={selectView}
        onClose={props.onRequestClose ?? pane.closeDetails}
        rootPath={effectiveSnapshot?.repo.rootPath}
        reading={filesReading}
        modelLabel={walkthroughAnalysis?.producer?.modelId ? resolveRunNativeModelLabel(
          walkthroughAnalysis.latestRun?.backendTarget ?? walkthroughAnalysis.savedResult?.generator?.backendTarget,
          undefined, walkthroughAnalysis.latestRun?.resolvedSelection ?? walkthroughAnalysis.savedResult?.generator,
        )(walkthroughAnalysis.producer.modelId) ?? walkthroughAnalysis.producer.modelId : undefined}
        analysisMark={analysisMarkAgentId ? <AgentIcon agentId={analysisMarkAgentId} size={ICON_SIZE.xs} /> : null}
        marksAvailable={marksAvailable}
        explain={explain}
        onExplainChange={setExplain}
        commitsCount={commitsCount}
        fileCount={capturedFileCount ?? (effectiveSnapshot ? shownScopeFileCount : null)}
        proposeCommits={proposeCommits}
        onProposeCommits={proposeCommits ? () => selectView('commits') : null}
        onStartReview={openReviewLauncher}
        reviewDisabled={!machineReachable}
        reviewDisabledReason={reviewDisabledReason}
        barMenuSection={commentsMenuSection}
        barPanel={reviewCommentsPanel}
                barActions={reviewCommentsEnabled && (commentsOpen || (commentsCount ?? 0) > 0) ? <ReviewCommentsHeaderButton compact labels={commentsLabels} unresolvedCount={commentsCount}
          expanded={commentsOpen} onPress={toggleComments} testID="review-comments-session-trigger" /> : null}
        renderFiles={renderFiles}
        renderWalkthrough={({ layout, renderBar, onShowFiles }) => (
          <SessionWalkthroughView
            sessionId={props.sessionId}
            serverId={props.serverId}
            {...restoration}
            comparison={shownComparison}
            scopeLabel={scopeLabel}
            scopeDetail={scopeDetail}
            layout={layout}
            active={props.active !== false}
            renderBar={renderBar}
            onShowFiles={onShowFiles}
            onOpenFile={openFile}
            onOpenComposer={goToComposer}
            startedReviewRunIds={startedReviewRunIds}
            onRetryReviewEngines={openReviewDialog}
          />
        )}
        renderCommits={({ layout, renderBar }) => (
          <SessionCommitsView
            sessionId={props.sessionId}
            serverId={props.serverId}
            {...restoration}
            branch={
              effectiveSnapshot?.branch?.detached
                ? null
                : (effectiveSnapshot?.branch?.head ?? null)
            }
            layout={layout === 'phone' ? 'phone' : 'wide'}
            active={props.active !== false}
            focusGroupId={
              typeof persistedReviewTabState?.commitGroupId === 'string'
                ? persistedReviewTabState.commitGroupId
                : null
            }
            onOpenComposer={goToComposer}
            renderBar={renderBar}
          />
        )}
      />
      </InputTypePickerHostProvider>
    );
  },
);
