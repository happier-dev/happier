import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ReviewCommentsSessionSurface } from '@/components/reviews/ReviewCommentsSessionSurface';
import { buildWorkspaceChangedFilesData } from '@/hooks/workspaces/scm/buildWorkspaceChangedFilesData';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { NotSourceControlRepositoryState } from '@/components/workspaces/scm/states/NotSourceControlRepositoryState';
import { SourceControlUnavailableState } from '@/components/workspaces/scm/states/SourceControlUnavailableState';
import { SourceControlStaleSnapshotNotice } from '@/components/workspaces/scm/states/SourceControlStaleSnapshotNotice';
import { useSetting, useWorkspaceRefs, useWorkspaceReviewCommentsDrafts, useWorkspaceScmCommitSelectionPatches, useWorkspaceScmCommitSelectionPaths } from '@/sync/domains/state/storage';
import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { useWorkspaceReviewCommentDraftHandlers } from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceReviewCommentDraftHandlers';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { createPluginPermissionGrantActions } from '@/sync/domains/plugins/permissions/actions';
import { usePluginPermissionGrants } from '@/sync/domains/plugins/permissions/usePluginPermissionGrants';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
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
import { SCM_COMMIT_STRATEGIES, type ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { buildCommitSelectionPathHints, isFileSelectedForCommit } from '@/scm/operations/commitSelectionHints';
import { isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { WorkspaceScmCommitSelectionToggleButton } from '@/components/projects/scm/WorkspaceScmCommitSelectionToggleButton';
import { activeReviewFileKeyForWorkspace } from '@/components/workspaces/scm/review/activeReviewFile';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceScmReviewBody } from '@/components/projects/scm/WorkspaceScmReviewBody';
import { useWorkspaceScmDiffSummaryBinding } from '@/components/projects/scm/useWorkspaceScmDiffSummaryBinding';
import { ScmWalkthroughView } from '@/components/sessions/files/walkthrough/ScmWalkthroughView';
import { useCapturedScmComparison } from '@/components/sessions/files/comparison/useCapturedScmComparison';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { buildWalkthroughReading } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { useWalkthroughReviewedMarks } from '@/components/sessions/files/walkthrough/useWalkthroughReviewedMarks';
import type { SessionScmReviewComparison, SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import type { ScmComparison, ScmDiffSummaryResult } from '@happier-dev/protocol/scm';
import type { WalkthroughStop } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { captureScmComparisonForSession } from '@/sync/ops/scmDiffSummary/generate';
import { scmComparisonSourceOf } from '@/sync/domains/scm/diffSummary/selection';
import { Modal } from '@/modal';

/** A project's Review is a Details tab too: the shared Review header and its file list first. */
const WORKSPACE_REVIEW_DETAILS_HEADER = Object.freeze({});

export type WorkspaceScmReviewDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
    comparison?: SessionScmReviewComparison;
    view?: SessionScmReviewView;
    explain?: boolean;
    onSelectTarget?: (target: Readonly<{ comparison: SessionScmReviewComparison; view: SessionScmReviewView; explain: boolean }>) => void;
    onAsk?: (input: Readonly<{ comparison: ScmComparison; result: ScmDiffSummaryResult | null; stop: WalkthroughStop; isCurrent: () => boolean }>) => void;
    onExplain?: (input: Readonly<{ comparison: ScmComparison; result: ScmDiffSummaryResult | null; isCurrent: () => boolean }>) => void;
}>;

export const WorkspaceScmReviewDetailsView = React.memo((props: WorkspaceScmReviewDetailsViewProps) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const { mountedInitialReviewState, onScrollTopChange, onCollapsedPathsChange } = useScmReviewTabState(
        JSON.stringify([props.serverId, props.machineId, props.rootPath]), pane);
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
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations') === true;
    const reviewCommentDrafts = useWorkspaceReviewCommentsDrafts(scope);
    const reviewDraftHandlers = useWorkspaceReviewCommentDraftHandlers(scope);
    const { snapshot, loading, error, refresh } = useWorkspaceScmSnapshotController(scope);
    const [localTarget, setLocalTarget] = React.useState<Readonly<{ comparison: SessionScmReviewComparison; view: SessionScmReviewView; explain: boolean }>>({
        comparison: props.comparison ?? { kind: 'workingTree' }, view: props.view ?? 'files', explain: props.explain === true,
    });
    const comparison = props.onSelectTarget ? props.comparison ?? localTarget.comparison : localTarget.comparison;
    const view = props.onSelectTarget ? props.view ?? localTarget.view : localTarget.view;
    const explain = props.onSelectTarget ? props.explain ?? localTarget.explain : localTarget.explain;
    const selectTarget = (patch: Partial<typeof localTarget>) => {
        const next = { comparison, view, explain, ...patch };
        if (next.comparison.kind === 'session' || next.comparison.kind === 'turnCheckpoint') return;
        setLocalTarget(next);
        props.onSelectTarget?.(next);
    };
    const bound = useWorkspaceScmDiffSummaryBinding({ ...scope, comparison, output: 'walkthrough' });
    const readingIdentity = JSON.stringify([bound.capturedComparison?.id, bound.viewModel?.resultId, bound.viewModel?.revision]);
    const currentReadingIdentity = React.useRef(readingIdentity);
    currentReadingIdentity.current = readingIdentity;
    const readingIsCurrent = React.useCallback(() => bound.isCurrent() && currentReadingIdentity.current === readingIdentity,
        [bound.isCurrent, readingIdentity]);
    const frontDoorActionExecutor = React.useMemo(() => {
        const execute = createFrontDoorUiActionExecutor(undefined, bound.scope ? {
            serverId: bound.scope.serverId, expectedAccountId: bound.scope.accountId,
        } : undefined);
        return ((...args: Parameters<typeof execute>) => {
            if (!bound.isCurrent()) return Promise.reject(new Error('action_account_scope_unavailable'));
            return execute(...args);
        });
    }, [bound.isCurrent, bound.scope?.serverId, bound.scope?.accountId]);
    const pluginPermissionGrantActions = React.useMemo(
        () => createPluginPermissionGrantActions({ execute: frontDoorActionExecutor }), [frontDoorActionExecutor]);
    const capture = useCapturedScmComparison({ host: { machineId: props.machineId }, machine: bound.machine,
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
    const explainFiles = async () => {
        if (!props.onExplain || !bound.scope || !bound.machine || !displayedIsCurrent()) return;
        if (displayedComparison) {
            props.onExplain({ comparison: displayedComparison, result: displayedResult, isCurrent: displayedIsCurrent });
            return;
        }
        // An ordinary draft from live Files needs an actual immutable reading,
        // not a saved walkthrough or a fabricated snapshot comparison.
        try {
            const result = await captureScmComparisonForSession({ machineId: props.machineId,
                scope: bound.scope, shouldContinue: displayedIsCurrent,
                input: { cwd: props.rootPath, source: scmComparisonSourceOf(comparison, ''),
                    ...(comparison.comparisonId ? { comparisonId: comparison.comparisonId } : {}) } });
            if (!displayedIsCurrent()) return;
            if (result.success) props.onExplain({ comparison: result.comparison, result: null, isCurrent: displayedIsCurrent });
            else Modal.alert(t('common.error'), t('common.unavailable'));
        } catch {
            if (displayedIsCurrent()) Modal.alert(t('common.error'), t('common.unavailable'));
        }
    };
    const marks = useWalkthroughReviewedMarks({ comparison: bound.capturedComparison, serverId: props.serverId });
    const reading = React.useMemo(() => bound.capturedComparison ? buildWalkthroughReading({ comparison: bound.capturedComparison,
        walkthrough: bound.viewModel?.outputs?.walkthrough ?? null, analysis: bound.viewModel?.analysis ?? null,
        reviewed: marks.record, provenance: bound.viewModel?.savedResult?.walkthroughProvenance }) : null,
        [bound.capturedComparison, bound.viewModel?.outputs?.walkthrough, bound.viewModel?.analysis, bound.viewModel?.savedResult?.walkthroughProvenance, marks.record]);
    const scopeLabel = resolveFilesComparisonLabel(comparison, null);
    const scopeOptions = listFilesComparisonScopeOptions({ showTurnViewToggle: false, showTurnAgentReportedViewToggle: false,
        showTurnCheckpointViewToggle: false, showSessionViewToggle: false }, null, comparison,
        { pendingFileCount: snapshot?.entries.length }).filter((option) => option.sourceKind !== 'session' && option.sourceKind !== 'turnCheckpoint');
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

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface.base }}>
            {reviewCommentsEnabled ? (
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
                    defaultPanelOpen={false}
                    testID="workspace-review-comments"
                />
            ) : null}
            {snapshot ? <SourceControlStaleSnapshotNotice error={error} onRetry={() => { void refresh(); }} testID="workspace-review-stale" /> : null}
            <WorkspaceScmReviewBody activeReviewFile={activeReviewFile} comparison={comparison} view={view} scopeLabel={scopeLabel} scopeDetail={props.rootPath}
                filesState={comparison.kind === 'workingTree' && !comparison.comparisonId
                    ? loading && !snapshot ? <PaneLoadingFallback />
                        : error && !snapshot ? <SourceControlUnavailableState details={error.message} errorCode={error.errorCode} onRetry={() => { void refresh(); }} />
                            : snapshot?.repo.isRepo === false ? <NotSourceControlRepositoryState /> : null
                    : !capture.comparison ? capture.loading ? <PaneLoadingFallback />
                        : <SourceControlUnavailableState details={capture.error ?? t('scmComparison.unsupportedReason')} onRetry={capture.retry} /> : null}
                scopeOptions={scopeOptions} onSelectComparison={(next) => selectTarget({ comparison: next })}
                onSelectView={(next) => selectTarget({ view: next })} rootPath={props.rootPath}
                fileCount={capture.comparison?.inventory.files.length ?? changedFiles.allRepositoryChangedFiles.length}
                reading={reading} marksAvailable={marks.unavailableReason === null && marks.record !== null}
                modelLabel={bound.viewModel?.producer?.modelId} explain={explain} onExplainChange={(next) => selectTarget({ explain: next })}
                onExplainDraft={props.onExplain && bound.scope && bound.machine && comparison.kind !== 'session' && comparison.kind !== 'turnCheckpoint'
                    ? () => { void explainFiles(); } : undefined}
                renderWalkthrough={({ layout, renderBar, onShowFiles }) => <View testID="workspace-walkthrough" style={{ flex: 1, minHeight: 0 }}>
                    <ScmWalkthroughView bound={bound} displayMachineId={props.machineId} serverId={props.serverId}
                        comparison={comparison} scopeLabel={scopeLabel} scopeDetail={props.rootPath} layout={layout}
                        renderBar={renderBar} onShowFiles={onShowFiles} onOpenFile={(path) => props.onOpenFile?.(path)}
                        onAskStop={props.onAsk && bound.capturedComparison ? (stop) => {
                            if (!readingIsCurrent() || !bound.capturedComparison) return;
                            props.onAsk?.({ comparison: bound.capturedComparison, result: bound.viewModel?.savedResult ?? null, stop, isCurrent: readingIsCurrent });
                        } : undefined} />
                </View>}
                renderFiles={(comparisonChrome) => comparison.kind !== 'workingTree' || comparison.comparisonId
                    ? capture.comparison ? <CapturedComparisonFilesView activeReviewFile={activeReviewFile} comparison={capture.comparison} reviewScopeKey={activeReviewFileKey}
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
                turnAttributedFiles={[]}
                turnRepositoryOnlyFiles={[]}
                sessionAttributedFiles={[]}
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
                fetchUnifiedDiffForPath={fetchUnifiedDiffForPath}
                comparisonChrome={comparisonChrome}
                initialScrollTop={mountedInitialReviewState.scrollTop} onScrollTopChange={onScrollTopChange}
                initialCollapsedPaths={mountedInitialReviewState.collapsedPaths} onCollapsedPathsChange={onCollapsedPathsChange}
            />} />
        </View>
    );
});
